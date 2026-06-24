import { describe, it, expect } from "vitest";
import { formatSourcesList } from "./search-tool.js";

describe("formatSourcesList", () => {
  it("builds a numbered list of title — url", () => {
    const out = formatSourcesList([
      { title: "TechCrunch: AI news", url: "https://techcrunch.com/a" },
      { title: "The Verge: AI", url: "https://theverge.com/b" },
    ]);
    expect(out).toContain("1. TechCrunch: AI news — https://techcrunch.com/a");
    expect(out).toContain("2. The Verge: AI — https://theverge.com/b");
    expect(out).toMatch(/do NOT invent or alter links/i);
  });

  it("dedupes repeated URLs", () => {
    const out = formatSourcesList([
      { title: "A", url: "https://x.com/1" },
      { title: "A again", url: "https://x.com/1" },
      { title: "B", url: "https://x.com/2" },
    ]);
    expect(out).toContain("1. A — https://x.com/1");
    expect(out).toContain("2. B — https://x.com/2");
    expect(out).not.toContain("3.");
  });

  it("skips entries without a URL", () => {
    const out = formatSourcesList([
      { title: "no link" },
      { title: "C", url: "  " },
      { title: "D", url: "https://x.com/d" },
    ]);
    expect(out).toContain("1. D — https://x.com/d");
    expect(out).not.toContain("2.");
  });

  it("falls back to the URL as the label when title is missing", () => {
    const out = formatSourcesList([{ url: "https://x.com/e" }]);
    expect(out).toContain("1. https://x.com/e — https://x.com/e");
  });

  it("returns an empty string when there are no usable URLs", () => {
    expect(formatSourcesList([])).toBe("");
    expect(formatSourcesList([{ title: "x" }, { url: "" }])).toBe("");
  });
});
