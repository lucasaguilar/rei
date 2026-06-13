/**
 * @fileoverview Plan Integration Contract — the stable firewall between the
 * Multi-Agent A2A + OTel plan and the hardware-aware Orchestration plan.
 *
 * DEPENDENCY RULE (Dependency Inversion): this module imports NOTHING from rei —
 * no `agent.ts`, no generators, no entry points. rei modules import the contract;
 * never the reverse. Everything behind this firewall (telemetry, A2A client/server,
 * lock, queue) builds and unit-tests in isolation, independent of rei's evolving
 * core, against a mock `RunTask`.
 *
 * Owned jointly by:
 *   - docs/features/Multi-Agent A2A + OTel for rei - v6.md
 *   - docs/features/rei-plan-orchestration.md
 * See docs/features/plan-integration-contract.md and
 *     docs/adr/0003-plan-integration-contract.md.
 *
 * @module rei/contracts/execution-contract
 */

// ── Cross-boundary metadata (rides A2A Message.metadata, beside W3C traceparent) ──

/** Metadata propagated across an A2A delegation. Owner: A2A plan. */
export interface A2AMeta {
  /** W3C trace context for cross-agent trace stitching. */
  traceparent?: string;
  /** Delegation hop count; a Node refuses to delegate past DEFAULT_MAX_DELEGATION_DEPTH. */
  "a2a.depth"?: number;
}

/** Default cap on delegation depth (refuse-and-degrade past this). */
export const DEFAULT_MAX_DELEGATION_DEPTH = 3;

/** Canonical metadata keys — use these literals when reading/writing carriers. */
export const A2A_META_KEYS = {
  traceparent: "traceparent",
  depth: "a2a.depth",
} as const;

// ── The execution seam: what a Node runs, however it is implemented ──

export interface RunTaskRequest {
  /** The instruction to execute. */
  prompt: string;
  /** Absolute workspace path the task operates in. */
  workspacePath: string;
  /** Cross-boundary metadata (trace context, delegation depth). */
  meta: A2AMeta;
}

export interface RunTaskResult {
  /** The task's final textual result. */
  text: string;
}

/**
 * The single execution entry point of a Node. Phase-1 implementation = a plain
 * Agent Turn; the `/auto` implementation = the Orchestrator Engine. Callers
 * (interactive, A2A-inbound, scheduled) never know or care which.
 *
 * Owner of the IMPLEMENTATION: Orchestration plan. CONSUMERS: A2A server, daemon,
 * interactive entry points.
 */
export type RunTask = (
  req: RunTaskRequest,
  signal: AbortSignal,
) => Promise<RunTaskResult>;

// ── Node-wide serialization (ADR 0002) ──

/**
 * One per Node. Guards ALL heavy-model execution so two runs never overlap.
 * Phase-1 impl = in-process async mutex; later = the model-lifecycle lock.
 * `acquire` resolves with a release function. Owner: Orchestration plan.
 */
export interface ExecutionLock {
  acquire(signal: AbortSignal): Promise<() => void>;
}

// ── Persistent work queue (ADR 0001 / 0002) ──

export type QueuedTaskState =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "suspended";

export interface QueuedTask {
  id: string;
  request: RunTaskRequest;
  /** ISO timestamp. */
  enqueuedAt: string;
  state: QueuedTaskState;
  attempts: number;
  /** Opaque resumable orchestration state. Shape owned by the Orchestration plan. */
  resumable?: unknown;
}

/**
 * One per Node, drained by a SINGLE Worker. Phase-1 impl = minimal (in-memory +
 * simple disk); later = the daemon's persistent, crash-resumable queue.
 * Owner: Orchestration plan. A2A-inbound long tasks are PRODUCERS into it.
 */
export interface TaskQueue {
  enqueue(item: QueuedTask): void;
  /** Atomically claim the next queued item and mark it "running". */
  claimNext(): QueuedTask | null;
  complete(id: string, state: QueuedTaskState): void;
  pending(): QueuedTask[];
}

// ── Optional model-lifecycle (Orchestration plan); decorator MUST forward these ──

/**
 * Optional capability a ModelProvider MAY implement. The `withTelemetry` provider
 * decorator MUST forward these (and SHOULD emit a `model-swap` span) — otherwise
 * model swapping silently breaks (incompatibility C6). Owner: Orchestration plan.
 */
export interface ModelLifecycle {
  loadModel(model: string): Promise<void>;
  unloadModel(model: string): Promise<void>;
  /** Polls the real loaded-model endpoint — NOT the 200 returned by unload. */
  isModelLoaded(model: string): Promise<boolean>;
}

// ── A2A Node discovery config (shape lives here; ReiConfig imports it) ──

/** label → base URL of a reachable A2A Node. Owner: A2A plan. */
export type A2ANodeMap = Record<string, string>;

// ── Observability taxonomy (NORMATIVE — keeps the unified trace consistent) ──

/**
 * Canonical span names. Both plans MUST use these so a single Laminar trace nests
 * cleanly: Orchestration → MacroStage → MicroTask → Turn → Step → leaf spans.
 * (Indices like step number / stage number are ATTRIBUTES, not part of the name.)
 */
export const SpanName = {
  // Orchestration plan
  orchestration: "rei.orchestration",
  macroStage: "macro-stage",
  microTask: "micro-task",
  astValidate: "ast-validate",
  gitCheckpoint: "git-checkpoint",
  modelSwap: "model-swap",
  cooling: "cooling",
  // A2A + OTel plan
  turn: "rei.turn",
  step: "step",
  llmCall: "llm-call",
  tool: "tool",
  delegate: "delegate",
} as const;
export type SpanName = (typeof SpanName)[keyof typeof SpanName];

/** Canonical span attribute keys. */
export const SpanAttr = {
  reiMode: "rei.mode",
  reiProvider: "rei.provider",
  reiCorrelationId: "rei.correlation_id",
  reiWorkspace: "rei.workspace",
  stepNumber: "step.number",
  stageNumber: "stage.number",
  toolName: "tool.name",
  a2aTargetNode: "a2a.target_node",
  a2aDepth: "a2a.depth",
  llmProvider: "llm.provider",
  llmModel: "llm.model",
} as const;
export type SpanAttr = (typeof SpanAttr)[keyof typeof SpanAttr];
