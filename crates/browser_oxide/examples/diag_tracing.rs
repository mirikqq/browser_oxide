//! Same navigation as `thin_probe`, but with a `tracing` subscriber installed so the
//! library's `tracing::warn!` diagnostics (script prefetch failures, module eval errors)
//! are visible. Without a subscriber those events are silently dropped.
//!
//!   RUST_LOG=browser_oxide=debug cargo run --release -p browser_oxide --example diag_tracing -- <url>

#[tokio::main(flavor = "current_thread")]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("browser_oxide=debug")),
        )
        .with_target(true)
        .init();

    let url = std::env::args().nth(1).expect("usage: diag_tracing <url>");
    let profile = browser_oxide::stealth::presets::chrome_148_macos();

    let local = tokio::task::LocalSet::new();
    local
        .run_until(async move {
            // INIT runs before page scripts, so an error hook installed here sees stacks the
            // console capture drops.
            let init: Vec<String> = std::env::var("INIT").ok().into_iter().collect();
            match browser_oxide::Page::navigate_with_init(&url, profile.clone(), 3, init).await {
                Ok(mut page) => {
                    let body = page.content();
                    let ec = browser_oxide::engine_classify(&body);
                    println!("\n== tag={} len={} ==", ec.tag, ec.len);
                    if let Ok(expr) = std::env::var("EVAL") {
                        match page.evaluate(&expr) {
                            Ok(v) => println!("EVAL -> {v}"),
                            Err(e) => println!("EVAL error: {e}"),
                        }
                    }
                    // EVAL2 runs after the event loop has been driven, so async
                    // callbacks (observers, timers, promises) get a chance to fire.
                    if let Ok(expr2) = std::env::var("EVAL2") {
                        let secs = std::env::var("EVAL2_WAIT_S")
                            .ok()
                            .and_then(|s| s.parse().ok())
                            .unwrap_or(5);
                        match page
                            .evaluate_async("void 0", std::time::Duration::from_secs(secs))
                            .await
                        {
                            Ok(reason) => println!("(event loop drained: {reason:?})"),
                            Err(e) => println!("(event loop error: {e})"),
                        }
                        // Challenge iframes are injected by script after the click, so
                        // they miss navigation-time materialization entirely.
                        if let Some(n) = page.materialize_new_iframes().await {
                            println!("(материализовано iframe: {n})");
                        }
                        // Which frames actually came up, and did each get the bridge?
                        for i in 0..page.child_iframe_count() {
                            let node = page.child_iframe(i).map(|c| c.node_id.to_raw());
                            if let Some(child) = page.child_iframe(i) {
                                let url = child
                                    .evaluate("String(location.href)")
                                    .unwrap_or_else(|e| format!("<{e}>"));
                                let bridged = child
                                    .evaluate(
                                        "(function(){try{return String(parent!==globalThis)}\
                                         catch(e){return 'err:'+e.message}})()",
                                    )
                                    .unwrap_or_else(|e| format!("<{e}>"));
                                let listeners = child
                                    .evaluate("String(typeof globalThis.onmessage)")
                                    .unwrap_or_default();
                                println!(
                                    "  фрейм[{i}] node={node:?} url={} мост={bridged} onmessage={listeners}",
                                    url.chars().take(60).collect::<String>()
                                );
                            }
                        }
                        // A handshake needs several hops; one pump only moves what is
                        // already queued, so drive and pump repeatedly.
                        for _ in 0..6 {
                            let (down, up) = page.pump_iframe_messages();
                            if down > 0 || up > 0 {
                                println!("(сообщения: вниз {down}, вверх {up})");
                            }
                            let _ = page
                                .evaluate_async("void 0", std::time::Duration::from_millis(400))
                                .await;
                        }
                        let _ = page
                            .evaluate_async("void 0", std::time::Duration::from_secs(secs))
                            .await;
                        match page.evaluate(&expr2) {
                            Ok(v) => println!("EVAL2 -> {v}"),
                            Err(e) => println!("EVAL2 error: {e}"),
                        }
                    }
                    if std::env::var("SHOW_CONSOLE").is_ok() {
                        println!("--- console ---");
                        page.consume_and_print_logs();
                    }
                }
                Err(e) => println!("\n== navigate error: {e} =="),
            }
        })
        .await;
}
