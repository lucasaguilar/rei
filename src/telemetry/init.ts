/**
 * @fileoverview IP-1 Telemetry bootstrap (Multi-Agent A2A + OTel plan).
 *
 * Initializes tracing via the Laminar SDK directly — Laminar wraps OpenTelemetry
 * and exports straight to the Laminar UI used in the demo (plan §13). `disableBatch:
 * true` makes Laminar use a `SimpleSpanProcessor` under the hood, honoring the locked
 * "SimpleSpanProcessor for the demo" decision (plan §3).
 *
 * Call `initTelemetry()` as the first thing in each entry point (plan IP-1, "first
 * import"). Manual spans are emitted via the `observe`-based helpers in `./spans.ts`.
 *
 * @module rei/telemetry/init
 */

import { Laminar } from "@lmnr-ai/lmnr";

let initialized = false;

/** Whether Laminar has been successfully initialized. */
export function isTelemetryInitialized(): boolean {
  return initialized;
}

/** Reset internal state — used by tests to re-initialize between runs. */
export function resetTelemetry(): void {
  initialized = false;
}

/**
 * Bootstrap Laminar tracing. Idempotent — safe to call from multiple entry points.
 * If `LMNR_PROJECT_API_KEY` is absent, telemetry is disabled (warn + no-op) so rei
 * still runs normally without a Laminar backend.
 *
 * Respects `REI_TELEMETRY_DISABLED=true` to skip initialization entirely (useful when
 * Laminar is not installed locally and its import-time warnings are undesirable).
 */
export function initTelemetry(): void {
  if (initialized) return;

  // Explicit opt-out: skip Laminar entirely, no imports, no warnings.
  if (process.env.REI_TELEMETRY_DISABLED === "true") {
    return;
  }

  const projectApiKey = process.env.LMNR_PROJECT_API_KEY;
  if (!projectApiKey) {
    console.warn(
      "[telemetry] LMNR_PROJECT_API_KEY not set — telemetry disabled.",
    );
    return;
  }

  Laminar.initialize({
    projectApiKey,
    baseUrl: process.env.LMNR_BASE_URL ?? "http://localhost",
    httpPort: Number(process.env.LMNR_HTTP_PORT ?? 8000),
    grpcPort: Number(process.env.LMNR_GRPC_PORT ?? 8001),
    disableBatch: true, // ⇒ SimpleSpanProcessor under the hood (plan §3)
    // Disable Laminar's automatic SDK/fetch instrumentation: rei's telemetry is fully
    // manual (IP-1/IP-4, `observe`-based spans). Without this, Laminar auto-instruments the
    // model HTTP calls and emits a duplicate model-named span next to each manual `llm-call`.
    instrumentModules: {},
  });
  initialized = true;
}

/** Flush and tear down tracing on process exit. No-op if never initialized. */
export async function shutdownTelemetry(): Promise<void> {
  if (!initialized) return;
  await Laminar.shutdown();
  initialized = false;
}
