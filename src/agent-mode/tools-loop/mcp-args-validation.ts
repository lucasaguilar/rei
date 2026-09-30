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

/**
 * The error to hand back to the model when `args` do not match the tool's schema, or null when they
 * do — or when there is nothing to check against (no schema, unknown tool, uncompilable schema).
 */
export function validateMcpArgs(tool: McpTool | undefined, args: Record<string, unknown>): string | null {
  if (!tool?.inputSchema) return null;
  const validate = validatorFor(tool.inputSchema);
  if (!validate) return null;

  const result = validate(args);
  if (result.valid) return null;

  // Ajv names the root "data"; the model knows it as the arguments.
  const problems = result.errorMessage.replace(/\bdata\//g, "").replace(/\bdata\b/g, "arguments");
  return (
    `INVALID ARGUMENTS for ${tool.name}: ${problems}.\n` +
    `Nothing was sent. Fix the arguments to match the tool's schema and call it again.`
  );
}
