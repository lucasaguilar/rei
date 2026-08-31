import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { grepCode, listFiles } from "./code-search.js";

/**
 * Fixture on disk instead of mocks: these tools ARE the shell call, so mocking the spawn would test
 * nothing. The tree is shaped like the failure that motivated the fallback fix — a minified vendor
 * JSON whose single huge line used to eat the whole output budget when the glob was ignored.
 * `.gitignore` is what makes ripgrep and the POSIX fallback agree on what to skip, so the same
 * assertions hold on a machine with rg and on one without.
 */
let ws: string;

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-codesearch-"));
  writeFileSync(join(ws, ".gitignore"), "node_modules/\n.rei/\n");
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(join(ws, "src/config"), { recursive: true });
  mkdirSync(join(ws, "node_modules/pkg"), { recursive: true });
  mkdirSync(join(ws, ".rei"), { recursive: true });

  writeFileSync(join(ws, "src/alpha.ts"), "const needleToken = 1;\nexport default needleToken;\n");
  writeFileSync(join(ws, "src/beta.ts"), "// needleToken appears here too\n");
  writeFileSync(join(ws, "src/config/gamma.ts"), "export const needleToken = 3;\n");
  writeFileSync(join(ws, "src/notes.md"), "needleToken in markdown, must not match a *.ts glob\n");
  // Minified-file shape: one enormous line that matches.
  writeFileSync(join(ws, "src/bundle.min.ts"), `const x="${"needleToken ".repeat(20000)}";\n`);
  writeFileSync(join(ws, "node_modules/pkg/vendor.ts"), "needleToken in vendor code\n");
  // The real case: one enormous line that eats the whole output budget when unclamped.
  writeFileSync(join(ws, ".rei/rag-index.json"), `{"chunks":["${"needleToken ".repeat(4000)}"]}\n`);
});

afterAll(() => rmSync(ws, { recursive: true, force: true }));

describe("grepCode", () => {
  it("finds matches and formats them as file:line: text", async () => {
    const out = await grepCode(ws, { pattern: "needleToken", glob: "*.ts" });
    expect(out).toMatch(/src\/alpha\.ts:1:/);
  });

  it("honors the glob — a .md file with the same token is excluded", async () => {
    const out = await grepCode(ws, { pattern: "needleToken", glob: "*.ts", maxResults: 100 });
    expect(out).not.toContain("notes.md");
  });

  it("skips vendor dirs so one minified line cannot eat the output budget", async () => {
    const out = await grepCode(ws, { pattern: "needleToken", glob: "*.ts", maxResults: 100 });
    expect(out).not.toContain("rag-index.json");
    expect(out).not.toContain("node_modules");
  });

  it("returns paths without a ./ prefix, so they can be fed straight to read_files", async () => {
    const out = await grepCode(ws, { pattern: "needleToken", glob: "*.ts" });
    expect(out).not.toMatch(/(^|\n)\.\//);
  });

  it("scopes to a subdirectory with 'path'", async () => {
    const out = await grepCode(ws, { pattern: "needleToken", path: "src/config", maxResults: 100 });
    expect(out).toContain("gamma.ts");
    expect(out).not.toContain("alpha.ts");
  });

  it("caps at maxResults and says how many were left out", async () => {
    const out = await grepCode(ws, { pattern: "needleToken", glob: "*.ts", maxResults: 1 });
    const hits = out.split("\n").filter((l) => /:\d+:/.test(l));
    expect(hits).toHaveLength(1);
    expect(out).toMatch(/more|capped/);
  });

  it("clamps a huge single line so it cannot starve the output budget", async () => {
    // A minified file is one enormous line; unclamped, a single match there fills MAX_OUTPUT_BYTES
    // and every real result is lost. ripgrep caps via --max-columns; the POSIX fallback does not.
    const out = await grepCode(ws, { pattern: "needleToken", glob: "*.ts", maxResults: 100 });
    const longest = Math.max(...out.split("\n").map((l) => l.length));
    expect(longest).toBeLessThan(400);
    expect(out).toContain("alpha.ts"); // the small file still shows up
  });

  it("reports no matches instead of returning an empty string", async () => {
    const out = await grepCode(ws, { pattern: "zzz_definitely_absent_zzz" });
    expect(out).toContain("no matches");
  });

  it("rejects an empty pattern", async () => {
    expect(await grepCode(ws, { pattern: "   " })).toMatch(/^ERROR/);
  });

  it("supports a real regex, not just a literal", async () => {
    const out = await grepCode(ws, { pattern: "const\\s+needle[A-Z]\\w+", glob: "*.ts" });
    expect(out).toMatch(/:\d+:/);
  });
});

describe("listFiles", () => {
  it("lists files matching a glob", async () => {
    const out = await listFiles(ws, { glob: "*.ts" });
    expect(out).toContain("src/alpha.ts");
    expect(out).not.toContain("notes.md");
  });

  it("excludes vendor dirs", async () => {
    const out = await listFiles(ws, { maxResults: 500 });
    expect(out).not.toContain("node_modules");
  });

  it("scopes to a subdirectory with 'path'", async () => {
    const out = await listFiles(ws, { path: "src/config" });
    expect(out).toContain("gamma.ts");
    expect(out).not.toContain("alpha.ts");
  });

  it("caps at maxResults and says so", async () => {
    const out = await listFiles(ws, { maxResults: 1 });
    const paths = out.split("\n").slice(1).filter((p) => p && !p.startsWith("…") && !p.startsWith("("));
    expect(paths).toHaveLength(1);
    expect(out).toMatch(/more|capped/);
  });

  it("reports when nothing matches", async () => {
    expect(await listFiles(ws, { glob: "*.nonexistent_ext" })).toContain("no files");
  });
});
