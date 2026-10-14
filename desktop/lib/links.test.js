import { describe, expect, it } from "vitest";
import { classifyLink } from "./links.js";

const WS = "/home/me/project";

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
    expect(classifyLink("file:///home/me/project/src/a.ts", WS)).toEqual({
      kind: "file",
      path: "/home/me/project/src/a.ts",
    });
    expect(classifyLink("file:///etc/passwd", WS)).toEqual({ kind: "refused" });
  });

  it("marks a web page inside the workspace, so it can open in the browser instead of Finder", () => {
    expect(classifyLink("file:///home/me/project/news/index.html", WS)).toEqual({
      kind: "file",
      path: "/home/me/project/news/index.html",
      page: true,
    });
    expect(classifyLink("file:///home/me/project/a.HTM", WS)).toMatchObject({ page: true });
    expect(classifyLink("file:///home/me/project/run.command", WS)).not.toHaveProperty("page");
  });

  it("is not fooled by .. or by a sibling folder that shares the prefix", () => {
    expect(classifyLink("file:///home/me/project/../secrets.txt", WS)).toEqual({ kind: "refused" });
    expect(classifyLink("file:///home/me/project-evil/a.ts", WS)).toEqual({ kind: "refused" });
  });

  it("refuses every other scheme and anything that is not a URL", () => {
    for (const raw of ["javascript:alert(1)", "data:text/html,<b>x</b>", "mailto:a@b.c", "ssh://host", "not a url", ""]) {
      expect(classifyLink(raw, WS), raw).toEqual({ kind: "refused" });
    }
  });
});
