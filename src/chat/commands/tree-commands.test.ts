import { describe, it, expect } from "vitest";
import {
  summarizeTurns,
  renderSessionTree,
  parseIndexSpec,
} from "./tree-commands.js";
import { buildMessagesForModel } from "../message-builder.js";
import type { ChatMessage } from "../types.js";

const sys = (c: string): ChatMessage => ({ role: "system", content: c });
const user = (c: string, turnId?: string): ChatMessage => ({ role: "user", content: c, turnId });
const asst = (c: string, turnId?: string, sourceMode?: ChatMessage["sourceMode"]): ChatMessage => ({
  role: "assistant",
  content: c,
  turnId,
  sourceMode,
});

describe("summarizeTurns", () => {
  it("groups each user prompt with its following messages into one turn", () => {
    const turns = summarizeTurns([
      sys("system prompt"),
      user("change the button", "t1"),
      asst("done", "t1", "agent"),
      user("what is a decorator", "t2"),
      asst("it's a wrapper", "t2", "ask"),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ index: 1, turnId: "t1", mode: "agent", messageCount: 2 });
    expect(turns[1]).toMatchObject({ index: 2, turnId: "t2", mode: "ask", messageCount: 2 });
  });

  it("skips system messages and truncates a long title to one line", () => {
    const long = "line one\nline two ".repeat(20);
    const turns = summarizeTurns([sys("x"), user(long, "t1")]);
    expect(turns).toHaveLength(1);
    expect(turns[0].title).not.toContain("\n");
    expect(turns[0].title.endsWith("…")).toBe(true);
  });

  it("still segments by user prompt when turnId is absent (older sessions)", () => {
    const turns = summarizeTurns([user("a"), asst("a1"), user("b"), asst("b1")]);
    expect(turns).toHaveLength(2);
    expect(turns[0].turnId).toBeUndefined();
    expect(turns.map((t) => t.messageCount)).toEqual([2, 2]);
  });

  it("handles leading assistant-only messages as a '(no prompt)' turn", () => {
    const turns = summarizeTurns([asst("welcome"), user("hi", "t1")]);
    expect(turns[0].title).toBe("(no prompt)");
    expect(turns[1].title).toBe("hi");
  });
});

describe("renderSessionTree", () => {
  it("reports an empty session", () => {
    expect(renderSessionTree([])).toContain("empty");
  });

  it("renders a header with the turn count and one line per turn", () => {
    const out = renderSessionTree(
      summarizeTurns([user("change the button", "t1"), asst("done", "t1", "agent")]),
    );
    expect(out).toContain("SESSION TREE (1 turns)");
    expect(out).toContain("change the button");
    expect(out).toContain("(2 msgs)");
  });

  it("marks pruned turns and counts them in the header", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "feature work", turnId: "t1" },
      { role: "user", content: "weather?", turnId: "t2", pruned: true },
      { role: "assistant", content: "sunny", turnId: "t2", pruned: true },
    ];
    const out = renderSessionTree(summarizeTurns(msgs));
    expect(out).toContain("SESSION TREE (2 turns, 1 pruned)");
    expect(out).toContain("✂️ pruned");
  });
});

describe("parseIndexSpec", () => {
  it("parses singles, ranges, and multiples; drops out-of-range and junk", () => {
    expect(parseIndexSpec("28", 33)).toEqual([28]);
    expect(parseIndexSpec("26-28", 33)).toEqual([26, 27, 28]);
    expect(parseIndexSpec("28-26", 33)).toEqual([26, 27, 28]); // reversed range
    expect(parseIndexSpec("26-28 31, 5", 33)).toEqual([5, 26, 27, 28, 31]);
    expect(parseIndexSpec("40 abc 3", 33)).toEqual([3]); // 40 out of range, abc junk
    expect(parseIndexSpec("", 33)).toEqual([]);
  });
});

describe("pruned turns are excluded from the model context", () => {
  it("buildMessagesForModel drops pruned messages, keeping the rest", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "feature work", turnId: "t1" },
      { role: "assistant", content: "on it", turnId: "t1" },
      { role: "user", content: "weather?", turnId: "t2", pruned: true },
      { role: "assistant", content: "sunny", turnId: "t2", pruned: true },
      { role: "user", content: "back to feature", turnId: "t3" },
    ];
    const out = buildMessagesForModel(msgs, "ask");
    const contents = out.map((m) => m.content);
    expect(contents).not.toContain("weather?");
    expect(contents).not.toContain("sunny");
    expect(contents).toContain("back to feature");
  });
});
