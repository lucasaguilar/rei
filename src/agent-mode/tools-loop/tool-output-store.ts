/**
 * @fileoverview Data-plane sink for tool outputs. Keeps recent tool results in memory so the model
 * can persist their FULL content to a file with `save_tool_output` WITHOUT the bytes passing back
 * through the model (which a backend like MTPLX may truncate). The model stays on the control plane
 * (decides WHAT to fetch and WHERE to save); the runtime moves the bytes.
 *
 * Large outputs are ALSO auto-spilled to `.rei/tool-output/` as a safety net, so a fetched document
 * (e.g. a 10k-char Jira issue) is preserved on disk even if the model only ever sees a truncated view.
 *
 * @module rei/agent-mode/tools-loop/tool-output-store
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface ToolOutputEntry {
  id: string;
  tool: string;
  content: string;
  savedPath?: string;
}

const MAX_ENTRIES = 10; // bounded ring — content is just tool output, memory stays small
let entries: ToolOutputEntry[] = [];
let counter = 0;

/** Records a tool output and returns its short id (referenced by `save_tool_output`). */
export function recordToolOutput(
  tool: string,
  content: string,
  savedPath?: string,
): string {
  const id = `out-${++counter}`;
  entries.push({ id, tool, content, savedPath });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  return id;
}

/** The most recent retained output, or a specific one by id. */
export function getToolOutput(id?: string): ToolOutputEntry | undefined {
  if (id) return entries.find((e) => e.id === id);
  return entries[entries.length - 1];
}

/** Inline char budget before a tool output is spilled to disk (override via env). */
function inlineLimit(): number {
  const n = parseInt(process.env.REI_TOOL_OUTPUT_MAX_INLINE ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

function writeSpillFile(
  workspacePath: string,
  tool: string,
  content: string,
): string {
  const dir = path.join(workspacePath, ".rei", "tool-output");
  fs.mkdirSync(dir, { recursive: true });
  const safe = tool.replace(/[^\w.-]/g, "_");
  const file = path.join(dir, `${safe}-${Date.now()}.md`);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

/**
 * Retains a tool output for later `save_tool_output`, and — if it exceeds the inline budget — spills
 * the FULL content to disk and returns a SHORT receipt (path + id + small preview) for the model
 * instead of the full text. The receipt puts path/id FIRST so it survives an aggressive backend
 * truncation. Small outputs are retained and returned inline unchanged.
 */
export function retainAndMaybeSpill(
  tool: string,
  content: string,
  workspacePath: string,
): string {
  if (content.length <= inlineLimit()) {
    recordToolOutput(tool, content);
    return content;
  }
  const savedPath = writeSpillFile(workspacePath, tool, content);
  const id = recordToolOutput(tool, content, savedPath);
  const preview = content.slice(0, 160).replace(/\s+$/, "");
  return (
    `[REI] Large tool output (${content.length} chars) — full content written to disk:\n` +
    `  path: ${savedPath}\n` +
    `  id:   ${id}\n` +
    `To copy it elsewhere, call save_tool_output(id="${id}", path="<dest>") — the runtime moves the ` +
    `bytes, not through you, so nothing is truncated.\n` +
    `--- preview ---\n${preview}…`
  );
}
