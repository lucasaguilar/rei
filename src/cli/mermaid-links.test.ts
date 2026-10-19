import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderMarkdown } from "./markdown-renderer.js";

// eslint-disable-next-line no-control-regex
const linkTargets = (s: string): string[] => [...s.matchAll(/\x1b\]8;;([^\x1b]+)\x1b\\/g)].map((m) => m[1]);
// eslint-disable-next-line no-control-regex
const strip = (s: string): string =>
  s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "");

const DIAGRAM = 'flowchart LR\n  A["submit()*"] --> B[store] --> C[a < b & c]';
const ANSWER = ["**Flujo:**", "", "```mermaid", DIAGRAM, "```", "", "Done."].join("\n");

const saved: Record<string, string | undefined> = {};
let tmp: string;

beforeEach(() => {
  for (const k of ["REI_HYPERLINKS", "REI_MERMAID_LINKS", "TMPDIR"]) saved[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rei-mermaid-test-"));
  // os.tmpdir() reads TMPDIR on every call, so the viewer files land in this test's own dir.
  process.env.TMPDIR = tmp;
  process.env.REI_HYPERLINKS = "on";
  delete process.env.REI_MERMAID_LINKS;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("renderMarkdown — mermaid viewer links", () => {
  it("links a mermaid block to a local HTML viewer by default", () => {
    const out = renderMarkdown(ANSWER);
    const targets = linkTargets(out).filter((t) => t.endsWith(".html"));
    expect(targets).toHaveLength(1);
    expect(strip(out)).toContain("open diagram");

    const file = targets[0].replace(/^file:\/\//, "");
    expect(file.startsWith(fs.realpathSync(tmp)) || file.startsWith(tmp)).toBe(true);
    const html = fs.readFileSync(file, "utf-8");
    // The diagram is embedded escaped — "<" and "&" in a label would otherwise be parsed as HTML.
    expect(html).toContain("a &lt; b &amp; c");
    // Mermaid comes from REI's own install, never a CDN: the viewer works offline.
    const script = html.match(/<script src="([^"]+)"/)?.[1] ?? "";
    expect(script.startsWith("file://")).toBe(true);
    expect(fs.existsSync(script.replace(/^file:\/\//, ""))).toBe(true);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("puts the link right after its own block, one per diagram", () => {
    const two = [ANSWER, "", "```mermaid", "flowchart LR\n  X --> Y", "```"].join("\n");
    const out = strip(renderMarkdown(two));
    expect(out.match(/open diagram/g)).toHaveLength(2);
    expect(out.indexOf("open diagram")).toBeLessThan(out.indexOf("Done."));
  });

  it("reuses one file for the same diagram instead of piling up copies", () => {
    renderMarkdown(ANSWER);
    renderMarkdown(ANSWER);
    const files = fs.readdirSync(path.join(tmp, "rei-mermaid"));
    expect(files).toHaveLength(1);
  });

  it("REI_MERMAID_LINKS=live links mermaid.live with the diagram in the fragment", () => {
    process.env.REI_MERMAID_LINKS = "live";
    const url = linkTargets(renderMarkdown(ANSWER)).find((t) => t.startsWith("https://mermaid.live/"));
    expect(url).toBeDefined();
    const encoded = url!.split("#pako:")[1];
    const state = JSON.parse(zlib.inflateSync(Buffer.from(encoded, "base64url")).toString("utf-8"));
    expect(state.code).toBe(DIAGRAM);
  });

  it("REI_MERMAID_LINKS=off adds nothing and writes nothing", () => {
    process.env.REI_MERMAID_LINKS = "off";
    const out = renderMarkdown(ANSWER);
    expect(strip(out)).not.toContain("open diagram");
    expect(fs.existsSync(path.join(tmp, "rei-mermaid"))).toBe(false);
  });

  it("prints the target as plain text when the terminal has no OSC 8 links", () => {
    process.env.REI_HYPERLINKS = "off";
    const out = renderMarkdown(ANSWER);
    expect(linkTargets(out)).toHaveLength(0);
    expect(strip(out)).toMatch(/open diagram: file:\/\/\S+\.html/);
  });

  it("leaves answers without mermaid untouched", () => {
    const out = strip(renderMarkdown("```ts\nconst a = 1;\n```"));
    expect(out).not.toContain("open diagram");
    expect(out).not.toContain("REIMERMAID");
  });
});
