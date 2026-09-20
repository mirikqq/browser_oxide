//! A network runtime that V8 cannot block.
//!
//! The engine drives V8 and its async work on one `new_current_thread`
//! runtime, on the thread V8 itself runs on. That is fine until a page
//! executes a long synchronous script: V8 does not yield, so the runtime
//! is never polled, and every in-flight socket sits untouched for as long
//! as the script runs. Measured on this engine: a `fetch()` issued
//! immediately before a 4 s busy-loop made *zero* progress during those
//! 4 s and then completed in its usual ~370 ms once the thread was free.
//!
//! For short scripts that is only latency. For a long one — hCaptcha's
//! `hsw.js` proof-of-work is the case that surfaced this — a TLS
//! handshake opened just before it stalls past the OS connect timeout and
//! fails with a raw `Operation timed out (os error 60)`, which no real
//! browser produces: Chrome's network stack lives on its own threads and
//! is never held up by script execution.
//!
//! [`spawn_net`] moves the socket work onto a small dedicated
//! multi-threaded runtime and awaits the join handle from the caller's
//! runtime. The transfer then completes on its own threads; the JS-side
//! promise still resolves only when V8 is free to run it (as in a real
//! browser), but the connection itself no longer rots while it waits.
//!
//! The same shape already exists in-tree for the synchronous fetch path
//! (`op_net_fetch_sync` spawns a thread with its own runtime); this is
//! that idea as one shared runtime rather than a thread per call.

use std::future::Future;
use std::sync::OnceLock;

use tokio::runtime::{Builder, Runtime};

/// Worker threads for network I/O. Sockets are almost entirely waiting on
/// the kernel, so this needs to cover concurrency, not compute — a page's
/// sub-resource burst is dozens of *concurrent* transfers, but only a
/// handful of wakeups at a time.
const NET_WORKER_THREADS: usize = 4;

fn runtime() -> Option<&'static Runtime> {
    static RUNTIME: OnceLock<Option<Runtime>> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            Builder::new_multi_thread()
                .worker_threads(NET_WORKER_THREADS)
                .thread_name("browser-oxide-net")
                .enable_all()
                .build()
                .map_err(|e| {
                    // Falling back to the caller's runtime is worse than
                    // this fix, but strictly better than failing the
                    // request outright.
                    tracing::warn!(error = %e, "network runtime unavailable; running inline");
                })
                .ok()
        })
        .as_ref()
}

/// Either a task already running on the network runtime, or the original
/// future to be awaited inline if that runtime could not be built.
enum Handoff<F: Future> {
    Remote(tokio::task::JoinHandle<F::Output>),
    Inline(F),
}

/// Hand `fut` to the network runtime and return a future for its result.
///
/// Deliberately **not** an `async fn`: the work has to start when this is
/// called, not when the returned future is first polled. An `async fn`
/// body does nothing until polled, so a caller that spawns and then blocks
/// its thread — precisely the case this module exists for — would leave
/// the request sitting unstarted.
///
/// Falls back to awaiting `fut` inline when the dedicated runtime could
/// not be built, so that failure degrades to the previous behaviour rather
/// than breaking the request.
pub fn spawn_net<F>(fut: F) -> impl Future<Output = F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let handoff = match runtime() {
        Some(rt) => Handoff::Remote(rt.spawn(fut)),
        None => Handoff::Inline(fut),
    };
    async move {
        match handoff {
            Handoff::Remote(handle) => match handle.await {
                Ok(output) => output,
                // The task panicked. Re-raise here so the failure surfaces
                // the way it would have without the hop, instead of being
                // swallowed into a network error.
                Err(join_err) => std::panic::resume_unwind(join_err.into_panic()),
            },
            Handoff::Inline(fut) => fut.await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// The point of the module: work handed to `spawn_net` progresses
    /// while the calling thread is blocked, which is exactly what a
    /// synchronous script does to the V8 thread.
    #[tokio::test(flavor = "current_thread")]
    async fn work_progresses_while_the_calling_thread_blocks() {
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = spawn_net(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            tx.send(Instant::now()).ok();
            "done"
        });

        // Block this thread the way a long synchronous script does. On the
        // caller's single-threaded runtime nothing would advance here.
        let spin_until = Instant::now() + Duration::from_millis(500);
        while Instant::now() < spin_until {
            std::hint::spin_loop();
        }
        let finished_at = rx
            .try_recv()
            .expect("network task must finish while the caller is blocked");
        assert!(
            finished_at < spin_until,
            "task finished only after the block was released"
        );
        assert_eq!(handle.await, "done");
    }
}
