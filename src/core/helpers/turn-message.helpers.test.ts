import { describe, it, expect, afterEach } from "vitest";
import { cleanResponseForHistory } from "./turn-message.helpers.js";

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

  it("preserves <think> by default", () => {
    delete process.env.REI_PRESERVE_THINKING;
    const clean = cleanResponseForHistory("<think>reasoning</think>Answer.");
    expect(clean).toContain("<think>");
    expect(clean).toContain("Answer.");
  });

  it("strips <think> when REI_PRESERVE_THINKING is false", () => {
    process.env.REI_PRESERVE_THINKING = "false";
    const clean = cleanResponseForHistory("<think>reasoning</think>Answer.");
    expect(clean).not.toContain("<think>");
    expect(clean).toContain("Answer.");
  });
});
