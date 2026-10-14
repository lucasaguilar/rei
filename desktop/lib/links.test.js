import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyLink } from "./links.js";

// A real workspace on disk: the symlink cases only mean something against files that exist. Resolved
// with realpath because the temp dir itself can sit behind one (/var → /private/var on macOS).
let base;
let WS;
const url = (...parts) => pathToFileURL(path.join(...parts)).href;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rei-links-")));
  WS = path.join(base, "project");
  for (const dir of ["project/src", "project/news", "project-evil", "outside"]) {
    fs.mkdirSync(path.join(base, dir), { recursive: true });
  }
  for (const file of [
    "project/src/a.ts",
    "project/news/index.html",
    "project/a.HTM",
    "project/run.command",
    "project-evil/a.ts",
    "outside/secrets.txt",
    "secrets.txt",
  ]) {
    fs.writeFileSync(path.join(base, file), "");
  }
  fs.symlinkSync(path.join(base, "outside/secrets.txt"), path.join(WS, "secrets-link.txt"));
  fs.symlinkSync(path.join(base, "outside"), path.join(WS, "outside-dir"));
  fs.symlinkSync(path.join(WS, "run.command"), path.join(WS, "page.html"));
});

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe("classifyLink — what a click in the terminal may do", () => {
  it("sends http and https to the browser, naming the host the user is asked about", () => {
    expect(classifyLink("https://www.reuters.com/world/x?id=1", WS)).toEqual({
      kind: "web",
      url: "https://www.reuters.com/world/x?id=1",
      host: "www.reuters.com",
    });
    expect(classifyLink("http://localhost:3000/", WS)).toMatchObject({ kind: "web", host: "localhost:3000" });
  });

  it("shows a file inside the workspace, never one outside it", () => {
    expect(classifyLink(url(WS, "src/a.ts"), WS)).toEqual({ kind: "file", path: path.join(WS, "src/a.ts") });
    expect(classifyLink("file:///etc/passwd", WS)).toEqual({ kind: "refused" });
  });

  it("refuses a file that does not exist — there is nothing to show", () => {
    expect(classifyLink(url(WS, "src/missing.ts"), WS)).toEqual({ kind: "refused" });
  });

  it("marks a web page inside the workspace, so it can open in the browser instead of Finder", () => {
    expect(classifyLink(url(WS, "news/index.html"), WS)).toEqual({
      kind: "file",
      path: path.join(WS, "news/index.html"),
      page: true,
    });
    expect(classifyLink(url(WS, "a.HTM"), WS)).toMatchObject({ page: true });
    expect(classifyLink(url(WS, "run.command"), WS)).not.toHaveProperty("page");
  });

  it("is not fooled by .. or by a sibling folder that shares the prefix", () => {
    expect(classifyLink(`${url(WS)}/../secrets.txt`, WS)).toEqual({ kind: "refused" });
    expect(classifyLink(url(base, "project-evil/a.ts"), WS)).toEqual({ kind: "refused" });
  });

  it("is not fooled by a symlink inside the workspace that points outside it", () => {
    expect(classifyLink(url(WS, "secrets-link.txt"), WS)).toEqual({ kind: "refused" });
    expect(classifyLink(url(WS, "outside-dir/secrets.txt"), WS)).toEqual({ kind: "refused" });
  });

  it("judges a symlinked .html by what it points to: a .command behind it is not a web page", () => {
    // macOS opens a symlink as its target, so page.html → run.command would run the script.
    expect(classifyLink(url(WS, "page.html"), WS)).toEqual({ kind: "file", path: path.join(WS, "run.command") });
  });

  it("accepts a workspace given through a symlink", () => {
    const alias = path.join(base, "alias");
    fs.symlinkSync(WS, alias);
    expect(classifyLink(url(WS, "src/a.ts"), alias)).toEqual({ kind: "file", path: path.join(WS, "src/a.ts") });
  });

  it("refuses every other scheme and anything that is not a URL", () => {
    for (const raw of ["javascript:alert(1)", "data:text/html,<b>x</b>", "mailto:a@b.c", "ssh://host", "not a url", ""]) {
      expect(classifyLink(raw, WS), raw).toEqual({ kind: "refused" });
    }
  });
});
