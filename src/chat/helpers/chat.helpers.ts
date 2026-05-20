import { EXPLICIT_CONTENT_REQUEST_PATTERN } from "../../context/constants/context-builder.constants.js";
import { slimCode } from "./compression.js";
import { deepMinify } from "./minifier.js";

/**
 * Orchestrates the compression strategy based on user intent and content type.
 * If the user asks for "exact code", it avoids aggressive minification to preserve
 * the structure needed for precise edits.
 */
export async function smartCompress(
  text: string,
  userInput: string,
  language: string,
): Promise<string> {
  const isExactRequest = EXPLICIT_CONTENT_REQUEST_PATTERN.test(userInput);

  if (isExactRequest) {
    return slimCode(text);
  }

  const slimmed = slimCode(text);
  return deepMinify(slimmed, language);
}

export function lightweightCompress(text: string): string {
  if (text.length < 1000) return text;

  return (
    text
      // 1. Eliminar comentarios multilínea (opcional, pero ahorra mucho)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // 2. Colapsar espacios en blanco y tabs a un solo espacio
      .replace(/[ \t]+/g, " ")
      // 3. Eliminar líneas en blanco redundantes
      .replace(/\n\s*\n/g, "\n")
      // 4. Stop-words de lenguaje natural (solo en partes que NO sean código)
      // Nota: Esto es simplificado. Evitamos tocar palabras que parezcan código.
      .replace(
        /\b(procedemos a|a continuación|voy a|estoy de acuerdo con)\b/gi,
        "",
      )
      // 5. Acortar indentación extrema
      .replace(/^\s+/gm, (match) => " ".repeat(Math.ceil(match.length / 4)))
      .trim()
  );
}
