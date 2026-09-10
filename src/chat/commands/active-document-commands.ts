import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandHandler, CommandContext, CommandResult } from "./command-handler.js";
import { splitFileAndRest } from "./document-commands.js";
import { scanWorkspace } from "../../workspace/workspace-scanner.js";

/**
 * Active-document commands. A document (its OCR/text artifact) can be "active" so `/ask-document`
 * targets it without repeating the path. It auto-activates when a PDF finishes OCR; these commands
 * let the user inspect, switch, and clear it.
 *
 *   /docs              list the workspace's text docs, marking the active one
 *   /doc               show the active document
 *   /doc use <file>    activate <file> (paths with spaces / @ are fine)
 *   /doc clear|off     deactivate (back to normal chat)
 */
const DOCS_RE = /^\/docs\s*$/;
const DOC_RE = /^\/doc(?:\s+([\s\S]+))?$/;

const REI = "\x1b[1;97;45m REI \x1b[0m";

/** Text documents in the workspace worth listing (OCR output lives in ocr/*.ocr.md). */
function listTextDocs(workspacePath: string): string[] {
  const docs = scanWorkspace(workspacePath)
    .filter((f) => f.extension === ".md" || f.extension === ".txt")
    .map((f) => f.path);
  // Prefer OCR artifacts (ocr/ dir or *.ocr.md) when there are any — they're what /ask-document uses.
  const ocr = docs.filter((d) => d.startsWith("ocr/") || d.endsWith(".ocr.md"));
  return (ocr.length > 0 ? ocr : docs).sort((a, b) => a.localeCompare(b));
}

/** Activate a file (resolved against the workspace). Returns the stored (relative) path or null. */
function activate(session: CommandContext["session"], file: string, workspacePath: string): string | null {
  const abs = path.isAbsolute(file) ? file : path.resolve(workspacePath, file);
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  const rel = path.relative(workspacePath, abs);
  const stored = !rel || rel.startsWith("..") ? abs : rel;
  session.activeDocument = stored;
  return stored;
}

export const activeDocumentCommands: CommandHandler = {
  match: (c) => DOCS_RE.test(c) || DOC_RE.test(c),

  run: ({ command, session, workspacePath }: CommandContext): CommandResult => {
    // /docs → list
    if (DOCS_RE.test(command)) {
      const docs = listTextDocs(workspacePath);
      if (docs.length === 0) {
        return {
          success: true,
          recordInSession: false,
          response: `[REI] No text documents (.md/.txt) in this workspace. Drop a PDF in to OCR it.`,
        };
      }
      const lines = docs.map((d) => `  ${d === session.activeDocument ? "▶" : " "} ${d}`);
      const header = session.activeDocument
        ? `Active: ${session.activeDocument}`
        : "None active";
      return {
        success: true,
        recordInSession: false,
        response:
          `${REI} ${header}\n\n${lines.join("\n")}\n\n` +
          `(/doc use <file> to activate · /doc clear to deactivate)`,
      };
    }

    const arg = command.match(DOC_RE)?.[1]?.trim() ?? "";

    // /doc → show current
    if (!arg) {
      return {
        success: true,
        recordInSession: false,
        response: session.activeDocument
          ? `${REI} 📄 Active document: ${session.activeDocument}`
          : `[REI] No active document. Use /doc use <file>, or drop a PDF in to OCR it.`,
      };
    }

    // /doc clear | off | none → deactivate
    if (/^(clear|off|none)$/i.test(arg)) {
      const prev = session.activeDocument;
      session.activeDocument = undefined;
      return {
        success: true,
        recordInSession: false,
        response: prev
          ? `${REI} Document deactivated (${prev}). Back to normal chat.`
          : `[REI] There was no active document.`,
      };
    }

    // /doc use <file>  (also accept "/doc <file>" as a shorthand)
    const rawFile = arg.match(/^use\s+([\s\S]+)$/i)?.[1] ?? arg;
    const { file } = splitFileAndRest(rawFile, workspacePath);
    const stored = activate(session, file, workspacePath);
    return stored
      ? { success: true, recordInSession: false, response: `${REI} 📄 Active document: ${stored}` }
      : { success: false, recordInSession: false, response: `[REI] File not found: ${file}` };
  },
};
