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

export function compressSkeletonMap(content: string): string {
  return (
    content
      // 1. Convertir rutas absolutas en relativas o solo el nombre del archivo
      .replace(/\/Users\/lucasaguilar\/www\/lab\/rei\//g, "./")
      // 2. Acortar imports internos que ensucian las firmas
      .replace(/import\(".*?"\)\./g, "")
      // 3. Eliminar comentarios explicativos del mapa (Source: X)
      .replace(/\/\/ \.*$/gm, "")
      .trim()
  );
}

export function slimCode(text: string): string {
  return (
    text
      // 1. Elimina comentarios de una línea y multilínea
      .replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, "$1")
      // 2. Colapsa espacios en blanco (mantiene indentación mínima de 2)
      .replace(/[ \t]{3,}/g, "  ")
      // 3. Elimina líneas vacías
      .replace(/^\s*[\r\n]/gm, "")
      .trim()
  );
}
