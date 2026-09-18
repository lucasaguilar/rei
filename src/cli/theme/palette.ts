/**
 * Named colour roles for REI's chrome — the block that is always on screen.
 *
 * Before this, "dim" was spelled `\x1b[2m` in twenty places and nothing said which greys were meant
 * to be the same grey. A role says what a colour is FOR, which is the only way a second theme can
 * exist without being a find-and-replace over 195 escape sequences.
 *
 * Scope is deliberate: the chrome (status line, thinking block, context bar, prompt, indicators)
 * and the chat surfaces around it. Markdown and diff rendering are NOT themed — syntax colour and
 * red/green hunks are information, not decoration, and a theme that repaints them makes the output
 * harder to read, not prettier.
 */
export type Role =
  /** Secondary text: labels, the elapsed clock, indicator lines. */
  | "dim"
  /** Structural marks that must recede further than `dim`: gutters, hints, the ⋮ continuation. */
  | "muted"
  /** Something is happening right now — the spinner. */
  | "accent"
  /** The model's reasoning. Italic by default: a different VOICE, not a different colour. */
  | "thinking"
  /** REI's own answer badge. */
  | "badge"
  /** The echo of what YOU said — the other half of the conversation. */
  | "user"
  /** Section headings inside a turn ("Changes:"). */
  | "heading"
  /** Emphasis within a line — a filename in a list of them. */
  | "strong"
  /** The agent-mode prompt, and REI's identity colour. */
  | "promptAgent"
  /** The ask-mode prompt. */
  | "promptAsk"
  /** The planning-mode prompt. */
  | "promptPlanning"
  /** Something needs attention but nothing is broken. */
  | "warn"
  /** Something is wrong, or about to be. */
  | "danger"
  /** Something worked. */
  | "success";

export type Palette = Record<Role, string>;

export const RESET = "\x1b[0m";

/**
 * The theme REI has always had. Every value here is the escape that was previously hardcoded at
 * the site it replaced, so adopting the palette changed nothing on screen — which is what made the
 * migration reviewable.
 */
const DEFAULT_PALETTE: Palette = {
  dim: "\x1b[2m",
  muted: "\x1b[90m",
  accent: "\x1b[36m",
  thinking: "\x1b[3m",
  badge: "\x1b[1;97;45m",
  user: "\x1b[1;36m",
  heading: "\x1b[1;33m",
  strong: "\x1b[1m",
  promptAgent: "\x1b[1;35m",
  promptAsk: "\x1b[1;32m",
  promptPlanning: "\x1b[1;33m",
  warn: "\x1b[33m",
  danger: "\x1b[31m",
  success: "\x1b[32m",
};

/**
 * Green on black, one shade per role, as the terminal in the film.
 *
 * `warn` and `danger` are the exception, and stay yellow and red: an alarm repainted into the
 * theme is an alarm that blends into the wall of green, and REI's warnings are about commands that
 * delete things. A theme may own the furniture; it does not own the smoke detector.
 */
const MATRIX_PALETTE: Palette = {
  dim: "\x1b[2;32m",
  muted: "\x1b[32m",
  accent: "\x1b[1;92m",
  thinking: "\x1b[3;32m",
  badge: "\x1b[1;30;42m",
  user: "\x1b[1;92m",
  heading: "\x1b[1;92m",
  strong: "\x1b[1;92m",
  promptAgent: "\x1b[1;92m",
  promptAsk: "\x1b[1;92m",
  promptPlanning: "\x1b[1;92m",
  warn: "\x1b[1;33m",
  danger: "\x1b[1;31m",
  success: "\x1b[92m",
};

export const THEMES = {
  default: DEFAULT_PALETTE,
  matrix: MATRIX_PALETTE,
} as const;

export type ThemeName = keyof typeof THEMES;

export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

export function isThemeName(value: string): value is ThemeName {
  return (THEME_NAMES as string[]).includes(value);
}

/** `/theme <name>` — switches mid-session, like /verbose and /reasoning. */
let override: ThemeName | undefined;

export function setTheme(name: ThemeName | undefined): void {
  override = name;
}

export function activeThemeName(): ThemeName {
  if (override) return override;
  const raw = process.env.REI_THEME?.trim().toLowerCase();
  return raw && isThemeName(raw) ? raw : "default";
}

export function palette(): Palette {
  return THEMES[activeThemeName()];
}

/** The escape for a role. Use when a string must be assembled by hand (nested styling). */
export function code(role: Role): string {
  return palette()[role];
}

/**
 * Wraps `text` in a role's colour and closes it.
 *
 * Always closes: an unclosed sequence leaks into everything printed afterwards, and in a redrawn
 * block that means a terminal that stays painted after REI exits.
 */
export function paint(role: Role, text: string): string {
  return `${palette()[role]}${text}${RESET}`;
}
