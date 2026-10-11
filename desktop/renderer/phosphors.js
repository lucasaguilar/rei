/**
 * The screens the desktop can show. amber and green mirror src/cli/theme/phosphor.ts (a test keeps
 * them in step); `tint` is what the CRT shader multiplies the picture by — null means full colour.
 *
 * Plain ESM with no imports: the renderer loads it straight from disk, the main process and the
 * tests import it too.
 */
export const PHOSPHORS = {
  amber: {
    label: "A",
    name: "Amber",
    reiTheme: "amber",
    screen: "#0a0600",
    fg: "#ffb000",
    cursor: "#ffc640",
    tint: [1.0, 0.69, 0.0],
  },
  green: {
    label: "G",
    name: "Green",
    reiTheme: "green",
    screen: "#010802",
    fg: "#39ff5e",
    cursor: "#7dff97",
    tint: [0.22, 1.0, 0.37],
  },
  violet: {
    label: "V",
    name: "REI violet",
    reiTheme: "default",
    screen: "#0c0a12",
    fg: "#ece9f5",
    cursor: "#a78bfa",
    tint: null,
  },
};

export const DEFAULT_PHOSPHOR = "amber";

export function isPhosphor(name) {
  return Object.hasOwn(PHOSPHORS, name);
}

/** xterm.js colours for a phosphor: the glass, the beam, a cursor one notch brighter. */
export function xtermTheme(name) {
  const p = PHOSPHORS[name];
  return {
    background: p.screen,
    foreground: p.fg,
    cursor: p.cursor,
    cursorAccent: p.screen,
    selectionBackground: `${p.fg}55`,
  };
}
