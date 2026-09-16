/**
 * @fileoverview Data-plane sink for tool outputs. Keeps recent tool results in memory so the model
 * can persist their FULL content to a file with `save_tool_output` WITHOUT the bytes passing back
 * through the model (which a backend like MTPLX may truncate). The model stays on the control plane
 * (decides WHAT to fetch and WHERE to save); the runtime moves the bytes.
 *
 * Large outputs are ALSO auto-spilled to a temp directory as a safety net, so a fetched document
 * (e.g. a 10k-char Jira issue) is preserved on disk even if the model only ever sees a truncated view.
 *
 * The spill lives in the OS temp dir, not in `.rei/`: nothing references these files once the
 * process ends (the id→path ring is in memory), so keeping them in the project meant a directory
 * that grew forever with no code anywhere to clean it. The OS already solves that. Verified that
 * `read_files` can still read the path back — it normalises to a `../..` key and resolves — so the
 * model can recover the full text, while writes outside the workspace stay refused.
 *
 * ONE directory per process, not one per call: `save_tool_output(id)` resolves a path recorded
 * earlier in the session, so the location has to outlive the call that created it.
 *
 * @module rei/agent-mode/tools-loop/tool-output-store
 */

import * as fs from "node:fs";
import * as os from "node:os";
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

/**
 * Inline char budget before a tool output is spilled to disk (override via env).
 *
 * It is a BUDGET, so `0` means exactly that: no output travels inline, everything goes to disk and
 * the model gets the receipt (plus whatever REI_TOOL_OUTPUT_PREVIEW allows — set that to 0 too for
 * the receipt alone). That is the aggressive end of the knob, for answering "how much does the
 * model actually need to see?".
 *
 * The guard used to be `n > 0`, so 0 fell through to the 2000 default and the setting looked broken
 * rather than ignored. A negative or unparseable value is still a mistake, and still falls back.
 */
function inlineLimit(): number {
  const raw = process.env.REI_TOOL_OUTPUT_MAX_INLINE?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 2000;
}

/**
 * How much of a spilled output is echoed back to the model. 160 chars was far too little: for JSON
 * it showed only the opening metadata (`{"expand":"renderedFields,names,…`) and for prose it cut off
 * mid-sentence, so the model could not tell what it had fetched and re-read the whole file to find
 * out. 2000 matches the ~2KB preview other agents converged on. Override with
 * REI_TOOL_OUTPUT_PREVIEW. `0` shows the receipt alone, with no excerpt.
 */
function previewLimit(): number {
  const raw = process.env.REI_TOOL_OUTPUT_PREVIEW?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 2000;
}

let spillDir: string | undefined;

/** The session's spill directory, created on first use. `REI_TOOL_OUTPUT_DIR` overrides it — set it
 *  to a path inside the project when you want the outputs to survive for a post-mortem. */
function ensureSpillDir(): string {
  const configured = process.env.REI_TOOL_OUTPUT_DIR?.trim();
  if (configured) {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  }
  if (!spillDir) spillDir = fs.mkdtempSync(path.join(os.tmpdir(), "rei-tool-output-"));
  return spillDir;
}

function writeSpillFile(tool: string, content: string): string {
  const safe = tool.replace(/[^\w.-]/g, "_");
  const file = path.join(ensureSpillDir(), `${safe}-${Date.now()}.md`);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

/**
 * Retains a tool output for later `save_tool_output`, and — if it exceeds the inline budget — spills
 * the FULL content to disk and returns a SHORT receipt (path + id + small preview) for the model
 * instead of the full text. The receipt puts path/id FIRST so it survives an aggressive backend
 * truncation. Small outputs are retained and returned inline unchanged.
 */
export function retainAndMaybeSpill(tool: string, content: string): string {
  if (content.length <= inlineLimit()) {
    recordToolOutput(tool, content);
    return content;
  }
  const savedPath = writeSpillFile(tool, content);
  const id = recordToolOutput(tool, content, savedPath);
  const shown = content.slice(0, previewLimit()).replace(/\s+$/, "");
  // Exact counts, in LINES as well as chars. A model deciding whether to fetch the rest needs to
  // know how much it is missing; "some output was omitted" is not a basis for that decision.
  const totalLines = content.split("\n").length;
  const shownLines = shown.split("\n").length;
  return (
    `[REI] Large tool output truncated: showing ${shownLines} of ${totalLines} lines ` +
    `(${shown.length} of ${content.length} chars). Full output saved to:\n` +
    `  path: ${savedPath}\n` +
    `  id:   ${id}\n` +
    `Read it with read_files("${savedPath}"), or copy it elsewhere with ` +
    `save_tool_output(id="${id}", path="<dest>") — the runtime moves the bytes, not through you, ` +
    `so nothing is truncated.\n` +
    `--- preview ---\n${shown}`
  );
}

