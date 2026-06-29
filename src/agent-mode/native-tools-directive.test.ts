import { describe, it, expect } from "vitest";
import { withNativeToolsDirective } from "./generator-tools.js";
import type { ChatMessage } from "../chat/types.js";

describe("withNativeToolsDirective", () => {
  it("inserts the directive right after the leading system message", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "mode prompt" },
      { role: "user", content: "do the thing" },
    ];
    const out = withNativeToolsDirective(msgs);
    expect(out).toHaveLength(3);
    expect(out[0].content).toBe("mode prompt");
    expect(out[1].role).toBe("system");
    expect(out[1].content).toMatch(/multiple edit_file tool calls together/i);
    expect(out[2].content).toBe("do the thing");
  });

  it("tells the model to read repo files with read_files, not run_command (cat/head/sed)", () => {
    const out = withNativeToolsDirective([{ role: "user", content: "hi" }]);
    const directive = out[0].content as string;
    expect(directive).toMatch(/read_files/);
    expect(directive).toMatch(/cat\/head\/tail\/sed/);
    expect(directive).toMatch(/capped/i);
  });

  it("places the directive first when there is no system message", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];
    const out = withNativeToolsDirective(msgs);
    expect(out[0].role).toBe("system");
    expect(out[1].content).toBe("hi");
  });

  it("does not mutate the input array", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];
    withNativeToolsDirective(msgs);
    expect(msgs).toHaveLength(1);
  });
});
