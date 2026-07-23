import { confirm, select, text, isCancel } from "@clack/prompts";

/**
 * The elicitation primitive: REI's ability to ask the user a question mid-turn. It is deliberately
 * FRONTEND-AGNOSTIC because REI runs both as a CLI and as a server — core code emits an
 * `Elicitation` and calls an injected `ElicitFn`; the active frontend renders it (CLI via
 * @clack/prompts, server over its protocol, non-interactive via the safe default). This is the
 * shared foundation behind the intent-router's confirm-gate, the `ask_user` tool, and detour
 * confirms. See docs/intent-router-spec.md.
 */

export interface ElicitOption {
  value: string;
  label: string;
}

export interface Elicitation {
  /** Correlates the request with its response (and, when relevant, with agent-flow.jsonl). */
  id: string;
  /** "confirm" = yes/no; "select" = pick one of `options`; "text" = free-form answer. */
  kind: "confirm" | "select" | "text";
  message: string;
  /** Choices for a "select". Ignored for "confirm". */
  options?: ElicitOption[];
  /** Resolved value when there is no interactive frontend (server without a client, one-shot,
   *  no TTY) or the user cancels. Callers MUST set this to the SAFE choice (e.g. decline an
   *  escalation) so unattended runs never take a risky path. For "confirm" use "yes"/"no". */
  default: string;
}

export interface ElicitationResponse {
  id: string;
  value: string;
}

/** Asks the user a question and resolves to their choice. Injected by the frontend. */
export type ElicitFn = (e: Elicitation) => Promise<ElicitationResponse>;

let counter = 0;
/** Generates a short, unique elicitation id. */
export function newElicitationId(): string {
  counter += 1;
  return `el_${Date.now().toString(36)}_${counter}`;
}

/**
 * The fallback frontend: no interactive client is present (server without a UI, `rei plan "…"`,
 * piped/no-TTY), so resolve to the caller's declared safe default. Never blocks, never edits.
 */
export const nonInteractiveElicit: ElicitFn = async (e) => ({
  id: e.id,
  value: e.default,
});

/**
 * The CLI frontend: renders the question with @clack/prompts. A cancel (Esc / Ctrl-C) resolves to
 * the safe default rather than throwing, so a cancelled prompt behaves like an unattended run.
 */
export function createClackElicit(): ElicitFn {
  return async (e) => {
    if (e.kind === "confirm") {
      const answer = await confirm({ message: e.message });
      if (isCancel(answer)) return { id: e.id, value: e.default };
      return { id: e.id, value: answer ? "yes" : "no" };
    }

    if (e.kind === "text") {
      const answer = await text({ message: e.message });
      if (isCancel(answer)) return { id: e.id, value: e.default };
      return { id: e.id, value: String(answer ?? e.default) };
    }

    const options = (e.options ?? []).map((o) => ({
      value: o.value,
      label: o.label,
    }));
    if (options.length === 0) return { id: e.id, value: e.default };

    const answer = await select({ message: e.message, options });
    if (isCancel(answer)) return { id: e.id, value: e.default };
    return { id: e.id, value: String(answer) };
  };
}
