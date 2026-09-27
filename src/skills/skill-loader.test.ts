import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSkills, buildUseSkillTool, findSkill } from "./skill-loader.js";

describe("skill-loader", () => {
  let ws = "";
  let configHome = "";
  const savedXdg = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    ws = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rei-skills-test-"));
    // Isolate from the developer's real ~/.config/rei/skills.
    configHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rei-skills-xdg-"));
    process.env.XDG_CONFIG_HOME = configHome;
  });
  afterEach(async () => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (ws) await fs.promises.rm(ws, { recursive: true, force: true });
    if (configHome) await fs.promises.rm(configHome, { recursive: true, force: true });
  });

  async function writeSkill(dir: string, rel: string, content: string): Promise<void> {
    const file = path.join(dir, rel);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, content);
  }

  it("loads the <name>/SKILL.md layout used by Claude Code, gentle-ai and others", async () => {
    const dir = path.join(ws, ".rei", "skills");
    await writeSkill(dir, "named/SKILL.md", "---\nname: from-meta\ndescription: d\n---\nBody A.");
    await writeSkill(dir, "unnamed/SKILL.md", "---\ndescription: d\n---\nBody B.");

    const skills = loadSkills(ws);
    expect(skills.find((s) => s.name === "from-meta")?.body).toBe("Body A.");
    // Without `name:`, the directory names the skill — not "SKILL".
    expect(skills.find((s) => s.name === "unnamed")?.body).toBe("Body B.");
    expect(skills.find((s) => s.name === "SKILL")).toBeUndefined();
  });

  it("follows symlinked skill files and directories, as it did before the SKILL.md layout", async () => {
    const src = path.join(ws, "elsewhere");
    await writeSkill(src, "linked.md", "---\nname: linked-file\ndescription: d\n---\nFile.");
    await writeSkill(src, "dir/SKILL.md", "---\nname: linked-dir\ndescription: d\n---\nDir.");
    const dir = path.join(ws, ".rei", "skills");
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.symlink(path.join(src, "linked.md"), path.join(dir, "linked.md"));
    await fs.promises.symlink(path.join(src, "dir"), path.join(dir, "linked-dir"));

    const skills = loadSkills(ws);
    expect(skills.find((s) => s.name === "linked-file")?.body).toBe("File.");
    expect(skills.find((s) => s.name === "linked-dir")?.body).toBe("Dir.");
  });

  it("unwraps quoted descriptions and joins YAML block scalars", async () => {
    const dir = path.join(ws, ".rei", "skills");
    await writeSkill(
      dir,
      "quoted/SKILL.md",
      '---\nname: quoted\ndescription: "Trigger: PRs. Split them."\nlicense: MIT\n---\nB.',
    );
    await writeSkill(
      dir,
      "folded/SKILL.md",
      "---\nname: folded\ndescription: >\n  Create Jira tasks.\n  Trigger: ticket.\nmetadata:\n  version: \"1\"\n---\nB.",
    );

    const skills = loadSkills(ws);
    expect(skills.find((s) => s.name === "quoted")?.description).toBe("Trigger: PRs. Split them.");
    expect(skills.find((s) => s.name === "folded")?.description).toBe(
      "Create Jira tasks. Trigger: ticket.",
    );
  });

  it("loads user-global skills, overridden by the workspace", async () => {
    const global = path.join(configHome, "rei", "skills");
    await writeSkill(global, "shared/SKILL.md", "---\nname: shared\ndescription: g\n---\nGlobal.");
    await writeSkill(global, "only-global.md", "---\nname: only-global\ndescription: g\n---\nG.");
    await writeSkill(global, "create-pr.md", "---\nname: create-pr\ndescription: g\n---\nGlobal PR.");
    await writeSkill(
      path.join(ws, ".rei", "skills"),
      "shared.md",
      "---\nname: shared\ndescription: w\n---\nWorkspace.",
    );

    const skills = loadSkills(ws);
    expect(skills.find((s) => s.name === "only-global")?.body).toBe("G.");
    // global beats built-in, workspace beats global
    expect(skills.find((s) => s.name === "create-pr")?.body).toBe("Global PR.");
    expect(skills.find((s) => s.name === "shared")?.body).toBe("Workspace.");
  });

  it("loads the built-in skills with name + description + body", () => {
    const skills = loadSkills(ws);
    const names = skills.map((s) => s.name);
    expect(names).toContain("create-pr");
    expect(names).toContain("write-tests");
    const pr = skills.find((s) => s.name === "create-pr")!;
    expect(pr.description.length).toBeGreaterThan(0);
    expect(pr.body.length).toBeGreaterThan(0);
  });

  it("exposes only the catalog (name + description) in the use_skill tool", () => {
    const skills = loadSkills(ws);
    const tool = buildUseSkillTool(skills)!;
    expect(tool.function.name).toBe("use_skill");
    // Catalog lists names; full bodies must NOT be in the tool description.
    expect(tool.function.description).toContain("create-pr");
    const pr = skills.find((s) => s.name === "create-pr")!;
    expect(tool.function.description).not.toContain(pr.body);
  });

  it("loads a workspace skill and overrides a built-in of the same name", async () => {
    const dir = path.join(ws, ".rei", "skills");
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, "my-skill.md"),
      "---\nname: my-skill\ndescription: a custom one\n---\nDo the thing.",
    );
    await fs.promises.writeFile(
      path.join(dir, "create-pr.md"),
      "---\nname: create-pr\ndescription: overridden\n---\nMy own PR flow.",
    );

    const skills = loadSkills(ws);
    expect(skills.find((s) => s.name === "my-skill")?.body).toBe("Do the thing.");
    // workspace version wins over built-in
    expect(skills.find((s) => s.name === "create-pr")?.body).toBe("My own PR flow.");
  });

  it("findSkill resolves exact and fuzzy names", () => {
    const skills = loadSkills(ws);
    expect(findSkill(skills, "create-pr")?.name).toBe("create-pr");
    expect(findSkill(skills, "Create-PR")?.name).toBe("create-pr");
    expect(findSkill(skills, "nonexistent-xyz")).toBeUndefined();
  });

  it("returns null tool when there are no skills", () => {
    expect(buildUseSkillTool([])).toBeNull();
  });
});
