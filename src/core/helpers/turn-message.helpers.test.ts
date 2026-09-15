import { describe, it, expect, afterEach } from "vitest";
import { cleanResponseForHistory, stripThinkingBlock } from "./turn-message.helpers.js";

describe("cleanResponseForHistory", () => {
  const saved = process.env.REI_PRESERVE_THINKING;
  afterEach(() => {
    if (saved === undefined) delete process.env.REI_PRESERVE_THINKING;
    else process.env.REI_PRESERVE_THINKING = saved;
  });

  it("strips a leaked <request_files> tag from saved history", () => {
    const raw =
      "<request_files>ocr/Nexus.ocr.md</request_files>\n\nLa tesis central es…";
    const clean = cleanResponseForHistory(raw);
    expect(clean).not.toContain("<request_files>");
    expect(clean).toContain("La tesis central es…");
  });

  it("strips execute_command / call_tool execution tags too", () => {
    const raw =
      'Done. <execute_command>npm test</execute_command> <call_tool name="x">{}</call_tool> ok';
    const clean = cleanResponseForHistory(raw);
    expect(clean).not.toContain("<execute_command>");
    expect(clean).not.toContain("<call_tool");
    expect(clean).toContain("Done.");
    expect(clean).toContain("ok");
  });

  it("keeps agent file-op tags (<edit>/<create>) for message classification", () => {
    const raw = "<edit><search>a</search><replace>b</replace></edit>";
    expect(cleanResponseForHistory(raw)).toContain("<edit>");
  });

  it("strips <think> by default (preserve-thinking is OFF unless opted in)", () => {
    delete process.env.REI_PRESERVE_THINKING;
    const clean = cleanResponseForHistory("<think>reasoning</think>Answer.");
    expect(clean).not.toContain("<think>");
    expect(clean).toContain("Answer.");
  });

  it("preserves <think> only when REI_PRESERVE_THINKING=true", () => {
    process.env.REI_PRESERVE_THINKING = "true";
    const clean = cleanResponseForHistory("<think>reasoning</think>Answer.");
    expect(clean).toContain("<think>");
    expect(clean).toContain("Answer.");
    delete process.env.REI_PRESERVE_THINKING;
  });
});

/**
 * `stripThinkingBlock` removes model reasoning from what the user sees and from what the XML
 * extractors parse. It used to match `<think>[\s\S]*?(<\/think>|$)` — and that `|$` is the bug:
 * any `<think>` without a closing tag deleted everything from there to the end of the response.
 *
 * The answer had arrived in full (oMLX logged 2,752 tokens, finish_reason=stop) and REI cut it,
 * which reads exactly like the model running out of output tokens. The two cases share a tag and
 * nothing else: an opener that STARTS the text is a stream still arriving; one in the middle of a
 * sentence is prose — REI explaining its own reasoning tags, most often.
 */
describe("stripThinkingBlock", () => {
  it("removes a closed block and keeps the answer around it", () => {
    expect(stripThinkingBlock("<think>hmm, let me see</think>The answer is 42.")).toBe(
      "The answer is 42.",
    );
  });

  it("removes a closed block that sits mid-answer", () => {
    expect(stripThinkingBlock("First this.<think>wait</think> Then that.")).toBe(
      "First this. Then that.",
    );
  });

  it("removes an unclosed block that opens the text — the stream is still arriving", () => {
    expect(stripThinkingBlock("<think>still reasoning, no close yet")).toBe("");
  });

  it("keeps the answer when an unclosed <think> appears mid-text", () => {
    // The regression. Everything after the stray tag used to vanish.
    const raw =
      "The regex is `<think>[\\s\\S]*?` and it eats the rest of the reply. " +
      "Fix it by anchoring the unclosed case to the start.";
    expect(stripThinkingBlock(raw)).toContain("Fix it by anchoring");
  });

  it("does not truncate an answer that merely names the tag", () => {
    const raw = "Models emit <think> before answering. That is why the strip exists.";
    expect(stripThinkingBlock(raw)).toBe(raw);
  });

  it("removes several closed blocks in one response", () => {
    expect(stripThinkingBlock("<think>a</think>One.<think>b</think>Two.")).toBe("One.Two.");
  });

  it("is case-insensitive, like the tags models actually emit", () => {
    expect(stripThinkingBlock("<THINK>x</THINK>Done.")).toBe("Done.");
  });

  it("leaves a response with no reasoning untouched", () => {
    expect(stripThinkingBlock("Just the answer.")).toBe("Just the answer.");
  });

  it("still strips reasoning when the stream opens with whitespace", () => {
    expect(stripThinkingBlock("\n  <think>reasoning...")).toBe("");
  });
});
