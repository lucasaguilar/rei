/**
 * How an MCP tool is addressed on the wire.
 *
 * REI addresses an MCP tool as `mcp:server/tool`, and the registry is keyed that way. Gemini
 * validates function names against `[A-Za-z0-9_.:-]` and rejects the slash outright — once per MCP
 * tool, so a session with one server produced twenty identical errors and no working request.
 * `__` is the convention other agents use for the same namespacing, and it survives every provider.
 *
 * Only the FIRST separator is translated in each direction: a tool may legitimately contain `__`
 * in its own name, and a server may not contain a slash.
 */
export const MCP_WIRE_SEPARATOR = "__";

/** `mcp:server/tool` → `mcp:server__tool`, for the request payload. */
export function toWireToolName(name: string): string {
  return name.startsWith("mcp:") ? name.replace("/", MCP_WIRE_SEPARATOR) : name;
}

/** The reverse, for whatever name the model calls back with — either form is accepted. */
export function fromWireToolName(name: string): string {
  return name.includes("/") ? name : name.replace(MCP_WIRE_SEPARATOR, "/");
}
