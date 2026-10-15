import { Terminal } from "../node_modules/@xterm/xterm/lib/xterm.mjs";
import { FitAddon } from "../node_modules/@xterm/addon-fit/lib/addon-fit.mjs";
import { WebglAddon } from "../node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs";
import { Unicode11Addon } from "../node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs";
import { WebLinksAddon } from "../node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs";
import { DEFAULT_PHOSPHOR, isPhosphor, PHOSPHORS, xtermTheme } from "./phosphors.js";
import { Crt } from "./crt.js";
import { mountBezel, mountProjectButton, toast } from "./bezel.js";
import { playBoot } from "./boot.js";

const settings = await window.rei.getSettings();
const query = new URLSearchParams(location.search);
const requested = query.get("phosphor");
// The phosphor REI was started in: its chrome colours are that theme's until the next launch.
const launchedIn = isPhosphor(requested) ? requested : DEFAULT_PHOSPHOR;
let phosphor = settings.phosphor;

// Every link in the terminal ends here, whichever way it was found. The renderer does not open
// anything: main asks the user, then hands the address to the browser (or the file manager).
function openLink(_event, uri) {
  window.rei.openLink(uri).finally(() => term.focus());
}

const term = new Terminal({
  fontFamily: 'Menlo, "SF Mono", "Cascadia Mono", Consolas, monospace',
  fontSize: 15,
  lineHeight: 1.12,
  cursorBlink: true,
  scrollback: 5000,
  theme: xtermTheme(phosphor),
  allowProposedApi: true, // the unicode API below is still "proposed" in xterm.js
  // Links REI marks explicitly (OSC 8): a markdown [title](url), a file path. file:// has to be let
  // through here; main is what refuses anything outside the workspace.
  linkHandler: { activate: openLink, allowNonHttpProtocols: true },
});
// REI's chrome is full of emoji (🧠 ⏳ 💻). Unicode 6 widths give them one cell, the font draws
// two, and the next character lands on top of them.
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = "11";
// And bare http(s) addresses in plain text, the way a terminal makes them clickable.
term.loadAddon(new WebLinksAddon(openLink));
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
let crt;
try {
  if (!webgl) throw new Error("no WebGL terminal to sample");
  crt = new Crt(
    document.getElementById("crt"),
    // The text layer: the largest canvas that is not the link layer, which is the same size and
    // transparent. Looked up each frame because xterm recreates it on resize.
    () =>
      [...terminalEl.querySelectorAll("canvas:not(.xterm-link-layer)")].sort(
        (a, b) => b.width * b.height - a.width * a.height,
      )[0] ?? null,
    () => terminalEl.getBoundingClientRect(),
  );
  crt.setKnobs(settings.knobs);
  crt.power = 0;
  crt.start();
  // The terminal stays in the page — it still takes focus, the mouse and the selection — but the
  // tube is what is seen.
  document.body.classList.add("crt-on");
} catch (error) {
  console.warn("[rei-desktop] CRT off:", error);
}

function applyPhosphor(name) {
  phosphor = name;
  const p = PHOSPHORS[name];
  term.options.theme = xtermTheme(name);
  crt?.setPhosphor(p);
  document.documentElement.style.setProperty("--phos", p.fg);
}
applyPhosphor(phosphor);

const toastEl = document.getElementById("toast");
mountBezel(document.getElementById("panel"), settings, {
  knob: (key, value) => {
    crt?.setKnobs({ [key]: value });
    window.rei.saveSettings({ knobs: { [key]: value } });
  },
  phosphor: (name) => {
    applyPhosphor(name);
    window.rei.saveSettings({ phosphor: name });
    // Amber and green tint the whole picture, so REI's own theme does not show through. Violet is
    // REI's real colours — those come from the theme REI was started in.
    const chromeShows = PHOSPHORS[name].tint === null || PHOSPHORS[launchedIn].tint === null;
    if (chromeShows && PHOSPHORS[name].reiTheme !== PHOSPHORS[launchedIn].reiTheme) {
      toast(toastEl, `REI's own colours switch to ${PHOSPHORS[name].name} on the next launch.`);
    }
    term.focus();
  },
});
mountProjectButton(document.getElementById("panel"), await window.rei.editor(), () => window.rei.openProject());
// Clicking the panel must not leave the keyboard pointing at a knob.
document.getElementById("panel").addEventListener("pointerup", () => setTimeout(() => term.focus(), 0));

const led = document.getElementById("led");

window.rei.onData((data) => term.write(data));
window.rei.onExit(async () => {
  // /exit: the beam collapses to a line, then nothing, and the LED goes out with it.
  led.classList.remove("on");
  await crt?.sweep(0, 450);
  window.close();
});
term.onData((data) => window.rei.write(data));

new ResizeObserver(() => {
  fit.fit();
  window.rei.resize(term.cols, term.rows);
}).observe(terminalEl);

led.classList.add("on");
await crt?.sweep(1, 650);
await playBoot(term, {
  workspace: query.get("workspace") ?? "",
  phosphor: launchedIn,
  version: query.get("version") ?? "",
});
window.rei.start({ cols: term.cols, rows: term.rows });
