/**
 * Phase 4b of docs/persona-spec.md. A persona declares its own tools, and the session's mode must not
 * filter them again: `allowedTools` can therefore offer a tool the mode alone would not (create_file
 * in ask). And its skills are the ones it names — `skillNames` narrows the use_skill catalog to them,
 * whatever the skills' own `modes:` say. Without either, a turn is exactly what it was.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeAgentTurnWithTools } from "./generator-tools.js";
import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider, ChatCompletionWithTools, ToolDefinition } from "../providers/model-provider.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

function recorder(responses: ChatCompletionWithTools[] = []) {
  const offered: ToolDefinition[][] = [];
  const toolResults: string[] = [];
  let i = 0;
  const provider = {
    completeChat: vi.fn(async () => ""),
    completeChatWithTools: vi.fn(async (m: ChatMessage[], tools: ToolDefinition[]) => {
      offered.push(tools);
      toolResults.push(...m.filter((x) => x.role === "tool").map((x) => String(x.content)));
      return responses[i++] ?? { content: "done", reasoning: "", finishReason: "stop", toolCalls: [] };
    }),
  } as unknown as ModelProvider;
  return { provider, offered, toolResults };
}
const names = (tools: ToolDefinition[]) => tools.map((t) => t.function.name);
const skill = (ws: string, name: string, modes = "") =>
  fs.writeFileSync(
    path.join(ws, ".rei", "skills", `${name}.md`),
    `---\nname: ${name}\ndescription: the ${name} recipe\n${modes}---\n\nSteps for ${name}.\n`,
  );

describe("allowedTools beyond the session's mode, and skills by name", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rei-surface-")));
    fs.mkdirSync(path.join(ws, ".rei", "skills"), { recursive: true });
    skill(ws, "briefing"); // no modes: → agent only
    skill(ws, "other");
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  const run = (over: Record<string, unknown>, responses?: ChatCompletionWithTools[]) => {
    const r = recorder(responses);
    return executeAgentTurnWithTools({
      provider: r.provider,
      messagesForModel: [{ role: "user", content: "go" }],
      workspacePath: ws,
      logger: fakeLogger,
      mode: "ask",
      ...over,
    }).then(() => r);
  };

  it("an allowed tool is offered even when the mode alone would not offer it", async () => {
    const { offered } = await run({ allowedTools: ["read_files", "create_file"] });
    expect(names(offered[0]).sort()).toEqual(["create_file", "read_files"]);
  });

  it("without allowedTools, ask is read-only as before", async () => {
    const { offered } = await run({});
    expect(names(offered[0])).not.toContain("create_file");
  });

  it("skillNames narrows the catalog to those skills, whatever their modes say", async () => {
    const { offered } = await run({ allowedTools: ["use_skill"], skillNames: ["briefing"] });
    const useSkill = offered[0].find((t) => t.function.name === "use_skill");
    expect(useSkill?.function.description).toContain("briefing");
    expect(useSkill?.function.description).not.toContain("other");
  });

  it("a skill outside skillNames cannot be loaded by name either", async () => {
    const { toolResults } = await run({ allowedTools: ["use_skill"], skillNames: ["briefing"] }, [
      {
        content: "",
        reasoning: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "u1", type: "function", function: { name: "use_skill", arguments: '{"name":"other"}' } }],
      } as ChatCompletionWithTools,
    ]);
    expect(toolResults.join("\n")).toMatch(/No skill named "other"/);
    expect(toolResults.join("\n")).not.toContain("Steps for other");
  });
});
