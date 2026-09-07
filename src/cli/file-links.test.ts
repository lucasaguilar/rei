import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveLinkTarget, linkPathsInText } from "./file-links.js";
import { buildFileMatcherRegex } from "../language/language-capabilities.js";

// eslint-disable-next-line no-control-regex
const linked = (s: string): string[] => [...s.matchAll(/\x1b\]8;;file:\/\/([^\x1b]*)/g)].map((m) => m[1]);
// eslint-disable-next-line no-control-regex
const strip = (s: string): string =>
  s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "");

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.REI_HYPERLINKS;
  process.env.REI_HYPERLINKS = "on";
});
afterEach(() => {
  if (saved === undefined) delete process.env.REI_HYPERLINKS;
  else process.env.REI_HYPERLINKS = saved;
});

/**
 * One definition of "this is a file", shared by the table path and the prose path. They used to
 * disagree — one required a slash, the other an extension — so a file linked inside a table stayed
 * dead text one line above it.
 */
describe("resolveLinkTarget", () => {
  const root = process.cwd();

  it("resolves a real file to an absolute path", () => {
    expect(resolveLinkTarget("package.json", root)?.endsWith("/package.json")).toBe(true);
    expect(resolveLinkTarget("src/cli/file-links.ts", root)).toBeTruthy();
  });

  it("refuses a file that is not there", () => {
    expect(resolveLinkTarget("src/nope.ts", root)).toBeNull();
  });

  it("refuses a directory — a link must open something", () => {
    expect(resolveLinkTarget("src/cli", root)).toBeNull();
  });

  it("refuses prose that merely contains a path", () => {
    expect(resolveLinkTarget("ver package.json ahi", root)).toBeNull();
  });
});

describe("linkPathsInText", () => {
  it("links a path written in prose", () => {
    const out = linkPathsInText("El arreglo está en package.json.", process.cwd());
    expect(linked(out)).toHaveLength(1);
  });

  it("links a path inside inline code, colour codes and all", () => {
    // `\x1b[36m` ends in "36m", and 3/6/m are word characters: the pattern swallowed them and
    // looked for "36mpackage.json", so paths in inline code — how REI writes most of them — never
    // linked. Colour codes are split off before matching.
    const out = linkPathsInText("Ver \x1b[36mpackage.json\x1b[0m aca.", process.cwd());
    expect(linked(out)).toHaveLength(1);
    expect(out).toContain("\x1b[36m"); // the colour survives
  });

  it("leaves the visible text exactly as it was", () => {
    const src = "Ver package.json y src/cli/file-links.ts aca.";
    expect(strip(linkPathsInText(src, process.cwd()))).toBe(src);
  });

  it("does not link a path that does not exist", () => {
    expect(linked(linkPathsInText("Ver src/fantasma.ts aca.", process.cwd()))).toHaveLength(0);
  });

  it("leaves an already-linked region alone", () => {
    // A table resolves its own shortened paths; wrapping a link inside a link produces neither.
    const pre = linkPathsInText("Ver package.json aca.", process.cwd());
    expect(linked(linkPathsInText(pre, process.cwd()))).toHaveLength(1);
  });

  it("emits nothing when hyperlinks are off", () => {
    process.env.REI_HYPERLINKS = "off";
    expect(linked(linkPathsInText("Ver package.json.", process.cwd()))).toHaveLength(0);
  });
});

describe("the file matcher these rely on", () => {
  it("prefers the LONGEST extension, so package.json is not package.js", () => {
    // Alternation takes the first branch that matches. With "js" before "json", `package.json`
    // matched as `package.js` — a file that does not exist — and that fed a plan's
    // "Files to modify" extraction as well as every link.
    const re = buildFileMatcherRegex();
    for (const name of ["package.json", "app.jsx", "main.tsx", "a.yaml", "x.cpp", "h.hpp"]) {
      expect(name.match(re)?.[0]).toBe(name);
    }
  });
});
