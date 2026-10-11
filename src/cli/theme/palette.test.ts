import { describe, it, expect, afterEach } from "vitest";
import {
  activeThemeName,
  code,
  colorDepth,
  isThemeName,
  paint,
  palette,
  RESET,
  setTheme,
  THEMES,
  THEME_NAMES,
  type Role,
} from "./palette.js";

const savedEnv = process.env.REI_THEME;
const savedColorTerm = process.env.COLORTERM;
afterEach(() => {
  setTheme(undefined);
  if (savedEnv === undefined) delete process.env.REI_THEME;
  else process.env.REI_THEME = savedEnv;
  if (savedColorTerm === undefined) delete process.env.COLORTERM;
  else process.env.COLORTERM = savedColorTerm;
});

/**
 * The palette exists so a colour has a NAME and a reason, instead of being the twentieth copy of
 * `\x1b[2m`. These pin the contract every theme has to honour.
 */
describe("every theme", () => {
  const ROLES = Object.keys(THEMES.default) as Role[];

  it("defines every role — a missing one renders as unstyled text, not as an error", () => {
    for (const name of THEME_NAMES) {
      for (const role of ROLES) {
        expect(THEMES[name][role], `${name}.${role}`).toMatch(/^\x1b\[[0-9;]+m$/);
      }
    }
  });

  it("keeps alarms out of the theme", () => {
    // A warning repainted into a wall of green is a warning that is missed, and REI's warnings are
    // about commands that delete things.
    for (const name of THEME_NAMES) {
      expect(THEMES[name].warn, `${name}.warn`).toContain("33m");
      expect(THEMES[name].danger, `${name}.danger`).toContain("31m");
    }
  });
});

describe("paint", () => {
  it("always closes what it opens", () => {
    // An unclosed sequence leaks into everything printed after it — in a redrawn block, that means
    // a terminal still painted after REI exits.
    for (const name of THEME_NAMES) {
      setTheme(name);
      const out = paint("dim", "hola");
      expect(out.startsWith(code("dim"))).toBe(true);
      expect(out.endsWith(RESET)).toBe(true);
      expect(out.split(RESET)).toHaveLength(2);
    }
  });
});

describe("choosing a theme", () => {
  it("defaults to the theme REI has always had", () => {
    delete process.env.REI_THEME;
    expect(activeThemeName()).toBe("default");
    expect(palette()).toBe(THEMES.default);
  });

  it("reads REI_THEME, and ignores a name that does not exist", () => {
    process.env.REI_THEME = "matrix";
    expect(activeThemeName()).toBe("matrix");
    process.env.REI_THEME = "neon-unicorn";
    expect(activeThemeName()).toBe("default");
  });

  it("lets /theme win over the environment, and lets go again", () => {
    process.env.REI_THEME = "matrix";
    setTheme("default");
    expect(activeThemeName()).toBe("default");
    setTheme(undefined);
    expect(activeThemeName()).toBe("matrix");
  });

  it("recognises exactly the themes it ships", () => {
    expect(THEME_NAMES).toEqual(["default", "matrix", "amber", "green"]);
    expect(isThemeName("matrix")).toBe(true);
    expect(isThemeName("dracula")).toBe(false);
  });
});

/**
 * amber and green are the Hercules monitors: one phosphor, a few intensities. Their whole point is
 * the exact hue, which the 16 ANSI colours cannot promise — `33m` is whatever yellow the user's
 * terminal profile says it is.
 */
describe("phosphor themes", () => {
  const PHOSPHORS = ["amber", "green"] as const;
  const ALARMS: Role[] = ["warn", "danger"];

  it("ask for the exact hue when the terminal can show it", () => {
    process.env.COLORTERM = "truecolor";
    setTheme("amber");
    expect(code("accent")).toContain("38;2;255;");
    setTheme("green");
    expect(code("accent")).toContain("38;2;");
  });

  it("fall back to the 256-colour cube instead of guessing truecolor", () => {
    // A terminal without truecolor does not degrade a 24-bit escape gracefully: some print the
    // digits, some pick an unrelated colour. 256 colours is universally safe and 214 IS amber.
    delete process.env.COLORTERM;
    setTheme("amber");
    expect(code("accent")).toContain("38;5;");
    expect(code("accent")).not.toContain("38;2;");
  });

  it("paint every role but the alarms in the phosphor itself", () => {
    for (const depth of ["truecolor", undefined]) {
      if (depth) process.env.COLORTERM = depth;
      else delete process.env.COLORTERM;
      for (const name of PHOSPHORS) {
        setTheme(name);
        for (const role of Object.keys(THEMES.default) as Role[]) {
          if (ALARMS.includes(role)) continue;
          expect(code(role), `${name}.${role}`).toMatch(/[34]8;[25];/);
        }
      }
    }
  });

  it("keep every alarm distinguishable from everything the theme paints", () => {
    // Amber and yellow are neighbours: a warning that is only "yellow" disappears on an amber screen.
    // `default` is exempt: it keeps the look REI always had, where tool status shares the warn yellow.
    for (const name of THEME_NAMES.filter((n) => n !== "default")) {
      setTheme(name);
      const p = palette();
      for (const alarm of ALARMS) {
        for (const role of Object.keys(p) as Role[]) {
          if (role === alarm) continue;
          expect(p[role], `${name}: ${alarm} vs ${role}`).not.toBe(p[alarm]);
        }
      }
    }
    expect(THEMES.amber.warn).not.toBe("\x1b[33m");
  });
});

describe("colorDepth", () => {
  it("trusts the terminals that announce or are known for truecolor", () => {
    expect(colorDepth({ COLORTERM: "truecolor" })).toBe("truecolor");
    expect(colorDepth({ COLORTERM: "24bit" })).toBe("truecolor");
    expect(colorDepth({ WT_SESSION: "x" })).toBe("truecolor");
    expect(colorDepth({ TERM_PROGRAM: "iTerm.app" })).toBe("truecolor");
  });

  it("assumes 256 colours otherwise", () => {
    expect(colorDepth({})).toBe("256");
    expect(colorDepth({ TERM_PROGRAM: "Apple_Terminal" })).toBe("256");
  });
});
