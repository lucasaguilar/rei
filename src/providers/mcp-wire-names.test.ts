import { describe, it, expect } from "vitest";
import { fromWireToolName, toWireToolName } from "../contracts/mcp-tool-names.js";
import { mcpToolsToDefinitions } from "../contracts/tool-definitions.js";

/**
 * Two things REI was sending that strict providers reject, both invisible against a permissive
 * local backend and both fatal against Gemini — one error per MCP tool, so a session with one
 * server produced twenty identical failures and no working request:
 *
 *   Unknown name "modelFeedback" at 'tools[9]': Cannot find field.
 *   function_declarations[9].name: Invalid function name. Must be alphameric …
 *
 * The first was REI's own bookkeeping field riding along on the wire; the second is the `/` in
 * `mcp:server/tool`, which Gemini's function-name grammar does not allow.
 */
describe("toWireToolName", () => {
  it("replaces the server separator with one every provider accepts", () => {
    expect(toWireToolName("mcp:engram/mem_current_project")).toBe(
      "mcp:engram__mem_current_project",
    );
  });

  it("leaves a built-in tool alone", () => {
    expect(toWireToolName("read_files")).toBe("read_files");
    expect(toWireToolName("grep_code")).toBe("grep_code");
  });

  it("translates only the FIRST separator", () => {
    // A tool may legitimately carry a slash further along; only server/tool is structural.
    expect(toWireToolName("mcp:srv/a/b")).toBe("mcp:srv__a/b");
  });
});

describe("fromWireToolName", () => {
  it("restores the registry key the dispatcher looks up", () => {
    expect(fromWireToolName("engram__mem_current_project")).toBe(
      "engram/mem_current_project",
    );
  });

  it("accepts the original form untouched, since some models echo it", () => {
    expect(fromWireToolName("engram/mem_current_project")).toBe(
      "engram/mem_current_project",
    );
  });

  it("keeps a double underscore inside the tool's own name", () => {
    // Only the first `__` is the separator: `srv__a__b` is server `srv`, tool `a__b`.
    expect(fromWireToolName("srv__a__b")).toBe("srv/a__b");
  });

  it("round-trips every name it produced", () => {
    for (const n of ["mcp:engram/mem_current_project", "mcp:fs/read__file", "mcp:a/b"]) {
      expect("mcp:" + fromWireToolName(toWireToolName(n).slice(4))).toBe(n);
    }
  });
});

describe("mcpToolsToDefinitions", () => {
  it("still marks MCP results as needing to go back to the model", () => {
    // The flag stays on the internal object — it is stripped at the wire boundary, not here.
    const defs = mcpToolsToDefinitions([
      { name: "srv/tool", description: "d", inputSchema: { type: "object", properties: {} } },
    ] as never);
    expect(defs[0].modelFeedback).toBe(true);
    expect(defs[0].function.name).toBe("mcp:srv/tool");
  });
});
