import { describe, it, expect, afterEach } from "vitest";
import { renderLogo } from "./logo.js";
import { REI_LOGO } from "../rei-logo.js";
import { code, RESET, setTheme, THEME_NAMES } from "./palette.js";
import { stripAnsi } from "../helpers/terminal.helpers.js";

afterEach(() => setTheme(undefined));

/**
 * The logo is two things drawn in one string: the █ letters and the ╔═╗ shadow behind them. A
 * theme paints them apart — that two-tone is what makes it read as the REI mark rather than as
 * a block of text.
 */
describe("renderLogo", () => {
  it("draws exactly the logo, in every theme — colour is added, never a character", () => {
    for (const name of THEME_NAMES) {
      setTheme(name);
      expect(stripAnsi(renderLogo()), name).toBe(REI_LOGO);
    }
  });

  it("paints the letters and the shadow in their own roles", () => {
    setTheme("amber");
    const out = renderLogo();
    expect(out).toContain(`${code("logoBlock")}██████`);
    expect(out).toContain(`${code("logoShadow")}╗`);
  });

  it("leaves the spaces bare, so the gaps stay the terminal's own background", () => {
    setTheme("green");
    expect(renderLogo()).not.toMatch(/\x1b\[[0-9;]+m +\x1b\[0m/);
  });

  it("closes every colour it opens", () => {
    for (const name of THEME_NAMES) {
      setTheme(name);
      const out = renderLogo();
      const opened = (out.match(/\x1b\[[0-9;]*m/g) ?? []).filter((e) => e !== RESET).length;
      expect((out.match(/\x1b\[0m/g) ?? []).length, name).toBe(opened);
    }
  });
});
