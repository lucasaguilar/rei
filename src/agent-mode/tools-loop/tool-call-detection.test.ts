import { describe, it, expect } from "vitest";
import { looksLikeAttemptedToolCall } from "./tool-call-detection.js";

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
