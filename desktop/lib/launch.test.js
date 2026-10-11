import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { reiLaunch, workspaceFromArgv } from "./launch.js";
import { PHOSPHORS } from "../renderer/phosphors.js";
import { PHOSPHORS as CLI_PHOSPHORS } from "../../src/cli/theme/phosphor.js";

describe("reiLaunch", () => {
  const launch = (phosphor) =>
    reiLaunch({ repoRoot: "/repo", workspace: "/work", phosphor, env: { PATH: "/bin", HOME: "/h" } });

  it("runs the repo's own CLI, in chat mode, inside the workspace", () => {
    const l = launch("amber");
    expect(l.command).toBe("node");
    expect(l.args).toEqual([path.join("/repo", "bin", "rei.js"), "chat"]);
    expect(l.cwd).toBe("/work");
    expect(l.env.REI_WORKSPACE_PATH).toBe("/work");
  });

  it("keeps the user's environment — PATH, HOME, their keys", () => {
    expect(launch("amber").env).toMatchObject({ PATH: "/bin", HOME: "/h" });
  });

  it("starts REI in the theme that matches the screen", () => {
    expect(launch("amber").env.REI_THEME).toBe("amber");
    expect(launch("green").env.REI_THEME).toBe("green");
    expect(launch("violet").env.REI_THEME).toBe("default");
  });

  it("tells REI the window owns the glass, and that it can show truecolor", () => {
    const { env } = launch("amber");
    expect(env.REI_TERMINAL_COLORS).toBe("off");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.TERM_PROGRAM).toBe("rei-desktop");
  });

  it("honours REI_NODE for a node that is not on PATH", () => {
    const l = reiLaunch({ repoRoot: "/r", workspace: "/w", phosphor: "amber", env: { REI_NODE: "/opt/node/bin/node" } });
    expect(l.command).toBe("/opt/node/bin/node");
  });
});

describe("workspaceFromArgv", () => {
  const dirs = new Set([path.resolve("/projects/app"), path.resolve(".")]);
  const isDir = (p) => dirs.has(p);

  it("takes the first directory argument", () => {
    expect(workspaceFromArgv(["--inspect", "/projects/app"], isDir)).toBe(path.resolve("/projects/app"));
  });

  it("skips '.', which is the app itself under `electron .`", () => {
    expect(workspaceFromArgv(["."], isDir)).toBeUndefined();
  });
});

describe("the desktop's phosphors", () => {
  it("are the CLI's phosphors — one amber, not two that drift apart", () => {
    const hex = (rgb) => "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
    for (const name of ["amber", "green"]) {
      expect(PHOSPHORS[name].fg, name).toBe(hex(CLI_PHOSPHORS[name].normal.rgb));
      expect(PHOSPHORS[name].cursor, name).toBe(hex(CLI_PHOSPHORS[name].bright.rgb));
      expect(PHOSPHORS[name].screen, name).toBe(hex(CLI_PHOSPHORS[name].screen));
    }
  });
});
