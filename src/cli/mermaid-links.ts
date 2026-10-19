import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { hyperlink, hyperlinksSupported } from "./file-links.js";
import { paint } from "./theme/palette.js";

/**
 * A terminal cannot draw a Mermaid diagram, so every ```mermaid block in an answer gets a line
 * under it that opens the diagram in a browser.
 *
 * The link is built HERE, from the block the model wrote — never by the model. A viewer URL is a
 * compressed, encoded blob; a model asked to produce one invents the bytes and hands back a link
 * that looks right and opens nothing.
 *
 * `REI_MERMAID_LINKS` picks the viewer:
 *   local (default) — an HTML file in the temp dir, drawn by the mermaid copy REI ships. Offline:
 *                     the diagram names your code, and nothing about it leaves the machine.
 *   live            — mermaid.live, for editing. The diagram rides in the URL fragment, which the
 *                     browser does not send, but the page's own script and the browser history see it.
 *   off             — no line at all.
 */
export type MermaidViewer = "local" | "live" | "off";

export function mermaidViewer(): MermaidViewer {
  const v = process.env.REI_MERMAID_LINKS?.trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return "off";
  return v === "live" ? "live" : "local";
}

/** The mermaid.live editor URL, in the `#pako:` form its share button produces. */
export function liveEditorUrl(code: string): string {
  const state = { code, mermaid: JSON.stringify({ theme: "default" }), autoSync: true, updateDiagram: true };
  return `https://mermaid.live/edit#pako:${zlib.deflateSync(JSON.stringify(state), { level: 9 }).toString("base64url")}`;
}

/** The browser bundle of the mermaid dependency, or null when it cannot be found. */
function mermaidBundle(): string | null {
  try {
    return createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js");
  } catch {
    return null;
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Writes the local viewer page for a diagram and returns its path, or null without a bundle.
 *
 * Named by a hash of the diagram, so re-rendering the same answer reuses one file instead of
 * piling up copies. The script is linked by path rather than inlined: inlining would copy 5 MB of
 * mermaid into every diagram.
 */
export function writeLocalViewer(code: string): string | null {
  const bundle = mermaidBundle();
  if (!bundle) return null;
  const dir = path.join(os.tmpdir(), "rei-mermaid");
  const hash = crypto.createHash("sha1").update(code).digest("hex").slice(0, 12);
  const file = path.join(dir, `diagram-${hash}.html`);
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>REI diagram</title>
<style>
  body { margin: 0; padding: 24px; font-family: system-ui, sans-serif; background: #fff; color: #222; }
  details { margin-top: 24px; } pre.source { white-space: pre-wrap; font-size: 13px; }
  @media (prefers-color-scheme: dark) { body { background: #1e1e1e; color: #ddd; } }
</style>
</head>
<body>
<pre class="mermaid">${escapeHtml(code)}</pre>
<details><summary>Source</summary><pre class="source">${escapeHtml(code)}</pre></details>
<script src="file://${bundle}"></script>
<script>
  // strict: a diagram written by a model must not get click handlers or raw HTML into the page.
  mermaid.initialize({
    startOnLoad: true,
    securityLevel: "strict",
    theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
  });
</script>
</body>
</html>
`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, html);
    return file;
  } catch {
    return null; // an unwritable temp dir costs the link, never the answer
  }
}

/** The line shown under a diagram, or null when links are off or no viewer could be made. */
export function mermaidLinkLine(code: string): string | null {
  const viewer = mermaidViewer();
  if (viewer === "off") return null;
  let target: string | null = liveEditorUrl(code);
  if (viewer === "local") {
    const file = writeLocalViewer(code);
    target = file ? `file://${file}` : null;
  }
  if (!target) return null;
  // Terminals without OSC 8 get the target spelled out — most still open a URL on cmd/ctrl+click.
  return hyperlinksSupported()
    ? paint("muted", "↗ ") + hyperlink(paint("muted", "open diagram"), target)
    : paint("muted", `↗ open diagram: ${target}`);
}

const MERMAID_BLOCK = /^```mermaid[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;
const placeholder = (i: number): string => `REIMERMAIDLINK${i}X`;

/**
 * Marks every top-level ```mermaid block with a placeholder paragraph right after it.
 *
 * The link cannot be added before rendering — marked would mangle the escape sequence — nor found
 * after it, when the block is just highlighted text. So the block is tagged here, and
 * `fillMermaidLinks` swaps each tag for its line once the answer is laid out.
 */
export function tagMermaidBlocks(markdown: string): { markdown: string; codes: string[] } {
  if (mermaidViewer() === "off") return { markdown, codes: [] };
  const codes: string[] = [];
  const tagged = markdown.replace(MERMAID_BLOCK, (block, code: string) => {
    codes.push(code.trimEnd());
    return `${block}\n\n${placeholder(codes.length - 1)}\n`;
  });
  return { markdown: tagged, codes };
}

export function fillMermaidLinks(rendered: string, codes: string[]): string {
  let out = rendered;
  codes.forEach((code, i) => {
    const line = mermaidLinkLine(code) ?? "";
    out = out.replace(new RegExp(`[^\\S\\n]*${placeholder(i)}`), line);
  });
  // A tag whose line came back empty would leave a blank gap; collapse it.
  return codes.length > 0 ? out.replace(/\n{3,}/g, "\n\n") : out;
}
