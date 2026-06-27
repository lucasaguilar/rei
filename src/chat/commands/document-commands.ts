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

const READ_RE = /^\/(?:read-document|readdoc)\s+(\S+)(?:\s+([\s\S]+))?$/;
const ASK_RE = /^\/(?:ask-document|askdoc)\s+(\S+)\s+([\s\S]+)$/;

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
      const fileArg = readMatch[1].replace(/^@/, "");
      const rangeText = readMatch[2]?.trim() ?? "";
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
      const fileArg = askMatch[1].replace(/^@/, "");
      const question = askMatch[2].trim();
      const filePath = path.isAbsolute(fileArg)
        ? fileArg
        : path.resolve(workspacePath, fileArg);
      if (!fs.existsSync(filePath)) {
        return { success: false, response: `[REI] File not found: ${fileArg}` };
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
