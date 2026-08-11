import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadRole, listRoles } from "./role-loader.js";

describe("role-loader", () => {
  let ws: string;
  const rolesDir = () => path.join(ws, ".rei", "roles");
  const writeRole = (file: string, content: string) => {
    fs.mkdirSync(rolesDir(), { recursive: true });
    fs.writeFileSync(path.join(rolesDir(), file), content);
  };

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-roles-"));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("loads the built-in auditor role (read-only planning profile)", () => {
    const r = loadRole("auditor", ws);
    expect(r).not.toBeNull();
    expect(r!.baseMode).toBe("planning");
    expect(r!.writeGlob).toBe("*.review.md");
    expect(r!.body.toLowerCase()).toContain("grounding"); // the non-negotiable is present
  });

  it("parses frontmatter fields from a custom workspace role", () => {
    writeRole(
      "security.md",
      `---\nname: security\ndescription: threat modeling\nbaseMode: ask\nwriteGlob: "*.sec.md"\npreferredModel: qwen3.6-27b\n---\nBody here.`,
    );
    const r = loadRole("security", ws)!;
    expect(r.baseMode).toBe("ask");
    expect(r.writeGlob).toBe("*.sec.md");
    expect(r.preferredModel).toBe("qwen3.6-27b");
    expect(r.description).toBe("threat modeling");
  });

  it("defaults baseMode to planning when omitted or invalid", () => {
    writeRole("x.md", `---\nname: x\ndescription: d\nbaseMode: bogus\n---\nbody`);
    expect(loadRole("x", ws)!.baseMode).toBe("planning");
  });

  it("workspace role overrides a built-in of the same name", () => {
    writeRole("auditor.md", `---\nname: auditor\ndescription: MY custom auditor\n---\ncustom body`);
    expect(loadRole("auditor", ws)!.description).toBe("MY custom auditor");
  });

  it("is case-insensitive and returns null for unknown roles", () => {
    expect(loadRole("AUDITOR", ws)).not.toBeNull();
    expect(loadRole("nope", ws)).toBeNull();
  });

  it("listRoles includes the built-in auditor", () => {
    expect(listRoles(ws).map((r) => r.name)).toContain("auditor");
  });
});
