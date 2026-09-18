import { describe, it, expect, afterEach } from "vitest";
import {
  activeThemeName,
  code,
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
afterEach(() => {
  setTheme(undefined);
  if (savedEnv === undefined) delete process.env.REI_THEME;
  else process.env.REI_THEME = savedEnv;
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
    expect(THEME_NAMES).toEqual(["default", "matrix"]);
    expect(isThemeName("matrix")).toBe(true);
    expect(isThemeName("dracula")).toBe(false);
  });
});
