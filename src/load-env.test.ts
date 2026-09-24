import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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

/**
 * This suite runs the COMPILED loader, so it needs `dist/`. On a dev machine that is always there
 * from the last build and the dependency is invisible; on a clean checkout it is not, and node
 * reports it as `ERR_MODULE_NOT_FOUND` on a generated probe file — which says nothing about what
 * to do. CI builds first (see .github/workflows/ci.yml); this says so when something else does not.
 */
if (!existsSync(LOADER)) {
  throw new Error(
    `load-env.test.ts needs the compiled loader at ${LOADER}. Run \`npm run build\` first.`,
  );
}

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

/** Runs the loader with NO --workspace and no REI_WORKSPACE_PATH — a bare `node dist/server.js`
 *  or `node bin/rei.js`, where the workspace can only be the cwd. */
function resolveBare(keys: string[], cwd: string): Record<string, string> {
  const probe = join(cwd, "probe-bare.mjs");
  writeFileSync(
    probe,
    `import ${JSON.stringify(LOADER)};\n` +
      `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k => [k, process.env[k] ?? ""]))));\n`,
  );
  const out = execFileSync(process.execPath, [probe], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  return JSON.parse(out.trim().split("\n").pop() as string);
}

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

  it("takes credentials and endpoints from the install, and the model from the project", () => {
    // The install describes the MACHINE — keys, where a backend listens, which backend exists.
    writeCwd(
      "REI_TEST_API_KEY=sk-install\nREI_TEST_BASE_URL=http://localhost:1234\n" +
        "REI_TEST_MODEL=from-install\n",
    );
    writeRei("REI_TEST_MODEL=from-project\n");
    const env = resolve(["REI_TEST_API_KEY", "REI_TEST_BASE_URL", "REI_TEST_MODEL"]);
    expect(env.REI_TEST_API_KEY).toBe("sk-install");
    expect(env.REI_TEST_BASE_URL).toBe("http://localhost:1234");
    expect(env.REI_TEST_MODEL).toBe("from-project");
  });

  it("does NOT inherit a model or its tuning from the install — the ghost-config case", () => {
    // Opening REI in a folder that says nothing about a model must not quietly reuse another
    // project's: the model, its sampling and its context window are per-project decisions.
    writeCwd(
      "REI_TEST_MODEL=ghost-model\nREI_TEST_TEMPERATURE=0.9\nREI_MAX_TURNS=29\n",
    );
    const env = resolve(["REI_TEST_MODEL", "REI_TEST_TEMPERATURE", "REI_MAX_TURNS"]);
    expect(env.REI_TEST_MODEL).toBe("");
    expect(env.REI_TEST_TEMPERATURE).toBe("");
    expect(env.REI_MAX_TURNS).toBe("");
  });

  it("inherits which backend runs on this machine", () => {
    writeCwd("MODEL_PROVIDER=lmstudio\nAGENT_MODEL_PROVIDER=ollama\n");
    const env = resolve(["MODEL_PROVIDER", "AGENT_MODEL_PROVIDER"]);
    expect(env.MODEL_PROVIDER).toBe("lmstudio");
    expect(env.AGENT_MODEL_PROVIDER).toBe("ollama");
  });

  it("lets a real shell variable beat both files", () => {
    writeCwd("REI_TEST_API_KEY=sk-from-file\n");
    // Simulated by pre-setting it in the child's environment — set deliberately, for this run.
    const probe = join(cwdDir, "probe-shell.mjs");
    writeFileSync(
      probe,
      `import ${JSON.stringify(LOADER)};\nconsole.log(process.env.REI_TEST_API_KEY ?? "");\n`,
    );
    const out = execFileSync(process.execPath, [probe, "--workspace", ws], {
      cwd: cwdDir,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", REI_TEST_API_KEY: "sk-from-shell" },
    });
    expect(out.trim()).toBe("sk-from-shell");
  });

  it("restores wholesale inheritance behind REI_INHERIT_ALL_ENV", () => {
    writeCwd("REI_TEST_MODEL=ghost-model\n");
    const probe = join(cwdDir, "probe-inherit.mjs");
    writeFileSync(
      probe,
      `import ${JSON.stringify(LOADER)};\nconsole.log(process.env.REI_TEST_MODEL ?? "");\n`,
    );
    const out = execFileSync(process.execPath, [probe, "--workspace", ws], {
      cwd: cwdDir,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", REI_INHERIT_ALL_ENV: "true" },
    });
    expect(out.trim()).toBe("ghost-model");
  });

  it("takes the whole install file when the project IS the cwd", () => {
    // Running `rei` from inside the project, cwd/.env is that project's own legacy file — not an
    // install layer — so filtering it would drop the project's own configuration.
    writeLegacy("REI_TEST_MODEL=my-own-project-model\n");
    expect(resolve(["REI_TEST_MODEL"], ws).REI_TEST_MODEL).toBe("my-own-project-model");
  });

  it("reads .rei/.env even when run from inside the project", () => {
    // Running `rei` from the project makes cwd === workspace, so step 1 reads <ws>/.env; the
    // canonical file sits a directory deeper and must still be picked up.
    writeLegacy("REI_TEST_MODEL=root-of-project\n");
    writeRei("REI_TEST_MODEL=rei-dir-of-project\n");
    expect(resolve(["REI_TEST_MODEL"], ws).REI_TEST_MODEL).toBe("rei-dir-of-project");
  });
});

/**
 * With neither `--workspace` nor `REI_WORKSPACE_PATH`, the workspace is the cwd — which is what
 * the app itself concludes (getDefaultWorkspace). They used to disagree: the loader left the
 * workspace undefined and skipped `<cwd>/.rei/.env` entirely, while the server happily ran its
 * agent against that very directory. Per-project settings — REI_ON_DEMAND_FILE_CONTEXT_<MODE> and
 * every other non-machine key — were silently dropped for anyone starting an entrypoint by hand
 * rather than through a launcher.
 */
describe("a bare invocation, with no workspace named", () => {
  it("reads the cwd's .rei/.env, because the cwd IS the workspace", () => {
    mkdirSync(join(cwdDir, ".rei"), { recursive: true });
    writeFileSync(
      join(cwdDir, ".rei", ".env"),
      "REI_ON_DEMAND_FILE_CONTEXT_AGENT=1\n",
    );
    expect(
      resolveBare(["REI_ON_DEMAND_FILE_CONTEXT_AGENT"], cwdDir)
        .REI_ON_DEMAND_FILE_CONTEXT_AGENT,
    ).toBe("1");
  });

  it("takes the cwd's own .env whole, not filtered down to machine keys", () => {
    writeFileSync(join(cwdDir, ".env"), "REI_TEST_MODEL=del-proyecto\n");
    expect(resolveBare(["REI_TEST_MODEL"], cwdDir).REI_TEST_MODEL).toBe("del-proyecto");
  });

  it("keeps the project file authoritative over the ambient environment", () => {
    // The precedence the workspace file has always had (`apply` overrides for it, and only the
    // INSTALL's keys defer to a shell variable). Worth pinning here because the cwd fallback is
    // what brings a bare invocation under that rule: whatever the container or the shell exported,
    // the project's own .rei/.env is what REI runs on.
    mkdirSync(join(cwdDir, ".rei"), { recursive: true });
    writeFileSync(join(cwdDir, ".rei", ".env"), "REI_TEST_MODEL=del-archivo\n");
    const probe = join(cwdDir, "probe-shell.mjs");
    writeFileSync(
      probe,
      `import ${JSON.stringify(LOADER)};\n` +
        `console.log(process.env.REI_TEST_MODEL);\n`,
    );
    const out = execFileSync(process.execPath, [probe], {
      cwd: cwdDir,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", REI_TEST_MODEL: "de-la-shell" },
    });
    expect(out.trim()).toBe("del-archivo");
  });
});

/**
 * Prefix aliases.
 *
 * The provider is `lmstudio`; its variables are `LLM_STUDIO_*`, because the provider was renamed
 * and the 14 variables were not. Someone who reasonably writes `LMSTUDIO_MODEL` gets no error and
 * no model — the silence is the bug. The alias is applied where the environment is assembled, so
 * it covers every variable with that prefix rather than a list somebody has to maintain.
 */
describe("the LMSTUDIO_ prefix alias", () => {
  it("feeds the spelling the code actually reads", () => {
    writeRei("LMSTUDIO_MODEL=qwen/qwen3-4b\n");
    expect(resolve(["LLM_STUDIO_MODEL"]).LLM_STUDIO_MODEL).toBe("qwen/qwen3-4b");
  });

  it("covers variables nobody listed — it is a rule about prefixes", () => {
    // Not just _MODEL: any suffix, including ones added after this was written.
    writeRei("LMSTUDIO_BASE_URL=http://1.2.3.4:1234/v1\nLMSTUDIO_UNA_VARIABLE_FUTURA=x\n");
    const env = resolve(["LLM_STUDIO_BASE_URL", "LLM_STUDIO_UNA_VARIABLE_FUTURA"]);
    expect(env.LLM_STUDIO_BASE_URL).toBe("http://1.2.3.4:1234/v1");
    expect(env.LLM_STUDIO_UNA_VARIABLE_FUTURA).toBe("x");
  });

  it("never overwrites the old spelling, so an existing .env keeps working", () => {
    // Upgrading must not change what a configured machine resolves to.
    writeRei("LLM_STUDIO_MODEL=el-viejo\nLMSTUDIO_MODEL=el-nuevo\n");
    expect(resolve(["LLM_STUDIO_MODEL"]).LLM_STUDIO_MODEL).toBe("el-viejo");
  });

  it("leaves the new spelling in place too, for anything reading it directly", () => {
    writeRei("LMSTUDIO_MODEL=qwen/qwen3-4b\n");
    expect(resolve(["LMSTUDIO_MODEL"]).LMSTUDIO_MODEL).toBe("qwen/qwen3-4b");
  });
});
