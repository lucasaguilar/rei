import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  dispatchToolCalls,
  type DispatchContext,
} from "./dispatch-tool-calls.js";
import { createVirtualFileTree } from "./virtual-file-tree.js";
import type { ToolCall } from "../../providers/model-provider.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

function call(name: string, args: unknown, id = name): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

describe("dispatchToolCalls", () => {
  let ws: string;
  let ctx: DispatchContext;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-dispatch-test-"));
    const tree = createVirtualFileTree(ws);
    ctx = {
      workspacePath: ws,
      logger: fakeLogger,
      emitStatus: () => {},
      provider: {} as never,
      mcpRegistry: undefined,
      toRel: tree.toRel,
      currentContent: tree.currentContent,
      virtualFiles: tree.virtualFiles,
      allMcpTools: [],
      activeMcp: new Set<string>(),
      skills: [],
      resolveTarget: tree.resolveTarget,
      createdFiles: [],
      commandHistory: new Map<string, number>(),
    };
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  describe("write scope by mode", () => {
    // The gate runs on EXECUTION, so these go through the real dispatch — a unit test of the
    // predicate alone would not prove the three write tools are actually behind it.
    const planningCtx = () => ({ ...ctx, mode: "planning" });

    it("lets planning write the spec-driven flow's artifacts", async () => {
      const { editTasks, hasToolFailure } = await dispatchToolCalls(
        [call("create_file", { file: ".rei/specs/feature.md", content: "# Spec" })],
        planningCtx(),
      );
      expect(hasToolFailure).toBe(false);
      expect(editTasks.length + ctx.createdFiles.length).toBeGreaterThan(0);
    });

    for (const tool of ["create_file", "edit_file", "rewrite_file"] as const) {
      it(`blocks ${tool} on source in planning, with a refusal the model can act on`, async () => {
        const { toolResultsMap, hasToolFailure } = await dispatchToolCalls(
          [call(tool, { file: "src/index.ts", content: "x", search: "a", replace: "b" })],
          planningCtx(),
        );
        expect(hasToolFailure).toBe(true);
        expect(toolResultsMap.get(tool)).toContain("not allowed in this mode");
        expect(toolResultsMap.get(tool)).toContain(".rei/specs");
      });
    }

    it("blocks a '..' walk out of an allowed directory", async () => {
      const { hasToolFailure } = await dispatchToolCalls(
        [call("create_file", { file: "docs/../src/evil.ts", content: "x" })],
        planningCtx(),
      );
      expect(hasToolFailure).toBe(true);
    });

    it("writes nothing to disk when a write is refused", async () => {
      await dispatchToolCalls(
        [call("create_file", { file: "src/index.ts", content: "x" })],
        planningCtx(),
      );
      expect(fs.existsSync(path.join(ws, "src/index.ts"))).toBe(false);
    });

    it("agent still writes source — the gate must not leak into it", async () => {
      const { hasToolFailure } = await dispatchToolCalls(
        [call("edit_file", { file: "a.ts", search: "x", replace: "y" })],
        { ...ctx, mode: "agent" },
      );
      expect(hasToolFailure).toBe(false);
    });
  });

  it("runs read_files and returns its result keyed by call id", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "const a = 1;");
    const { toolResultsMap, hasToolFailure } = await dispatchToolCalls(
      [call("read_files", { paths: ["a.ts"] })],
      ctx,
    );
    expect(hasToolFailure).toBe(false);
    expect(toolResultsMap.get("read_files")).toContain("const a = 1;");
  });

  it("queues edit_file into editTasks instead of applying it", async () => {
    const { editTasks } = await dispatchToolCalls(
      [call("edit_file", { file: "a.ts", search: "x", replace: "y" })],
      ctx,
    );
    expect(editTasks).toHaveLength(1);
    expect(editTasks[0].edit).toMatchObject({ search: "x", replace: "y" });
  });

  it("flags failure and a precise error for malformed edit_file args", async () => {
    const { editTasks, toolResultsMap, hasToolFailure } = await dispatchToolCalls(
      [call("edit_file", { file: "a.ts", search: "x" })], // missing replace
      ctx,
    );
    expect(hasToolFailure).toBe(true);
    expect(editTasks).toHaveLength(0);
    expect(toolResultsMap.get("edit_file")).toContain("replace");
  });

  it("reports an unknown tool as a failure", async () => {
    const { hasToolFailure, toolResultsMap } = await dispatchToolCalls(
      [call("bogus_tool", {})],
      ctx,
    );
    expect(hasToolFailure).toBe(true);
    expect(toolResultsMap.get("bogus_tool")).toContain('Unknown tool "bogus_tool"');
  });

  it("captures a thrown error (invalid JSON args) as an ERROR result", async () => {
    const bad: ToolCall = {
      id: "x",
      type: "function",
      function: { name: "read_files", arguments: "{not json" },
    };
    const { hasToolFailure, toolResultsMap } = await dispatchToolCalls([bad], ctx);
    expect(hasToolFailure).toBe(true);
    expect(toolResultsMap.get("x")).toMatch(/^ERROR:/);
  });

  it("run_command loop-guard: blocks an exact repeat with a read_files nudge", async () => {
    const cmd = "find . -name agent.ts";
    // First run executes (echo is harmless and real).
    await dispatchToolCalls([call("run_command", { command: "echo hi" }, "c1")], ctx);
    expect(ctx.commandHistory.get("echo hi")).toBe(1);

    // Same command twice in the SAME history → second is intercepted, not executed.
    await dispatchToolCalls([call("run_command", { command: cmd }, "first")], ctx);
    const { toolResultsMap } = await dispatchToolCalls(
      [call("run_command", { command: cmd }, "repeat")],
      ctx,
    );
    const nudge = toolResultsMap.get("repeat")!;
    expect(nudge).toMatch(/already ran this exact command/i);
    expect(nudge).toMatch(/read_files/);
    expect(ctx.commandHistory.get(cmd)).toBe(2);
  });

  it("reports blockedRepeatCount so the loop can escalate", async () => {
    const c = { command: "ls -la" };
    const first = await dispatchToolCalls([call("run_command", c, "a")], ctx);
    expect(first.blockedRepeatCount).toBe(0); // first run executes
    const second = await dispatchToolCalls([call("run_command", c, "b")], ctx);
    expect(second.blockedRepeatCount).toBe(1); // repeat is blocked + counted
  });

  it("preserves order: one tool result per call", async () => {
    fs.writeFileSync(path.join(ws, "a.ts"), "A");
    fs.writeFileSync(path.join(ws, "b.ts"), "B");
    const { toolResultsMap } = await dispatchToolCalls(
      [
        call("read_files", { paths: ["a.ts"] }, "c1"),
        call("edit_file", { file: "b.ts", search: "B", replace: "C" }, "c2"),
      ],
      ctx,
    );
    expect(toolResultsMap.has("c1")).toBe(true);
    // edit_file queues silently (no toolResult unless it errors)
    expect(toolResultsMap.has("c2")).toBe(false);
  });
});
