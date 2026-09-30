/**
 * What to tell the model when its MCP call fails schema validation — and how to escalate when it
 * makes the SAME mistake again.
 *
 * Seen live: 8 rejections of list_pull_requests (`heads`, `state_filter`), then 11 of
 * create_pull_request (`bodyType`), each with an error naming the right key. The reasoning said
 * "the key is `body`" and the call said `bodyType` again: a local model copies its own previous call
 * from the history more readily than it follows an instruction. So the error carries a CORRECTED
 * call to copy instead, and a mistake that survives that is stopped, not retried until MAX_TURNS.
 */
import type { McpTool } from "../../tools/mcp/mcp-client.js";
import { closestName, mcpArgProblems } from "./mcp-args-validation.js";

/** The identical mistake is stopped on this attempt, and counted as a blocked repeat. */
const STOP_AT_ATTEMPT = 3;

function schemaOf(tool: McpTool): { props: Record<string, { type?: unknown }>; required: string[] } {
  const s = tool.inputSchema ?? {};
  const props =
    s.properties && typeof s.properties === "object"
      ? (s.properties as Record<string, { type?: unknown }>)
      : {};
  return { props, required: Array.isArray(s.required) ? (s.required as string[]) : [] };
}

const placeholder = (prop: { type?: unknown } | undefined) =>
  `<${typeof prop?.type === "string" ? prop.type : "value"}>`;

/**
 * The model's arguments made to fit the schema as far as can be done without guessing: a mistyped
 * key is renamed to the one it was mistaken for (value kept), a key that maps to nothing is dropped,
 * and a wrong-typed or missing value becomes a `<type>` placeholder — never the wrong value again.
 */
export function correctedMcpArgs(tool: McpTool, args: Record<string, unknown>): Record<string, unknown> {
  const { props, required } = schemaOf(tool);
  const names = Object.keys(props);
  const out: Record<string, unknown> = {};
  const renamed: Array<[string, unknown]> = [];

  for (const [key, value] of Object.entries(args)) {
    if (names.includes(key)) out[key] = value;
    else {
      const near = closestName(key, names);
      if (near) renamed.push([near, value]);
    }
  }
  // A key the model already set correctly wins over a mistyped duplicate of it.
  for (const [key, value] of renamed) if (!(key in out)) out[key] = value;

  // Top-level type errors read "<key> must be <type>" once validation has named them.
  for (const problem of mcpArgProblems(tool, out)) {
    const m = /^([^\s/]+) must be /.exec(problem);
    if (m && m[1] in out) out[m[1]] = placeholder(props[m[1]]);
  }
  for (const key of required) if (!(key in out)) out[key] = placeholder(props[key]);
  return out;
}

export interface InvalidMcpCall {
  /** The tool result handed back to the model instead of running the call. */
  message: string;
  /** True once the same mistake has been stopped: the loop counts it with the blocked repeats. */
  repeatBlocked: boolean;
}

/**
 * Validates an MCP call and escalates a repeated mistake. `history` counts rejections per tool and
 * problem for the whole run — the problem, not the exact arguments, because the model varied the
 * body text between retries while keeping `bodyType`.
 */
export function checkMcpCall(
  tool: McpTool | undefined,
  args: Record<string, unknown>,
  history: Map<string, number>,
): InvalidMcpCall | null {
  const problems = mcpArgProblems(tool, args);
  if (!tool || problems.length === 0) return null;

  const key = `${tool.name}\n${problems.join("\n")}`;
  const attempt = (history.get(key) ?? 0) + 1;
  history.set(key, attempt);

  const what = `INVALID ARGUMENTS for ${tool.name}: ${problems.join(", ")}. Nothing was sent.`;
  const fixed = JSON.stringify(correctedMcpArgs(tool, args), null, 2);

  if (attempt >= STOP_AT_ATTEMPT) {
    return {
      repeatBlocked: true,
      message:
        `${what}\nThis is attempt ${attempt} with the same problem. Stop calling ${tool.name} this ` +
        `turn: another retry will fail the same way. In your final answer, tell the user what you ` +
        `were trying to do and that the call was rejected.`,
    };
  }
  if (attempt === 2) {
    return {
      repeatBlocked: false,
      message:
        `${what}\nYou sent the SAME invalid arguments again. Do NOT copy your previous call from ` +
        `the history — copy this one instead (replace any <type> placeholder with a real value):\n` +
        fixed,
    };
  }
  return {
    repeatBlocked: false,
    message:
      `${what}\nCall it again with these arguments (replace any <type> placeholder with a real ` +
      `value):\n${fixed}`,
  };
}
