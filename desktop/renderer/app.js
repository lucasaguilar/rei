import { Terminal } from "../node_modules/@xterm/xterm/lib/xterm.mjs";
import { FitAddon } from "../node_modules/@xterm/addon-fit/lib/addon-fit.mjs";
import { WebglAddon } from "../node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs";
import { Unicode11Addon } from "../node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs";
import { DEFAULT_PHOSPHOR, isPhosphor, PHOSPHORS, xtermTheme } from "./phosphors.js";
import { Crt } from "./crt.js";

const requested = new URLSearchParams(location.search).get("phosphor");
const phosphor = isPhosphor(requested) ? requested : DEFAULT_PHOSPHOR;
document.body.style.background = PHOSPHORS[phosphor].screen;

const term = new Terminal({
  fontFamily: 'Menlo, "SF Mono", "Cascadia Mono", Consolas, monospace',
  fontSize: 15,
  lineHeight: 1.12,
  cursorBlink: true,
  scrollback: 5000,
  theme: xtermTheme(phosphor),
  allowProposedApi: true, // the unicode API below is still "proposed" in xterm.js
});
// REI's chrome is full of emoji (🧠 ⏳ 💻). Unicode 6 widths give them one cell, the font draws
// two, and the next character lands on top of them.
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = "11";
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal"));
let webgl = true;
try {
  // preserveDrawingBuffer: the CRT copies xterm's canvas every frame, and without it the canvas
  // may already be cleared by the time the copy happens.
  term.loadAddon(new WebglAddon(true));
} catch {
  webgl = false; // xterm's DOM renderer still works; there is just no picture to put on the tube
}
fit.fit();
term.focus();

const terminalEl = document.getElementById("terminal");
try {
  if (!webgl) throw new Error("no WebGL terminal to sample");
  const crt = new Crt(
    document.getElementById("crt"),
    // The text layer: the largest canvas that is not the link layer, which is the same size and
    // transparent. Looked up each frame because xterm recreates it on resize.
    () =>
      [...terminalEl.querySelectorAll("canvas:not(.xterm-link-layer)")].sort(
        (a, b) => b.width * b.height - a.width * a.height,
      )[0] ?? null,
    () => terminalEl.getBoundingClientRect(),
  );
  crt.setPhosphor(PHOSPHORS[phosphor]);
  crt.start();
  // The terminal stays in the page — it still takes focus, the mouse and the selection — but the
  // tube is what is seen.
  document.body.classList.add("crt-on");
} catch (error) {
  console.warn("[rei-desktop] CRT off:", error);
}

window.rei.onData((data) => term.write(data));
window.rei.onExit(() => window.close());
term.onData((data) => window.rei.write(data));

new ResizeObserver(() => {
  fit.fit();
  window.rei.resize(term.cols, term.rows);
}).observe(document.getElementById("screen"));

window.rei.start({ cols: term.cols, rows: term.rows });
