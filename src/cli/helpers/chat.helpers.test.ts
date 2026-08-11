import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildMentionEntries } from "./chat.helpers.js";

describe("buildMentionEntries — .rei artifacts in the @ picker", () => {
  let ws: string;
  const write = (rel: string, content = "x") => {
    const p = path.join(ws, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-mention-"));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("includes .rei/plans and .rei/specs .md files (and their reviews)", () => {
    write("src/app.ts");
    write(".rei/plans/my-plan.md");
    write(".rei/plans/my-plan.review.md"); // review lives next to the plan
    write(".rei/specs/my-spec.md");
    const values = buildMentionEntries(ws).map((e) => e.value);
    expect(values).toContain(".rei/plans/my-plan.md");
    expect(values).toContain(".rei/plans/my-plan.review.md");
    expect(values).toContain(".rei/specs/my-spec.md");
    expect(values).toContain("src/app.ts"); // normal scan still works
    // the .rei/plans folder itself is offered as a dir entry
    expect(values).toContain(".rei/plans/");
  });

  it("does NOT include other .rei internals (logs/sessions stay hidden)", () => {
    write(".rei/logs/agent-flow.jsonl");
    write(".rei/sessions/current.json");
    write(".rei/plans/p.md");
    const values = buildMentionEntries(ws).map((e) => e.value);
    expect(values.some((v) => v.includes(".rei/logs"))).toBe(false);
    expect(values.some((v) => v.includes(".rei/sessions"))).toBe(false);
  });

  it("is fine when .rei/plans and .rei/specs don't exist yet", () => {
    write("src/only.ts");
    expect(() => buildMentionEntries(ws)).not.toThrow();
    expect(buildMentionEntries(ws).map((e) => e.value)).toContain("src/only.ts");
  });
});
