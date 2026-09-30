/**
 * Checks an MCP call's arguments against the tool's own `inputSchema` before anything else runs.
 *
 * Observed: a local model called github/create_pull_request with `body: true`. The server accepted
 * it, PR #21 opened with no description, and the model spent thirteen turns repairing it — `gh`,
 * token hunting, the public API — before finding update_pull_request. The schema already said
 * `body` is a string; checking it up front turns that into a one-turn retry, and keeps the confirm
 * gate from asking the user to approve arguments that are wrong anyway.
 */
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import type { McpTool } from "../../tools/mcp/mcp-client.js";

let provider: AjvJsonSchemaValidator | undefined;

// Compiling a schema costs far more than validating against it, and a tool's schema object lives as
// long as its server connection — so compile once per schema, and let a reconnect drop the entry.
// `null` records a schema that failed to compile, so it is not retried on every call.
const compiled = new WeakMap<object, JsonSchemaValidator<unknown> | null>();

function validatorFor(schema: Record<string, unknown>): JsonSchemaValidator<unknown> | null {
  if (compiled.has(schema)) return compiled.get(schema) ?? null;
  let validator: JsonSchemaValidator<unknown> | null;
  try {
    provider ??= new AjvJsonSchemaValidator();
    validator = provider.getValidator<unknown>(schema as JsonSchemaType);
  } catch {
    // A schema we cannot compile says nothing about the arguments. The server validates its own
    // input anyway, so this check stays a fast path and never becomes a new way for a tool to fail.
    validator = null;
  }
  compiled.set(schema, validator);
  return validator;
}

// Case, spaces and separators are the slips a model makes in a key (`"body "`, `Body`, `draft-`).
const normalizeKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return row[b.length];
}

export function closestName(key: string, names: string[]): string | undefined {
  const k = normalizeKey(key);
  const exact = names.find((n) => normalizeKey(n) === k);
  if (exact) return exact;
  const ranked = names
    .map((n) => ({ n, d: editDistance(k, normalizeKey(n)) }))
    .filter(({ d }) => d <= 2)
    .sort((a, b) => a.d - b.d);
  return ranked[0]?.n;
}

/**
 * Argument names the schema does not declare. JSON Schema allows extra keys unless the schema says
 * `additionalProperties: false`, and most MCP servers do not say it. But for a tool call an unknown
 * key is a model slip the server drops in silence: `"body ": -6558` validated, and the PR would have
 * opened with no description. A schema that explicitly opens itself (additionalProperties true or a
 * sub-schema, patternProperties) is taken at its word.
 */
function unknownArguments(schema: Record<string, unknown>, args: Record<string, unknown>): string[] {
  const props = schema.properties;
  if (!props || typeof props !== "object") return [];
  const extra = schema.additionalProperties;
  if (extra === true || (typeof extra === "object" && extra !== null) || schema.patternProperties) {
    return [];
  }
  const names = Object.keys(props);
  return Object.keys(args)
    .filter((k) => !names.includes(k))
    .map((k) => {
      const near = closestName(k, names);
      return near
        ? `unknown argument "${k}" (did you mean "${near}"?)`
        : `unknown argument "${k}" (accepted: ${names.join(", ")})`;
    });
}

/**
 * Every way `args` break the tool's schema, one readable line each — empty when they fit, or when
 * there is nothing to check against (no schema, unknown tool, uncompilable schema).
 */
export function mcpArgProblems(tool: McpTool | undefined, args: Record<string, unknown>): string[] {
  if (!tool?.inputSchema) return [];
  const validate = validatorFor(tool.inputSchema);
  if (!validate) return [];

  const unknown = unknownArguments(tool.inputSchema, args);
  const result = validate(args);
  // Ajv names the root "data"; the model knows it as the arguments. Its "must NOT have additional
  // properties" is dropped when the unknown names are reported, because ours says WHICH and what to
  // use instead. Everything is reported at once, so one retry can fix all of it.
  const schemaProblems = result.valid
    ? []
    : result.errorMessage
        .split(", ")
        .filter((p) => !(unknown.length > 0 && /must NOT have additional properties/.test(p)))
        .map((p) => p.replace(/\bdata\//g, "").replace(/\bdata\b/g, "arguments"));
  return [...unknown, ...schemaProblems];
}

/** The error to hand back to the model when `args` do not match the tool's schema, or null. */
export function validateMcpArgs(tool: McpTool | undefined, args: Record<string, unknown>): string | null {
  const problems = mcpArgProblems(tool, args);
  if (problems.length === 0 || !tool) return null;
  return (
    `INVALID ARGUMENTS for ${tool.name}: ${problems.join(", ")}.\n` +
    `Nothing was sent. Fix the arguments to match the tool's schema and call it again.`
  );
}
