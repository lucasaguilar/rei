import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dispatchToolCalls, type DispatchContext } from "./dispatch-tool-calls.js";
import { describeMcpRisk } from "./mcp-call-gate.js";
import { createVirtualFileTree } from "./virtual-file-tree.js";
import type { ToolCall } from "../../providers/model-provider.js";
import type { McpTool } from "../../tools/mcp/mcp-client.js";
import type { ElicitFn } from "../../chat/elicitation.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

function call(name: string, args: unknown, id = name): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function tool(name: string, annotations?: McpTool["annotations"]): McpTool {
  return { name, description: name, annotations };
}

describe("describeMcpRisk", () => {
  it("trusts a server that declares the tool read-only", () => {
    expect(describeMcpRisk(tool("gmail/delete_draft", { readOnlyHint: true }))).toBeNull();
  });

  it("flags a declared destructive tool", () => {
    expect(describeMcpRisk(tool("drive/trash", { readOnlyHint: false }))).toMatch(/delete|overwrite/);
  });

  it("distinguishes an additive write from a destructive one", () => {
    const risk = describeMcpRisk(
      tool("calendar/create_event", { readOnlyHint: false, destructiveHint: false }),
    );
    expect(risk).toMatch(/change data/);
    expect(risk).not.toMatch(/delete/);
  });

  it("says when the action reaches outside (sends, publishes)", () => {
    const risk = describeMcpRisk(tool("slack/post", { readOnlyHint: false, openWorldHint: true }));
    expect(risk).toMatch(/outside/);
  });

  // Most servers ship no annotations at all; the tool's own name is then the only signal.
  for (const name of [
    "gmail/send_message",
    "google_workspace/delete_event",
    "drive/updateFile",
    "jira/transition-issue",
    "github/create_pull_request",
  ]) {
    it(`falls back to the verb in an unannotated name: ${name}`, () => {
      expect(describeMcpRisk(tool(name))).not.toBeNull();
    });
  }

  for (const name of [
    "gmail/search_gmail_messages",
    "drive/list_files",
    "calendar/get_events",
    "fs/readFile",
    // "settings" contains "set" and "address" contains "add": matching on whole words, not
    // substrings, is what keeps read-only tools from prompting.
    "admin/get_settings",
    "contacts/lookup_address",
  ]) {
    it(`does not flag a read-only-looking unannotated tool: ${name}`, () => {
      expect(describeMcpRisk(tool(name))).toBeNull();
    });
  }

  it("flags a tool the model calls that the registry does not list", () => {
    // Unknown means unverified — the safe answer is to ask.
    expect(describeMcpRisk(undefined, "ghost/whatever")).not.toBeNull();
  });
});

describe("MCP call gate in dispatchToolCalls", () => {
  let ws: string;
  let ctx: DispatchContext;
  let dispatch: ReturnType<typeof vi.fn>;

  const SEND: McpTool = {
    ...tool("gmail/send_message", { readOnlyHint: false, openWorldHint: true }),
    inputSchema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } } },
  };
  const SEARCH = tool("gmail/search_messages", { readOnlyHint: true });

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-mcp-gate-test-"));
    const tree = createVirtualFileTree(ws);
    dispatch = vi.fn(async () => "ok");
    ctx = {
      workspacePath: ws,
      logger: fakeLogger,
      emitStatus: () => {},
      provider: {} as never,
      mcpRegistry: { dispatch } as never,
      toRel: tree.toRel,
      currentContent: tree.currentContent,
      virtualFiles: tree.virtualFiles,
      allMcpTools: [SEND, SEARCH],
      activeMcp: new Set([SEND.name, SEARCH.name]),
      skills: [],
      resolveTarget: tree.resolveTarget,
      createdFiles: [],
      commandHistory: new Map<string, number>(),
    };
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  const answering = (value: string) =>
    vi.fn<ElicitFn>(async (e) => ({ id: e.id, value }));

  it("does not send the email when the user declines", async () => {
    const elicit = answering("no");
    const { toolResultsMap } = await dispatchToolCalls(
      [call("mcp:gmail/send_message", { to: "juan@example.com", body: "hola" }, "c1")],
      { ...ctx, elicit },
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(elicit).toHaveBeenCalledOnce();
    // The user has to see WHAT would be sent, not just the tool name.
    expect(elicit.mock.calls[0][0].message).toContain("juan@example.com");
    expect(toolResultsMap.get("c1")).toMatch(/DECLINED/);
  });

  it("sends it when the user confirms", async () => {
    await dispatchToolCalls([call("mcp:gmail/send_message", { to: "x" }, "c1")], {
      ...ctx,
      elicit: answering("yes"),
    });
    expect(dispatch).toHaveBeenCalledWith("gmail/send_message", { to: "x" });
  });

  it("refuses when there is nobody to ask (server / headless)", async () => {
    const { toolResultsMap } = await dispatchToolCalls(
      [call("mcp:gmail/send_message", { to: "x" }, "c1")],
      ctx,
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(toolResultsMap.get("c1")).toMatch(/REFUSED/);
    expect(toolResultsMap.get("c1")).toContain("REI_CONFIRM_MCP=false");
  });

  it("runs a read-only tool without asking", async () => {
    const elicit = answering("no");
    await dispatchToolCalls([call("mcp:gmail/search_messages", { q: "juan" })], {
      ...ctx,
      elicit,
    });
    expect(elicit).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("resolves the provider-safe wire name (server__tool) before judging", async () => {
    const elicit = answering("no");
    await dispatchToolCalls([call("mcp:gmail__send_message", { to: "x" })], { ...ctx, elicit });
    expect(elicit).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  // Asking the user to approve arguments the server will reject wastes their attention and, as in
  // PR #21, can succeed half-way (the PR opened, its body lost). Bad arguments go back to the model.
  it("returns invalid arguments to the model before asking the user", async () => {
    const elicit = answering("yes");
    const { toolResultsMap, hasToolFailure } = await dispatchToolCalls(
      [call("mcp:gmail/send_message", { to: "x", body: true }, "c1")],
      { ...ctx, elicit },
    );
    expect(elicit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(hasToolFailure).toBe(true);
    expect(toolResultsMap.get("c1")).toMatch(/body must be string/);
  });

  it("counts the third identical invalid call as a blocked repeat, so the loop escalates", async () => {
    const invalidMcpCalls = new Map<string, number>();
    const bad = () => [call("mcp:gmail/send_message", { to: "x", body: true })];
    const runCtx = { ...ctx, invalidMcpCalls };
    expect((await dispatchToolCalls(bad(), runCtx)).blockedRepeatCount).toBe(0);
    expect((await dispatchToolCalls(bad(), runCtx)).blockedRepeatCount).toBe(0);
    expect((await dispatchToolCalls(bad(), runCtx)).blockedRepeatCount).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  describe("with REI_CONFIRM_MCP=false", () => {
    beforeEach(() => vi.stubEnv("REI_CONFIRM_MCP", "false"));
    afterEach(() => vi.unstubAllEnvs());

    it("lets an operator run side-effecting tools unattended", async () => {
      await dispatchToolCalls([call("mcp:gmail/send_message", { to: "x" })], ctx);
      expect(dispatch).toHaveBeenCalledOnce();
    });
  });
});
