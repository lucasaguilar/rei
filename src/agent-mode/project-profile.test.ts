import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildProjectProfile } from "./project-profile.js";

describe("buildProjectProfile", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rei-profile-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const writePkg = (obj: unknown) =>
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(obj));

  it("flags ESM and says use import, not require", () => {
    writePkg({ type: "module" });
    const p = buildProjectProfile(dir);
    expect(p).toContain("ESM");
    expect(p).toContain("NOT `require`");
  });

  it("flags CommonJS when type is not module", () => {
    writePkg({ type: "commonjs" });
    expect(buildProjectProfile(dir)).toContain("CommonJS");
  });

  it("reports TypeScript when tsconfig.json is present", () => {
    writePkg({ type: "module" });
    fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
    const p = buildProjectProfile(dir);
    expect(p).toContain("typescript");
  });

  it("auto-detects non-JS/TS projects agnostically (e.g. Python, Rust)", () => {
    fs.writeFileSync(path.join(dir, "pyproject.toml"), "");
    const p = buildProjectProfile(dir);
    expect(p).toContain("python");
    expect(p).toContain("py_compile");
  });

  it("includes curated rules files (AGENTS.md, .rei/rules.md)", () => {
    writePkg({ type: "module" });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "Always prefer composition.");
    fs.mkdirSync(path.join(dir, ".rei"));
    fs.writeFileSync(path.join(dir, ".rei", "rules.md"), "REI rule: keep files under 400 lines.");
    const p = buildProjectProfile(dir);
    expect(p).toContain("From AGENTS.md");
    expect(p).toContain("prefer composition");
    expect(p).toContain("From .rei/rules.md");
    expect(p).toContain("under 400 lines");
  });

  it("returns empty string when there's nothing to say", () => {
    expect(buildProjectProfile(dir)).toBe("");
  });

  it("tolerates a malformed package.json without throwing", () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{ not valid json");
    expect(() => buildProjectProfile(dir)).not.toThrow();
  });
});

