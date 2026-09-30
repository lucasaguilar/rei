import { describe, it, expect } from "vitest";
import { validateMcpArgs } from "./mcp-args-validation.js";
import type { McpTool } from "../../tools/mcp/mcp-client.js";

// The shape of github/create_pull_request, trimmed: the tool the model called with `body: true`,
// which opened PR #21 with an empty description and cost thirteen turns to repair.
const CREATE_PR: McpTool = {
  name: "github/create_pull_request",
  description: "Create a pull request",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      head: { type: "string" },
      base: { type: "string" },
      draft: { type: "boolean" },
    },
    required: ["owner", "repo", "title", "head", "base"],
  },
};

const VALID = { owner: "lucasaguilar", repo: "rei", title: "t", head: "feat/x", base: "main" };

describe("validateMcpArgs", () => {
  it("rejects a boolean where the schema wants a string (the PR #21 case)", () => {
    const err = validateMcpArgs(CREATE_PR, { ...VALID, body: true });
    expect(err).toMatch(/body/);
    expect(err).toMatch(/string/);
  });

  it("names a missing required argument", () => {
    const { title: _omitted, ...noTitle } = VALID;
    expect(validateMcpArgs(CREATE_PR, noTitle)).toMatch(/title/);
  });

  it("tells the model how to recover, not just what failed", () => {
    expect(validateMcpArgs(CREATE_PR, { ...VALID, body: true })).toMatch(/call it again/i);
  });

  it("accepts arguments that match", () => {
    expect(validateMcpArgs(CREATE_PR, { ...VALID, body: "## Summary", draft: false })).toBeNull();
  });

  // Seen live, right after the fix above shipped: `"body ": -6558`. The key has a trailing space, so
  // to the schema it is an extra property, `body` itself is optional, and the call validated — the
  // server would have dropped the unknown key and opened the PR with no description again.
  it("rejects an argument name the tool does not have, and suggests the real one", () => {
    const err = validateMcpArgs(CREATE_PR, { ...VALID, "body ": -6558 });
    expect(err).toContain('unknown argument "body "');
    expect(err).toContain('did you mean "body"');
  });

  it("suggests the real name for a case or separator slip", () => {
    expect(validateMcpArgs(CREATE_PR, { ...VALID, Body: "x" })).toContain('did you mean "body"');
    expect(validateMcpArgs(CREATE_PR, { ...VALID, "draft-": false })).toContain('did you mean "draft"');
  });

  it("lists the accepted names when nothing is close", () => {
    const err = validateMcpArgs(CREATE_PR, { ...VALID, reviewers: ["a"] });
    expect(err).toContain('unknown argument "reviewers"');
    expect(err).toMatch(/owner, repo, title, body, head, base, draft/);
  });

  it("reports an unknown name and a wrong type together, so one retry fixes both", () => {
    const err = validateMcpArgs(CREATE_PR, { ...VALID, "title ": "x", body: true });
    expect(err).toContain('unknown argument "title "');
    expect(err).toMatch(/body must be string/);
  });

  it("says it once when the schema itself forbids extra names", () => {
    const closed: McpTool = {
      ...CREATE_PR,
      inputSchema: { ...CREATE_PR.inputSchema, additionalProperties: false },
    };
    const err = validateMcpArgs(closed, { ...VALID, "body ": "x" });
    expect(err).toContain('did you mean "body"');
    expect(err).not.toMatch(/additional properties/);
  });

  // A schema that explicitly opens itself to extra keys is taken at its word.
  for (const [label, extra] of [
    ["additionalProperties: true", { additionalProperties: true }],
    ["an additionalProperties schema", { additionalProperties: { type: "string" } }],
    ["patternProperties", { patternProperties: { "^x-": { type: "string" } } }],
  ] as const) {
    it(`allows extra names when the schema declares ${label}`, () => {
      const open: McpTool = {
        ...CREATE_PR,
        inputSchema: { ...CREATE_PR.inputSchema, ...extra },
      };
      expect(validateMcpArgs(open, { ...VALID, "x-extra": "y" })).toBeNull();
    });
  }

  it("does not invent a closed set for a schema that lists no properties", () => {
    const loose: McpTool = { name: "x/loose", description: "", inputSchema: { type: "object" } };
    expect(validateMcpArgs(loose, { anything: 1 })).toBeNull();
  });

  it("does not judge a tool that declares no schema", () => {
    expect(validateMcpArgs({ name: "x/y", description: "" }, { anything: 1 })).toBeNull();
  });

  it("does not judge a tool the registry does not know (the confirm gate handles that)", () => {
    expect(validateMcpArgs(undefined, { anything: 1 })).toBeNull();
  });

  // A server with a schema our validator cannot compile must still be usable: the server validates
  // its own input anyway, so this check is a fast path, never a new way for a tool to break.
  it("lets the call through when the schema itself cannot be compiled", () => {
    const broken: McpTool = {
      name: "x/broken",
      description: "",
      inputSchema: { type: "object", properties: { a: { $ref: "#/definitions/missing" } } },
    };
    expect(validateMcpArgs(broken, { a: 1 })).toBeNull();
  });
});
