import { describe, it, expect } from "vitest";
import { capReply, formatReply } from "./reply-format.js";

/**
 * A public channel's reply leaves as the channel can show it. The model writes markdown out of
 * habit; the widget shows text as typed (`**Plan Pro**` arrives with its asterisks) and WhatsApp has
 * its own markup (`*bold*`, `_italic_`) and no headings, tables or links.
 */

const MD = [
  "## Nuestros planes",
  "",
  "El **Plan Pro** es *ideal* para equipos. Ver [precios](https://example.com/p).",
  "",
  "| Plan | Canal |",
  "|---|---|",
  "| Pro | WhatsApp |",
  "",
  "* uno",
  "- dos",
  "> cita",
  "Usá `rei ask`.",
].join("\n");

describe("formatReply — plain (the web widget)", () => {
  it("drops the markup and keeps the text", () => {
    expect(formatReply(MD, "plain")).toBe(
      [
        "Nuestros planes",
        "",
        "El Plan Pro es ideal para equipos. Ver precios: https://example.com/p.",
        "",
        "Plan · Canal",
        "Pro · WhatsApp",
        "",
        "- uno",
        "- dos",
        "cita",
        "Usá rei ask.",
      ].join("\n"),
    );
  });

  it("keeps a code block's content without its fences, and collapses runs of blank lines", () => {
    expect(formatReply("Mirá:\n\n\n\n```js\nconst a = 1;\n```\nListo.", "plain")).toBe(
      "Mirá:\n\nconst a = 1;\nListo.",
    );
  });

  it("skips a table's empty cells — a comparison's header often starts with one", () => {
    expect(formatReply("| | Cloud | Enterprise |\n|---|---|---|\n| Dónde | Nube | Tuyo |", "plain")).toBe(
      "Cloud · Enterprise\nDónde · Nube · Tuyo",
    );
  });

  it("shows a bare link once", () => {
    expect(formatReply("[https://a.dev](https://a.dev)", "plain")).toBe("https://a.dev");
  });

  it("leaves text without markup alone — snake_case and 2*3 included", () => {
    const text = "El valor de max_reply es 2*3, o sea 6.";
    expect(formatReply(text, "plain")).toBe(text);
  });
});

describe("formatReply — whatsapp", () => {
  it("translates to WhatsApp's markup", () => {
    expect(formatReply(MD, "whatsapp")).toBe(
      [
        "*Nuestros planes*",
        "",
        "El *Plan Pro* es _ideal_ para equipos. Ver precios: https://example.com/p.",
        "",
        "Plan · Canal",
        "Pro · WhatsApp",
        "",
        "- uno",
        "- dos",
        "cita",
        "Usá `rei ask`.",
      ].join("\n"),
    );
  });
});

describe("capReply", () => {
  it("leaves a reply within the cap, or a little over it, alone", () => {
    expect(capReply("Hola. ¿Qué tal?", 100)).toBe("Hola. ¿Qué tal?");
    // The model is asked for "about" the cap: a reply slightly over it keeps its closing question.
    const near = `${"a".repeat(105)}. ¿Te paso una propuesta?`;
    expect(capReply(near, 110)).toBe(near);
  });

  it("cuts a long reply at the last sentence that fits", () => {
    const text = `Primera frase. Segunda frase. ${"x".repeat(200)}`;
    expect(capReply(text, 40)).toBe("Primera frase. Segunda frase.");
  });

  it("cuts at a word, with an ellipsis, when no sentence ends in the first half", () => {
    const out = capReply(`${"palabra ".repeat(30)}fin.`, 40);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(out).not.toMatch(/ …$/);
  });

  it("does nothing without a cap", () => {
    const long = "x".repeat(5000);
    expect(capReply(long, undefined)).toBe(long);
  });
});
