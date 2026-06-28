import { describe, it, expect, vi } from "vitest";
import { buildFinalResponse } from "./finalize-response.js";
import type { ModelProvider } from "../../providers/model-provider.js";

const noopStatus = () => {};
const baseProvider = { completeChat: vi.fn(async () => "") } as unknown as ModelProvider;

const base = {
  firstTurnExplanation: "",
  modifiedFiles: [] as string[],
  createdFiles: [] as string[],
  currentMessages: [],
  provider: baseProvider,
  formatCorrections: 0,
  emitStatus: noopStatus,
};

describe("buildFinalResponse", () => {
  it("returns the model's content as-is for a normal answer with no changes", async () => {
    const out = await buildFinalResponse({ ...base, content: "Here is the explanation." });
    expect(out).toBe("Here is the explanation.");
  });

  it("does NOT duplicate when first-turn explanation equals content modulo whitespace", async () => {
    // Single-turn plain answer: firstTurnExplanation is the trimmed content; content has trailing
    // whitespace. They must be treated as equal (no prepend) — the duplicated-output bug.
    const out = await buildFinalResponse({
      ...base,
      content: "Same answer.\n\n",
      firstTurnExplanation: "Same answer.",
    });
    expect(out).toBe("Same answer."); // trimmed, and NOT duplicated
    expect(out.match(/Same answer\./g)?.length).toBe(1);
  });

  it("prepends the first-turn explanation when distinct", async () => {
    const out = await buildFinalResponse({
      ...base,
      content: "final words",
      firstTurnExplanation: "the plan",
    });
    expect(out).toContain("the plan");
    expect(out).toContain("final words");
  });

  it("requests a recap when changes were applied but the reply is terse", async () => {
    const provider = { completeChat: vi.fn(async () => "a.ts: bumped the version") } as unknown as ModelProvider;
    const out = await buildFinalResponse({
      ...base,
      content: "ok",
      modifiedFiles: ["a.ts"],
      provider,
    });
    expect(provider.completeChat).toHaveBeenCalledTimes(1);
    expect(out).toContain("a.ts: bumped the version");
  });

  it("falls back to a file list when the recap model call fails", async () => {
    const provider = { completeChat: vi.fn(async () => { throw new Error("down"); }) } as unknown as ModelProvider;
    const out = await buildFinalResponse({
      ...base,
      content: "",
      createdFiles: ["new.ts"],
      provider,
    });
    expect(out).toContain("new.ts");
  });

  it("prepends a loud warning when nothing was applied but edits were implied", async () => {
    const out = await buildFinalResponse({
      ...base,
      content: "I'll edit it: ```ts\nconst x = 2;\n```",
    });
    expect(out).toContain("NO FILE WAS CHANGED");
  });
});
