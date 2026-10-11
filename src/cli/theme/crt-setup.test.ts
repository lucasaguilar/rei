import { describe, it, expect } from "vitest";
import * as path from "path";
import { crtSetup, CRT_SHADER } from "./crt-setup.js";

function fakeFs() {
  const written = new Map<string, string>();
  return {
    written,
    fs: {
      mkdir: (_p: string) => {},
      writeFile: (p: string, data: string) => void written.set(p, data),
    },
  };
}

/**
 * Scanlines and phosphor bloom are drawn by the terminal, not by REI. `/theme crt` does what can be
 * done from here: install the shader where the terminal can load it, and say plainly where that is
 * not possible instead of pretending.
 */
describe("/theme crt", () => {
  it("installs the shader for Ghostty and says which line turns it on", () => {
    const { fs, written } = fakeFs();
    const msg = crtSetup({ env: { TERM_PROGRAM: "ghostty" }, home: "/home/u", fs });
    const target = path.join("/home/u", ".config", "ghostty", "shaders", "rei-crt.glsl");
    expect(written.get(target)).toBe(CRT_SHADER);
    expect(msg).toContain(`custom-shader = ${target}`);
  });

  it("follows XDG_CONFIG_HOME, where Ghostty reads its config", () => {
    const { fs, written } = fakeFs();
    crtSetup({ env: { TERM_PROGRAM: "ghostty", XDG_CONFIG_HOME: "/xdg" }, home: "/home/u", fs });
    expect([...written.keys()]).toEqual([path.join("/xdg", "ghostty", "shaders", "rei-crt.glsl")]);
  });

  it("does not edit the user's terminal config — it prints the line to add", () => {
    const { fs, written } = fakeFs();
    crtSetup({ env: { TERM_PROGRAM: "ghostty" }, home: "/home/u", fs });
    expect([...written.keys()].some((p) => p.endsWith("config"))).toBe(false);
  });

  it("points Windows Terminal at its built-in retro effect, writing nothing", () => {
    const { fs, written } = fakeFs();
    const msg = crtSetup({ env: { WT_SESSION: "x" }, home: "C:\\Users\\u", fs });
    expect(msg).toContain('"experimental.retroTerminalEffect": true');
    expect(written.size).toBe(0);
  });

  it("knows REI Desktop draws its own tube, and points at its knobs", () => {
    const { fs, written } = fakeFs();
    const msg = crtSetup({ env: { TERM_PROGRAM: "rei-desktop" }, home: "/home/u", fs });
    expect(msg).toContain("REI Desktop");
    expect(msg).toContain("knobs");
    expect(msg).not.toContain("cannot");
    expect(written.size).toBe(0);
  });

  it("says where it is possible when this terminal cannot do it", () => {
    const { fs, written } = fakeFs();
    const msg = crtSetup({ env: { TERM_PROGRAM: "Apple_Terminal" }, home: "/home/u", fs });
    expect(msg).toContain("Ghostty");
    expect(msg).toContain("cool-retro-term");
    expect(written.size).toBe(0);
  });

  it("ships a Shadertoy-style shader, the entry point Ghostty calls", () => {
    expect(CRT_SHADER).toContain("void mainImage(out vec4 fragColor, in vec2 fragCoord)");
    expect(CRT_SHADER).toContain("iChannel0");
    expect(CRT_SHADER.split("{").length).toBe(CRT_SHADER.split("}").length);
  });
});
