import { Terminal } from "../node_modules/@xterm/xterm/lib/xterm.mjs";
import { FitAddon } from "../node_modules/@xterm/addon-fit/lib/addon-fit.mjs";
import { WebglAddon } from "../node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs";
import { Unicode11Addon } from "../node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs";
import { DEFAULT_PHOSPHOR, isPhosphor, PHOSPHORS, xtermTheme } from "./phosphors.js";

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
try {
  term.loadAddon(new WebglAddon());
} catch {
  // No WebGL: xterm's DOM renderer still works, just slower.
}
fit.fit();
term.focus();

window.rei.onData((data) => term.write(data));
window.rei.onExit(() => window.close());
term.onData((data) => window.rei.write(data));

new ResizeObserver(() => {
  fit.fit();
  window.rei.resize(term.cols, term.rows);
}).observe(document.getElementById("screen"));

window.rei.start({ cols: term.cols, rows: term.rows });
