import { describe, it, expect, vi } from "vitest";
import type { ChatMessage } from "../../chat/types.js";
import {
  buildRepetitionRecovery,
  handleRepetition,
  MAX_REPETITION_RETRIES,
} from "./repetition-recovery.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

function params(over: Partial<Parameters<typeof handleRepetition>[0]> = {}) {
  return {
    currentMessages: [{ role: "user", content: "go" }] as ChatMessage[],
    repetitionRetries: 0,
    canAskUser: true,
    logger: fakeLogger,
    emitStatus: vi.fn(),
    virtualEdits: async () => [],
    firstTurnExplanation: "",
    appendCreatedSummary: (r: string) => r,
    ...over,
  };
}

describe("buildRepetitionRecovery", () => {
  it("offers the ask_user door only when a frontend can answer it", () => {
    expect(buildRepetitionRecovery(true)).toContain("ask_user");
    const headless = buildRepetitionRecovery(false);
    expect(headless).not.toContain("ask_user");
    expect(headless).toMatch(/assumption/i);
  });

  it("tells the model not to reconstruct or resume the looping output", () => {
    const msg = buildRepetitionRecovery(true);
    expect(msg).toMatch(/do not try to reconstruct/i);
    expect(msg).toMatch(/do not resume/i);
  });
});

describe("handleRepetition", () => {
  it("retries once, queueing the recovery nudge as a USER turn", async () => {
    const p = params();
    const outcome = await handleRepetition(p);

    expect(outcome.action).toBe("retry");
    if (outcome.action !== "retry") return;
    expect(outcome.repetitionRetries).toBe(1);
    const last = outcome.messages[outcome.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe(buildRepetitionRecovery(true));
    expect(p.emitStatus).toHaveBeenCalled();
  });

  it("never puts the looping output back in the history", async () => {
    const outcome = await handleRepetition(params());
    expect(outcome.action).toBe("retry");
    if (outcome.action !== "retry") return;
    // Exactly one message was added, and it is the nudge — no assistant message carrying the cut text.
    expect(outcome.messages).toHaveLength(2);
    expect(outcome.messages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("gives up after the retry budget and explains the levers", async () => {
    const outcome = await handleRepetition(params({ repetitionRetries: MAX_REPETITION_RETRIES }));
    expect(outcome.action).toBe("finalize");
    if (outcome.action !== "finalize") return;
    expect(outcome.result.response).toMatch(/kept repeating itself/i);
    expect(outcome.result.response).toContain("REI_LOOP_GUARD=off");
  });

  it("keeps the work that was already gathered when it gives up", async () => {
    const edits = [{ file: "a.ts", search: "x", replace: "y" }] as never;
    const outcome = await handleRepetition(
      params({ repetitionRetries: MAX_REPETITION_RETRIES, virtualEdits: async () => edits }),
    );
    expect(outcome.action).toBe("finalize");
    if (outcome.action !== "finalize") return;
    expect(outcome.result.validProposedPatches).toBe(edits);
  });

  it("prefers the turn's real explanation over the canned advice when there is one", async () => {
    const outcome = await handleRepetition(
      params({
        repetitionRetries: MAX_REPETITION_RETRIES,
        firstTurnExplanation: "I was adding the pruned flag.",
      }),
    );
    expect(outcome.action).toBe("finalize");
    if (outcome.action !== "finalize") return;
    expect(outcome.result.response).toBe("I was adding the pruned flag.");
  });
});
