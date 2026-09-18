import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rulesCommands, RULES_TEMPLATES_ROOT } from "./rules-commands.js";
import type { CommandContext, CommandResult } from "./command-handler.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-rules-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const run = async (command: string): Promise<CommandResult> =>
  (await rulesCommands.run({ command, workspacePath: ws } as CommandContext)) as CommandResult;

const rulesFile = () => join(ws, ".rei", "rules.md");

/**
 * Rules belong to the repo. REI used to ship an Angular ruleset inside its own source and inject it
 * into any workspace it detected as Angular — arbitrary (no other stack had one), invisible, and
 * duplicated for a project that had written its own. The template is now something you install
 * INTO your repo, which makes it yours to edit and obvious that it is being sent.
 */
describe("/rules", () => {
  it("reports that there are none, and what installing one would cost", async () => {
    const { response } = await run("/rules");
    expect(response).toContain("none");
    expect(response).toContain("/rules install");
  });

  it("reports the per-turn cost of the rules that exist", async () => {
    mkdirSync(join(ws, ".rei"), { recursive: true });
    writeFileSync(rulesFile(), "x".repeat(3700));
    const { response } = await run("/rules");
    expect(response).toContain("1,000 tokens"); // 3700 chars / 3.7
    expect(response).toContain("EVERY coding turn");
  });

  it("installs a stack ruleset into the WORKSPACE, not into REI", async () => {
    const result = await run("/rules install angular");
    expect(result.success).toBe(true);
    expect(existsSync(rulesFile())).toBe(true);
    const written = readFileSync(rulesFile(), "utf-8");
    expect(written).toContain("@if");
    expect(written).toBe(readFileSync(join(RULES_TEMPLATES_ROOT, "angular.md"), "utf-8"));
  });

  it("refuses to clobber rules the project already wrote", async () => {
    mkdirSync(join(ws, ".rei"), { recursive: true });
    writeFileSync(rulesFile(), "# nuestras reglas, ganadas a los golpes\n");
    const result = await run("/rules install angular");

    expect(result.success).toBe(false);
    expect(readFileSync(rulesFile(), "utf-8")).toContain("ganadas a los golpes");
  });

  it("says which stacks it has when asked for one it doesn't", async () => {
    const result = await run("/rules install cobol");
    expect(result.success).toBe(false);
    expect(result.response).toContain("angular");
    expect(existsSync(rulesFile())).toBe(false);
  });
});
