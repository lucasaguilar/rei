import { describe, it, expect } from "vitest";
import { pruneSupersededReads } from "./prune-superseded-reads.js";
import type { ChatMessage } from "../../chat/types.js";

const read = (id: string, content: string): ChatMessage =>
  ({ role: "tool", name: "read_files", tool_call_id: id, content }) as ChatMessage;
const file = (path: string, body: string) => `--- File: ${path} ---\n\`\`\`\n${body}\n\`\`\`\n`;
const BIG = "x".repeat(500);

const contentOf = (m: ChatMessage[], i: number) => String(m[i].content);

describe("pruneSupersededReads", () => {
  it("drops the earlier copy when the same file is read again", () => {
    const out = pruneSupersededReads([read("1", file("a.ts", BIG)), read("2", file("a.ts", BIG))]);
    expect(contentOf(out, 0)).toContain("shown again in a later read");
    expect(contentOf(out, 0)).not.toContain(BIG);
  });

  it("keeps the LAST copy intact — that is the current one", () => {
    const out = pruneSupersededReads([read("1", file("a.ts", BIG)), read("2", file("a.ts", BIG))]);
    expect(contentOf(out, 1)).toContain(BIG);
  });

  it("leaves a file read only once completely alone", () => {
    const msgs = [read("1", file("a.ts", BIG))];
    expect(pruneSupersededReads(msgs)[0].content).toBe(msgs[0].content);
  });

  it("prunes per FILE, not per message", () => {
    // One read of a.ts + b.ts, then a re-read of a.ts only: b.ts must survive whole.
    const out = pruneSupersededReads([
      read("1", file("a.ts", BIG) + file("b.ts", BIG)),
      read("2", file("a.ts", BIG)),
    ]);
    expect(contentOf(out, 0)).toContain("--- File: b.ts ---");
    expect(contentOf(out, 0).match(new RegExp(BIG, "g"))).toHaveLength(1); // only b.ts's body
  });

  it("keeps the header of a pruned section, so the model sees the read happened", () => {
    const out = pruneSupersededReads([read("1", file("a.ts", BIG)), read("2", file("a.ts", BIG))]);
    expect(contentOf(out, 0)).toContain("--- File: a.ts ---");
  });
});

/**
 * A paged read is not a re-read. `lines 1-400` and `lines 401-800` are different halves of the
 * file, and treating the second as replacing the first would delete content the model still needs
 * — the failure that makes age-based pruning dangerous, reproduced by a sloppier identity check.
 */
describe("paged reads are distinct content", () => {
  const page = (path: string, from: number, to: number, total: number, body: string) =>
    `--- File: ${path} (lines ${from}-${to} of ${total}) ---\n${body}\n`;

  it("does not treat a different page as superseding an earlier one", () => {
    const out = pruneSupersededReads([
      read("1", page("a.ts", 1, 400, 800, BIG)),
      read("2", page("a.ts", 401, 800, 800, BIG)),
    ]);
    expect(contentOf(out, 0)).toContain(BIG);
  });

  it("does prune when the very same page is fetched twice", () => {
    const out = pruneSupersededReads([
      read("1", page("a.ts", 1, 400, 800, BIG)),
      read("2", page("a.ts", 1, 400, 800, BIG)),
    ]);
    expect(contentOf(out, 0)).not.toContain(BIG);
  });

  it("does not treat a full read as the same as a paged one", () => {
    const out = pruneSupersededReads([
      read("1", file("a.ts", BIG)),
      read("2", page("a.ts", 1, 400, 800, BIG)),
    ]);
    expect(contentOf(out, 0)).toContain(BIG);
  });
});

describe("what it refuses to touch", () => {
  it("never grows the context — a stub longer than the section is not applied", () => {
    const tiny = file("a.ts", "1");
    const out = pruneSupersededReads([read("1", tiny), read("2", tiny)]);
    expect(contentOf(out, 0)).toBe(tiny);
  });

  it("ignores results from other tools, whose format it does not know", () => {
    const cmd = { role: "tool", name: "run_command", tool_call_id: "1", content: file("a.ts", BIG) } as ChatMessage;
    const out = pruneSupersededReads([cmd, read("2", file("a.ts", BIG))]);
    expect(contentOf(out, 0)).toContain(BIG);
  });

  it("leaves user and assistant messages untouched", () => {
    const msgs = [
      { role: "user", content: file("a.ts", BIG) } as ChatMessage,
      read("2", file("a.ts", BIG)),
    ];
    expect(pruneSupersededReads(msgs)[0].content).toBe(msgs[0].content);
  });

  it("keeps every message and every tool_call_id — pairing must survive", () => {
    // A tool result orphaned from its call makes the next request malformed.
    const msgs = [read("1", file("a.ts", BIG)), read("2", file("a.ts", BIG))];
    const out = pruneSupersededReads(msgs);
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.tool_call_id)).toEqual(["1", "2"]);
    expect(out.map((m) => m.role)).toEqual(["tool", "tool"]);
  });

  it("handles a result with no file headers at all", () => {
    const msgs = [read("1", "(no files matched)"), read("2", "(no files matched)")];
    expect(pruneSupersededReads(msgs)[0].content).toBe("(no files matched)");
  });
});

describe("the saving is real", () => {
  it("shrinks a turn that read the same file three times", () => {
    const msgs = [
      read("1", file("a.ts", BIG)),
      read("2", file("a.ts", BIG)),
      read("3", file("a.ts", BIG)),
    ];
    const before = msgs.reduce((n, m) => n + String(m.content).length, 0);
    const after = pruneSupersededReads(msgs).reduce((n, m) => n + String(m.content).length, 0);
    expect(after).toBeLessThan(before / 2);
  });
});
