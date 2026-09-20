//! Humanized `performance.now()`.
//!
//! Real Chrome 130 quantizes `performance.now()` to 100 µs (or 5 µs with
//! cross-origin isolation), but the resolution is not the whole story —
//! the **jitter shape** across many calls in a tight loop also differs
//! from a software clock. Real hardware shows ~10–30 µs gaussian-ish
//! noise around the quantized step from kernel scheduling, TSC drift, and
//! V8's own quantization-with-noise applied on top of `CLOCK_MONOTONIC`.
//!
//! Pure software clocks return a perfect 100 µs grid with one distinct
//! step value — `set(diffs).size === 1`, which a real browser never shows.
//!
//! Distribution (per Schwarz et al. "Drawn Apart" 2021 + Jin 2024 measurements
//! on Chromium 124 stable):
//!   q       = floor(now_us / 100) * 100              // 100 µs grid
//!   jitter  ~ LogNormal(μ = ln 8 µs, σ = 0.4)        // clamped [0, 35] µs
//!   spike   = with prob 1/1024, sample Exp(λ=1/200 µs) clamped ≤ 1500 µs
//!   result  = (q + jitter + spike) ms

use crate::js_runtime::state::DomState;
use deno_core::op2;
use deno_core::v8;
use deno_core::OpState;
use std::time::Instant;

/// Per-runtime state for the humanized clock.
pub struct PerfState {
    /// Process-relative origin; `performance.now()` returns ms since this
    /// instant (matches DOM HighResolutionTime contract for the document).
    origin: Instant,
    /// Wall-clock (UNIX epoch ms) corresponding to `origin`. Read by
    /// `op_perf_time_origin_ms` so JS `performance.timeOrigin` honors the
    /// invariant `timeOrigin + performance.now() ≈ Date.now()`. Real
    /// Chrome maintains this invariant; without it, an earlier JS-side
    /// ad-hoc computation (`Date.now() - <hardcoded nav_end>`) produced a
    /// detectable skew between `performance.timeOrigin + performance.now()`
    /// and `Date.now()`.
    origin_unix_ms: f64,
    /// Last returned value in µs — enforces monotonicity per HRT spec.
    last_us: f64,
}

impl PerfState {
    pub fn new() -> Self {
        Self::with_seed(0xCAFEF00DDEADBEEF)
    }
    /// `seed` is kept for call-site compatibility; the clock no longer draws
    /// random numbers — Chrome's readings are deterministic grid points.
    pub fn with_seed(_seed: u64) -> Self {
        let origin_unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        Self {
            origin: Instant::now(),
            origin_unix_ms,
            last_us: 0.0,
        }
    }

    /// Elapsed ms since origin, shaped the way Chrome reports it.
    ///
    /// Measured against Chrome 151: every reading sits on the 100 µs grid,
    /// carrying only a ~5e-8 ms residual from double arithmetic — the long
    /// tails in values like `383007.7999999523` are that, not noise.
    ///
    /// This used to add a log-normal jitter of up to 35 µs plus rare spikes on
    /// top of the quantum, putting readings 5–12 µs off the grid — five orders
    /// of magnitude coarser than Chrome's residual, and checkable with one
    /// modulo. Event timestamps derive from this clock, so every
    /// `event.timeStamp` Talon collected carried the signature.
    ///
    /// Monotonicity is kept per the HRT spec: the result never steps backward.
    pub fn now_ms(&mut self) -> f64 {
        let raw_us = self.origin.elapsed().as_nanos() as f64 / 1000.0;
        let q = (raw_us / 100.0).floor() * 100.0;
        let value = q.max(self.last_us);
        self.last_us = value;
        value / 1000.0
    }
}

impl Default for PerfState {
    fn default() -> Self {
        Self::new()
    }
}

#[op2(fast)]
pub fn op_perf_now_humanized(s: &mut OpState) -> f64 {
    let s = s.borrow_mut::<PerfState>();
    s.now_ms()
}

/// Returns the UNIX-epoch ms corresponding to `PerfState.origin` (the
/// process-relative t=0 for `performance.now()`). JS uses this as the
/// `performance.timeOrigin` value so the standard Web Platform invariant
/// `timeOrigin + performance.now() ≈ Date.now()` holds.
#[op2(fast)]
pub fn op_perf_time_origin_ms(s: &mut OpState) -> f64 {
    let s = s.borrow::<PerfState>();
    s.origin_unix_ms
}

#[derive(serde::Serialize)]
pub struct JsResourceTiming {
    pub name: String,
    pub entry_type: String,
    pub start_time: f64,
    pub duration: f64,
    pub fetch_start: f64,
    pub domain_lookup_start: f64,
    pub domain_lookup_end: f64,
    pub connect_start: f64,
    pub connect_end: f64,
    pub secure_connection_start: f64,
    pub request_start: f64,
    pub response_start: f64,
    pub response_end: f64,
    pub transfer_size: u64,
    pub encoded_body_size: u64,
    pub decoded_body_size: u64,
}

#[op2]
#[serde]
pub fn op_perf_get_resource_timings(state: &mut OpState) -> Vec<JsResourceTiming> {
    let state = state.borrow::<DomState>();
    state
        .resource_timings
        .iter()
        .map(|(url, decoded_size, t)| JsResourceTiming {
            name: url.clone(),
            entry_type: "resource".to_string(),
            start_time: t.request_start_ms,
            duration: t.response_end_ms - t.request_start_ms,
            fetch_start: t.request_start_ms,
            domain_lookup_start: t.dns_start_ms,
            domain_lookup_end: t.dns_end_ms,
            connect_start: t.connect_start_ms,
            connect_end: t.connect_end_ms,
            secure_connection_start: t.tls_start_ms,
            request_start: t.request_start_ms,
            response_start: t.response_start_ms,
            response_end: t.response_end_ms,
            // The compressed on-wire byte count isn't tracked separately
            // from the decoded body (the HTTP client decompresses
            // in-place) — `transfer_size`/`encoded_body_size` stay at 0
            // rather than guess a compression ratio. `decoded_body_size`
            // is real: the actual decoded response body length.
            transfer_size: 0,
            encoded_body_size: 0,
            decoded_body_size: *decoded_size,
        })
        .collect()
}

/// V8's real heap totals, for `performance.memory`.
///
/// Measured against Chrome 151: the values are byte-precise (never a round
/// multiple), stable across rapid reads, and grow as the page allocates. The
/// previous implementation returned a value bucketed to 100 KB on the belief
/// that Chrome quantizes it — Chrome does not, so every reading we produced was
/// divisible by 100000, which no real Chrome ever reports.
///
/// Returns `[total, used]`; the caller pairs them with the profile's limit.
#[op2]
#[serde]
pub fn op_perf_heap_stats(scope: &mut v8::PinScope) -> (f64, f64) {
    let stats = scope.get_heap_statistics();
    (
        stats.total_heap_size() as f64,
        stats.used_heap_size() as f64,
    )
}

deno_core::extension!(
    perf_extension,
    ops = [
        op_perf_now_humanized,
        op_perf_get_resource_timings,
        op_perf_time_origin_ms,
        op_perf_heap_stats,
    ],
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readings_sit_on_chromes_hundred_microsecond_grid() {
        // Measured on Chrome 153: 500 hot calls return ONE value, exactly on
        // the 100 µs grid (`performance.now() * 1000 % 100 === 0`, span 0 µs).
        // This test used to demand >10 distinct values on the belief that a
        // real browser jitters around the quantum — it does not, and adding
        // that jitter is what made every `event.timeStamp` we produced
        // off-grid. What has to hold is the grid itself plus monotonicity.
        let mut s = PerfState::with_seed(7);
        let samples: Vec<f64> = (0..500).map(|_| s.now_ms()).collect();
        for v in &samples {
            let us = v * 1000.0;
            assert!(
                (us / 100.0 - (us / 100.0).round()).abs() < 1e-6,
                "reading off the 100 µs grid: {v}"
            );
        }
        assert!(
            samples.windows(2).all(|w| w[1] >= w[0]),
            "readings must never step backward"
        );
    }
}
