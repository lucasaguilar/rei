import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `load-env.ts` is a side-effect module that reads process.argv and mutates process.env, so it is
 * exercised in a real child process rather than imported.
 *
 * A workspace's env lives at `<ws>/.rei/.env`. The legacy `<ws>/.env` is still read: dropping it
 * would not raise an error, it would silently fall back to the install's values — the ghost config
 * this layout exists to remove.
 */
const LOADER = join(process.cwd(), "dist", "load-env.js");

let ws: string;
let cwdDir: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-env-ws-"));
  cwdDir = mkdtempSync(join(tmpdir(), "rei-env-cwd-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

const writeRei = (body: string) => {
  mkdirSync(join(ws, ".rei"), { recursive: true });
  writeFileSync(join(ws, ".rei", ".env"), body);
};
const writeLegacy = (body: string) => writeFileSync(join(ws, ".env"), body);
const writeCwd = (body: string) => writeFileSync(join(cwdDir, ".env"), body);

/** Runs the loader with `--workspace ws` from `cwd`, and reports the resolved variables.
 *  The probe goes through a real file: with `node -e`, node claims `--workspace` as its own flag
 *  instead of passing it down in process.argv, which is exactly what the loader reads. */
function resolve(keys: string[], cwd = cwdDir): Record<string, string> {
  const probe = join(cwdDir, "probe.mjs");
  writeFileSync(
    probe,
    `import ${JSON.stringify(LOADER)};\n` +
      `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k => [k, process.env[k] ?? ""]))));\n`,
  );
  const out = execFileSync(process.execPath, [probe, "--workspace", ws], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  return JSON.parse(out.trim().split("\n").pop() as string);
}

describe("workspace env resolution", () => {
  it("reads the workspace env from .rei/.env", () => {
    writeRei("REI_TEST_MODEL=from-rei-dir\n");
    expect(resolve(["REI_TEST_MODEL"]).REI_TEST_MODEL).toBe("from-rei-dir");
  });

  it("still reads a legacy root .env, so existing projects keep working", () => {
    writeLegacy("REI_TEST_MODEL=from-legacy-root\n");
    expect(resolve(["REI_TEST_MODEL"]).REI_TEST_MODEL).toBe("from-legacy-root");
  });

  it("lets .rei/.env win when a project has both during a migration", () => {
    writeLegacy("REI_TEST_MODEL=from-legacy-root\n");
    writeRei("REI_TEST_MODEL=from-rei-dir\n");
    expect(resolve(["REI_TEST_MODEL"]).REI_TEST_MODEL).toBe("from-rei-dir");
  });

  it("overrides the install's base value — the ghost-config case", () => {
    // The install .env is the cwd one under the wizard; a project that states a value must win.
    writeCwd("REI_TEST_MODEL=from-install\n");
    writeRei("REI_TEST_MODEL=from-project\n");
    expect(resolve(["REI_TEST_MODEL"]).REI_TEST_MODEL).toBe("from-project");
  });

  it("keeps install values the project does not override (API keys live there)", () => {
    writeCwd("REI_TEST_KEY=sk-install\nREI_TEST_MODEL=from-install\n");
    writeRei("REI_TEST_MODEL=from-project\n");
    const env = resolve(["REI_TEST_KEY", "REI_TEST_MODEL"]);
    expect(env.REI_TEST_KEY).toBe("sk-install");
    expect(env.REI_TEST_MODEL).toBe("from-project");
  });

  it("reads .rei/.env even when run from inside the project", () => {
    // Running `rei` from the project makes cwd === workspace, so step 1 reads <ws>/.env; the
    // canonical file sits a directory deeper and must still be picked up.
    writeLegacy("REI_TEST_MODEL=root-of-project\n");
    writeRei("REI_TEST_MODEL=rei-dir-of-project\n");
    expect(resolve(["REI_TEST_MODEL"], ws).REI_TEST_MODEL).toBe("rei-dir-of-project");
  });
});
