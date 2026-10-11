import type { Palette } from "./palette.js";

/**
 * The Hercules monitors: one phosphor, a few intensities, black everywhere else.
 *
 * Unlike `default` and `matrix`, these cannot be written in the 16 ANSI colours — `33m` is whatever
 * yellow the user's terminal profile says, and the theme IS the hue. So each tone carries its exact
 * RGB and the nearest cell of the 256-colour cube, and the palette is built for what the terminal
 * can show.
 */
export type ColorDepth = "truecolor" | "256";

type Tone = { rgb: [number, number, number]; xterm: number };

type Phosphor = {
  /** Headings, the prompt, the spinner — the beam at full intensity. */
  bright: Tone;
  /** The body of the phosphor. */
  normal: Tone;
  /** Secondary text, the model's reasoning. */
  dim: Tone;
  /** What must recede furthest: gutters, hints. */
  faint: Tone;
  /** Warnings, kept out of the hue. On amber a plain yellow would blend in, so it is underlined. */
  warn: string;
};

export const PHOSPHORS = {
  amber: {
    bright: { rgb: [255, 198, 64], xterm: 221 },
    normal: { rgb: [255, 176, 0], xterm: 214 },
    dim: { rgb: [184, 120, 0], xterm: 136 },
    faint: { rgb: [143, 98, 19], xterm: 94 },
    warn: "1;4;33",
  },
  green: {
    bright: { rgb: [125, 255, 151], xterm: 120 },
    normal: { rgb: [57, 255, 94], xterm: 83 },
    dim: { rgb: [31, 158, 60], xterm: 35 },
    faint: { rgb: [26, 107, 46], xterm: 28 },
    warn: "1;33",
  },
} satisfies Record<string, Phosphor>;

export type PhosphorName = keyof typeof PHOSPHORS;

/** Terminals that support 24-bit colour without announcing it in COLORTERM. */
const TRUECOLOR_PROGRAMS = new Set(["iTerm.app", "WezTerm", "ghostty", "vscode"]);

/**
 * Only claims truecolor when the terminal says so or is known to: a 24-bit escape sent to a
 * terminal without it is not degraded gracefully — some print garbage, some pick an unrelated colour.
 */
export function colorDepth(env: NodeJS.ProcessEnv = process.env): ColorDepth {
  const announced = env.COLORTERM?.toLowerCase();
  if (announced === "truecolor" || announced === "24bit") return "truecolor";
  if (env.WT_SESSION) return "truecolor"; // Windows Terminal
  if (env.TERM_PROGRAM && TRUECOLOR_PROGRAMS.has(env.TERM_PROGRAM)) return "truecolor";
  return "256";
}

function fg(tone: Tone, depth: ColorDepth): string {
  return depth === "truecolor" ? `38;2;${tone.rgb.join(";")}` : `38;5;${tone.xterm}`;
}

function bg(tone: Tone, depth: ColorDepth): string {
  return depth === "truecolor" ? `48;2;${tone.rgb.join(";")}` : `48;5;${tone.xterm}`;
}

/** Black as an explicit colour, so the badge stays black even on a profile that redefines `30m`. */
const BLACK: Tone = { rgb: [0, 0, 0], xterm: 16 };

export function phosphorPalette(p: Phosphor, depth: ColorDepth): Palette {
  const e = (sgr: string): string => `\x1b[${sgr}m`;
  return {
    dim: e(fg(p.dim, depth)),
    muted: e(fg(p.faint, depth)),
    accent: e(`1;${fg(p.bright, depth)}`),
    thinking: e(`3;${fg(p.dim, depth)}`),
    badge: e(`1;${fg(BLACK, depth)};${bg(p.normal, depth)}`),
    user: e(`1;${fg(p.bright, depth)}`),
    heading: e(`1;${fg(p.bright, depth)}`),
    strong: e(`1;${fg(p.bright, depth)}`),
    promptAgent: e(`1;${fg(p.bright, depth)}`),
    promptAsk: e(`1;${fg(p.normal, depth)}`),
    promptPlanning: e(`1;${fg(p.normal, depth)}`),
    warn: e(p.warn),
    danger: e("1;31"),
    success: e(fg(p.bright, depth)),
    status: e(fg(p.normal, depth)),
    logoBlock: e(fg(p.bright, depth)),
    logoShadow: e(fg(p.dim, depth)),
  };
}

export const PHOSPHOR_PALETTES: Record<PhosphorName, Record<ColorDepth, Palette>> = {
  amber: {
    truecolor: phosphorPalette(PHOSPHORS.amber, "truecolor"),
    "256": phosphorPalette(PHOSPHORS.amber, "256"),
  },
  green: {
    truecolor: phosphorPalette(PHOSPHORS.green, "truecolor"),
    "256": phosphorPalette(PHOSPHORS.green, "256"),
  },
};

export function isPhosphor(name: string): name is PhosphorName {
  return name in PHOSPHOR_PALETTES;
}
