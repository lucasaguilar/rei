import { activeThemeName } from "./palette.js";
import { isPhosphor, PHOSPHORS } from "./phosphor.js";

/**
 * A phosphor theme paints what REI colours; the text you type and the model's answer use the
 * terminal's own foreground, and stay white on whatever background the profile has. OSC 10/11/12
 * set that foreground, background and cursor, so the whole window becomes the monitor while REI
 * runs. iTerm2, Ghostty, kitty, WezTerm, xterm, Windows Terminal and tmux honour them; terminals
 * that do not ignore them.
 *
 * Interactive CLI only. `/theme` also runs from channels (the server, WhatsApp), and a message
 * there must not repaint the terminal the server happens to be running in.
 */
const osc = (code: string): string => `\x1b]${code}\x07`;

/** 110/111/112 put back whatever the terminal's profile says — not a colour REI guessed. */
export const RESTORE_SEQUENCE = osc("110") + osc("111") + osc("112");

const hex = (rgb: [number, number, number]): string =>
  "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");

type Options = {
  write?: (s: string) => void;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Registers the restore for when the process ends — however it ends. */
  onExit?: (fn: () => void) => void;
};

/** The theme whose colours are on the terminal now, if REI put any there. */
let painted: string | undefined;
let exitHooked = false;

function resolve(opts: Options) {
  return {
    write: opts.write ?? ((s: string) => void process.stdout.write(s)),
    isTTY: opts.isTTY ?? Boolean(process.stdout.isTTY),
    env: opts.env ?? process.env,
    onExit: opts.onExit ?? ((fn: () => void) => void process.once("exit", fn)),
  };
}

/** Brings the terminal's colours in line with the active theme. Cheap to call after any command. */
export function syncTerminalScreen(opts: Options = {}): void {
  const { write, isTTY, env, onExit } = resolve(opts);
  const theme = activeThemeName();
  const wanted =
    isTTY && env.REI_TERMINAL_COLORS?.toLowerCase() !== "off" && isPhosphor(theme) ? theme : undefined;

  if (wanted === painted) return;
  if (!wanted) {
    restoreTerminalScreen(opts);
    return;
  }

  const p = PHOSPHORS[wanted];
  write(osc(`10;${hex(p.normal.rgb)}`) + osc(`11;${hex(p.screen)}`) + osc(`12;${hex(p.bright.rgb)}`));
  painted = wanted;
  if (!exitHooked) {
    // 'exit' fires on /exit, on process.exit and after an uncaught exception, so a crash does not
    // leave the terminal amber. A SIGKILL cannot be caught; REI_TERMINAL_COLORS=off is the way out.
    onExit(() => restoreTerminalScreen({ write: opts.write }));
    exitHooked = true;
  }
}

export function restoreTerminalScreen(opts: Pick<Options, "write"> = {}): void {
  if (!painted) return;
  resolve(opts).write(RESTORE_SEQUENCE);
  painted = undefined;
}

export function _resetTerminalScreenForTests(): void {
  painted = undefined;
  exitHooked = false;
}
