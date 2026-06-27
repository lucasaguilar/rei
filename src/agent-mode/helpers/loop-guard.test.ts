import { describe, it, expect, afterEach } from "vitest";
import { isDegenerate, degenerateNotice } from "./loop-guard.js";

describe("isDegenerate", () => {
  it("returns false for short text", () => {
    expect(isDegenerate("too short to judge")).toBe(false);
  });

  it("flags a real back-to-back repetition loop", () => {
    // The model gets stuck emitting the same phrase adjacently.
    const loop = ("I will check the file now. ").repeat(10);
    expect(isDegenerate(loop)).toBe(true);
  });

  it("flags a tightly repeated short phrase", () => {
    expect(isDegenerate("I am the one. ".repeat(20))).toBe(true);
  });

  it("does NOT flag parallel acceptance-criteria (the false positive)", () => {
    // Same phrasing reused across sections, but separated by lots of other text.
    const section = (name: string, badge: string) =>
      `### ${name}\n` +
      `1. El icono info y el titulo aparecen en la misma fila horizontal con gap de 12px aqui.\n` +
      `2. Hay un header-right visible con un badge ${badge} alineado a la derecha del bloque.\n` +
      `3. El subtitle descriptivo aparece debajo del titulo como bloque separado ancho completo.\n` +
      `4. El texto de version ya no esta flotando dentro del header sino integrado al footer.\n` +
      `5. No hay un wrapper de card innecesario alrededor del header del layout principal.\n`;
    const spec = ["About", "Settings", "Dashboard", "Market", "Reports"]
      .map((s, i) => section(s, `B${i}`))
      .join("\n");
    expect(isDegenerate(spec)).toBe(false);
  });

  it("does NOT flag an ASCII-art / text logo (the false positive)", () => {
    const logo =
      "Acá tu logo en texto:\n\n" +
      "██████╗ ███████╗██╗\n" +
      "██╔══██╗██╔════╝██║\n" +
      "██████╔╝█████╗  ██║\n" +
      "██╔══██╗██╔══╝  ██║\n" +
      "██║  ██║███████╗██║\n" +
      "╚═╝  ╚═╝╚══════╝╚═╝\n";
    expect(isDegenerate(logo)).toBe(false);
  });

  it("does NOT flag a box-drawing table", () => {
    const table =
      "| col a | col b |\n|-------|-------|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n| 7 | 8 |\n" +
      "═══════════════════════════════════════════════════════════════════════";
    expect(isDegenerate(table)).toBe(false);
  });

  it("does NOT flag normal varied prose", () => {
    const prose =
      "The dashboard renders a header with the title and an info icon. " +
      "Below it, a grid of cards shows market data refreshed every few seconds. " +
      "Settings live behind a gear icon that opens a side panel for API keys.";
    expect(isDegenerate(prose)).toBe(false);
  });
});

describe("degenerateNotice (provider-agnostic)", () => {
  const saved = process.env.MODEL_PROVIDER;
  afterEach(() => {
    if (saved === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = saved;
  });

  it("never blindly recommends OLLAMA_NUM_CTX", () => {
    for (const p of ["llmstudio", "ollama", "openrouter", "gemini", undefined]) {
      if (p === undefined) delete process.env.MODEL_PROVIDER;
      else process.env.MODEL_PROVIDER = p;
      expect(degenerateNotice()).not.toContain("OLLAMA_NUM_CTX");
    }
  });

  it("gives LM Studio sampling knobs by default (provider unset)", () => {
    delete process.env.MODEL_PROVIDER;
    const msg = degenerateNotice();
    expect(msg).toContain("LLM_STUDIO_FREQUENCY_PENALTY");
    expect(msg).toContain("larger model");
  });

  it("names the Ollama repeat-penalty knob for ollama", () => {
    process.env.MODEL_PROVIDER = "ollama";
    expect(degenerateNotice()).toContain("OLLAMA_REPEAT_PENALTY");
  });

  it("suggests retry/switch model for cloud (no local sampling knobs)", () => {
    process.env.MODEL_PROVIDER = "openrouter";
    const msg = degenerateNotice();
    expect(msg).toContain("different model");
    expect(msg).not.toContain("LLM_STUDIO");
  });
});
