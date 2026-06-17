import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSkills, buildUseSkillTool, findSkill } from "./skill-loader.js";

describe("skill-loader", () => {
  let ws = "";

  beforeEach(async () => {
    ws = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rei-skills-test-"));
  });
  afterEach(async () => {
    if (ws) await fs.promises.rm(ws, { recursive: true, force: true });
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
