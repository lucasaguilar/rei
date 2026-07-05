import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandHandler, CommandResult } from "./command-handler.js";
import {
  askDocument,
  sliceDocument,
  parsePageSpec,
} from "../../skills/ask-document/index.js";
import type { AskResult } from "../../skills/ask-document/index.js";

/** Renders an ask-document result: answer + per-claim citations (✅ verified / ≈ fuzzy / ⚠️ unverified). */
function formatAskResult(r: AskResult): string {
  const lines: string[] = [r.answer.trim()];
  if (r.claims.length > 0) {
    lines.push("", "Citas:");
    for (const c of r.claims) {
      if (c.status === "fabricated") {
        lines.push(`- ⚠️  ${c.text}${c.page ? ` (p.${c.page}?)` : ""} — NO verificado en el texto`);
      } else {
        const mark = c.status === "verified" ? "✅" : "≈";
        const q = c.quote ? `"${c.quote.slice(0, 280)}"` : c.text;
        lines.push(`- ${mark} ${q}${c.page ? ` (p.${c.page})` : ""}`);
      }
    }
    lines.push(
      "",
      `Fidelidad: ${r.faithfulness.verified}/${r.faithfulness.total} afirmaciones verificadas` +
        `${r.sources.length ? ` · páginas consultadas: ${r.sources.join(", ")}` : ""}.`,
    );
  } else if (r.notFound) {
    lines.push("", "(No se encontró respuesta en el texto recuperado.)");
  }
  // Same magenta "REI" badge as a normal answer so it reads as REI's response, not plain output.
  return `\x1b[1;97;45m REI \x1b[0m ${lines.join("\n")}`;
}

const READ_RE = /^\/(?:read-document|readdoc)\s+([\s\S]+)$/;
const ASK_RE = /^\/(?:ask-document|askdoc)\s+([\s\S]+)$/;

/**
 * Splits a command's argument string into `<file>` and the trailing text (a question or a
 * page-range), tolerating file paths that contain SPACES, are quoted, or are `@`-prefixed (the
 * `@file` picker inserts `@path`). A bare `(\S+)` capture broke on real names like
 * "ocr/guia escaneada.ocr.md" — it stopped at the first space, so the file resolved to "ocr/guia".
 * Strategy: honor quotes first; otherwise strip a leading `@` and take the LONGEST leading
 * substring that resolves to an existing file (probe the filesystem at each word boundary), so the
 * split lands right after the real filename. Falls back to first-word when nothing exists on disk.
 */
export function splitFileAndRest(
  args: string,
  workspacePath: string,
): { file: string; rest: string } {
  const trimmed = args.trim();

  const quoted = trimmed.match(/^(['"])(.+?)\1\s*([\s\S]*)$/);
  if (quoted) return { file: quoted[2], rest: quoted[3].trim() };

  const raw = trimmed.replace(/^@/, "");
  const isFile = (p: string): boolean => {
    try {
      const abs = path.isAbsolute(p) ? p : path.resolve(workspacePath, p);
      return fs.statSync(abs).isFile();
    } catch {
      return false;
    }
  };

  let best: { file: string; rest: string } | null = null;
  const boundary = /\S\s/g; // a non-space immediately followed by a space = a candidate cut point
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(raw)) !== null) {
    const cut = m.index + 1;
    if (isFile(raw.slice(0, cut))) {
      best = { file: raw.slice(0, cut), rest: raw.slice(cut).trim() };
    }
  }
  if (isFile(raw)) best = { file: raw, rest: "" }; // whole arg is the file (no trailing text)
  if (best) return best;

  const fm = raw.match(/^(\S+)\s*([\s\S]*)$/);
  return fm ? { file: fm[1], rest: fm[2].trim() } : { file: raw, rest: "" };
}

/**
 * `/ask-document <file> <question>` — grounded Q&A with verified citations.
 * `/read-document <file> [pp.N-M | p.N | first N]` — literal page-range slice of a large doc.
 * Extracted verbatim from menu-command-processor (Phase 1 of the refactor — no behavior change).
 */
export const documentCommands: CommandHandler = {
  match: (c) => READ_RE.test(c) || ASK_RE.test(c),

  run: async ({ command, workspacePath, provider, onStatus }): Promise<CommandResult> => {
    const readMatch = command.match(READ_RE);
    if (readMatch) {
      const { file: fileArg, rest: rangeText } = splitFileAndRest(
        readMatch[1],
        workspacePath,
      );
      const filePath = path.isAbsolute(fileArg)
        ? fileArg
        : path.resolve(workspacePath, fileArg);
      if (!fs.existsSync(filePath)) {
        return { success: false, response: `[REI] File not found: ${fileArg}` };
      }
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const slice = sliceDocument(raw, rangeText ? parsePageSpec(rangeText) : undefined);
        if (!slice.text) {
          return {
            success: false,
            response: `[REI] No pages matched "${rangeText || "(default)"}" in ${path.basename(filePath)}.`,
          };
        }
        const where = slice.pages.some((p) => p > 0)
          ? `pág. ${slice.pages.join(", ")}`
          : "documento";
        return {
          success: true,
          response: `\x1b[1;97;45m REI \x1b[0m ${path.basename(filePath)} — ${where}:\n\n${slice.text}`,
          recordInSession: true,
        };
      } catch (err) {
        return {
          success: false,
          response: `[REI] read-document failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const askMatch = command.match(ASK_RE);
    if (askMatch) {
      const { file: fileArg, rest: question } = splitFileAndRest(
        askMatch[1],
        workspacePath,
      );
      const filePath = path.isAbsolute(fileArg)
        ? fileArg
        : path.resolve(workspacePath, fileArg);
      if (!fs.existsSync(filePath)) {
        return { success: false, response: `[REI] File not found: ${fileArg}` };
      }
      if (!question) {
        return {
          success: false,
          response: `[REI] ask-document needs a question: /ask-document <file> <question>`,
        };
      }
      try {
        const result = await askDocument({
          filePath,
          question,
          provider,
          workspacePath,
          onStatus,
        });
        return { success: true, response: formatAskResult(result), recordInSession: true };
      } catch (err) {
        return {
          success: false,
          response: `[REI] ask-document failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Unreachable: match() guarantees one of the regexes above handled it.
    return { success: false, response: "[REI] Unknown document command." };
  },
};
