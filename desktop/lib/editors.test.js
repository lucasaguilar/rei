import { describe, expect, it } from "vitest";
import { detectEditors, editorUrl, EDITORS, openTargets, pickTarget } from "./editors.js";

const byId = (id) => EDITORS.find((e) => e.id === id);

/** What Electron's app.getApplicationNameForProtocol answers on a machine with these apps. */
const machineWith = (apps) => (protocol) => apps[protocol] ?? "";

describe("editorUrl — how each editor is asked to open a path", () => {
  it("builds the editor's own file URL, which needs no command on PATH", () => {
    expect(editorUrl(byId("vscode"), "/home/me/project/src/a.ts")).toBe("vscode://file/home/me/project/src/a.ts");
    expect(editorUrl(byId("cursor"), "/home/me/project")).toBe("cursor://file/home/me/project");
    expect(editorUrl(byId("zed"), "/home/me/project/a.ts")).toBe("zed://file/home/me/project/a.ts");
  });

  it("escapes what would end the path early or break the URL — a space, a # or a ?", () => {
    expect(editorUrl(byId("vscode"), "/home/me/my project/#notes?.md")).toBe(
      "vscode://file/home/me/my%20project/%23notes%3F.md",
    );
  });
});

describe("detectEditors — only what is installed is offered", () => {
  it("keeps the editors whose URL scheme some app answers to, in preference order", () => {
    const found = detectEditors(machineWith({ "zed://": "Zed", "vscode://": "Visual Studio Code" }));
    expect(found.map((e) => e.id)).toEqual(["vscode", "zed"]);
  });

  it("offers nothing on a machine with no known editor", () => {
    expect(detectEditors(machineWith({}))).toEqual([]);
  });
});

describe("openTargets — what the panel's selector lists", () => {
  it("lists the installed editors, then the file manager, which every machine has", () => {
    const targets = openTargets([byId("vscode"), byId("zed")], "Finder");
    expect(targets.map((t) => t.id)).toEqual(["vscode", "zed", "finder"]);
    expect(targets.at(-1)).toMatchObject({ name: "Finder", manager: true });
  });

  it("still offers the file manager on a machine with no editor at all", () => {
    expect(openTargets([], "Finder").map((t) => t.id)).toEqual(["finder"]);
  });
});

describe("pickTarget — which one a click opens", () => {
  const targets = openTargets([byId("vscode"), byId("zed")], "Finder");

  it("honours the user's choice while it is installed — the file manager included", () => {
    expect(pickTarget(targets, "zed").id).toBe("zed");
    expect(pickTarget(targets, "finder").id).toBe("finder");
  });

  it("falls back to the first one when there is no choice, or it was uninstalled", () => {
    expect(pickTarget(targets, undefined).id).toBe("vscode");
    expect(pickTarget(targets, "cursor").id).toBe("vscode");
  });
});
