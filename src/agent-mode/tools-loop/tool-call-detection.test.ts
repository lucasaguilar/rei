import { describe, it, expect } from "vitest";
import {
  looksLikeAttemptedToolCall,
  looksLikeUnfulfilledAnnouncement,
} from "./tool-call-detection.js";

describe("looksLikeAttemptedToolCall", () => {
  it("flags a bare faked tool call (the whole message is the call)", () => {
    expect(looksLikeAttemptedToolCall("<read_files>src/foo.ts</read_files>")).toBe(true);
    expect(looksLikeAttemptedToolCall("<edit_file>foo</edit_file>")).toBe(true);
    expect(looksLikeAttemptedToolCall("<parameter=path>src/x.ts</parameter>")).toBe(true);
  });

  it("flags a leading tag even after a tiny preamble / markdown", () => {
    expect(
      looksLikeAttemptedToolCall("Sure, let me read it: <read_files>src/a.ts</read_files>"),
    ).toBe(true);
    expect(looksLikeAttemptedToolCall("- <run_command>npm test</run_command>")).toBe(true);
  });

  it("does NOT flag a real analysis that merely MENTIONS the tags (the regression)", () => {
    const analysis =
      "Ahora tengo ambos archivos completos. Aquí va la comparación directa:\n\n---\n\n" +
      "## Diferencia de lógica de negocio: generator.ts maneja bloques <edit> y <wholefile>, " +
      "mientras que generator-tools.ts usa edit_file vía tool calls nativas.";
    expect(looksLikeAttemptedToolCall(analysis)).toBe(false);
  });

  it("ignores tags quoted inside Markdown code (fences and inline spans)", () => {
    expect(
      looksLikeAttemptedToolCall("El loop procesa `<request_files>` y `<call_tool>` en el path XML."),
    ).toBe(false);
    expect(
      looksLikeAttemptedToolCall(
        "```xml\n<edit><file>a.ts</file></edit>\n```\nEso es un ejemplo de cómo se ve un edit en el path XML.",
      ),
    ).toBe(false);
  });

  it("returns false for empty/plain content", () => {
    expect(looksLikeAttemptedToolCall("")).toBe(false);
    expect(looksLikeAttemptedToolCall("Listo, apliqué los cambios.")).toBe(false);
  });
});

describe("looksLikeUnfulfilledAnnouncement", () => {
  it("flags a short announcement of investigation with no tool call (the real bug)", () => {
    expect(
      looksLikeUnfulfilledAnnouncement(
        "Vamos a hacerlo. Primero leamos los archivos clave para armar el plan preciso.",
      ),
    ).toBe(true);
    expect(
      looksLikeUnfulfilledAnnouncement("Let me read the relevant files first."),
    ).toBe(true);
    expect(looksLikeUnfulfilledAnnouncement("Voy a revisar el código.")).toBe(true);
  });

  it("does NOT flag a real completed plan (has Stage headers / is long)", () => {
    const plan =
      "## Stage 1: Setup\nFiles to modify: src/a.ts\n\n## Stage 2: Wire it\nFiles to modify: src/b.ts";
    expect(looksLikeUnfulfilledAnnouncement(plan)).toBe(false);
  });

  it("does NOT flag a normal answer that merely mentions reading a file", () => {
    expect(
      looksLikeUnfulfilledAnnouncement(
        "El archivo config.ts define las variables de entorno y se lee al arrancar.",
      ),
    ).toBe(false);
    expect(looksLikeUnfulfilledAnnouncement("")).toBe(false);
  });

  it("does NOT flag a long substantive response even if it opens with intent", () => {
    const long = "Voy a leer el código. " + "Detalle técnico. ".repeat(40);
    expect(looksLikeUnfulfilledAnnouncement(long)).toBe(false);
  });
});
