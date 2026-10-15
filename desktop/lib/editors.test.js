import { describe, expect, it } from "vitest";
import { detectEditors, editorUrl, EDITORS, pickEditor } from "./editors.js";

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

describe("pickEditor — which one a click opens", () => {
  const installed = [byId("vscode"), byId("zed")];

  it("honours the user's choice while it is installed", () => {
    expect(pickEditor(installed, "zed")).toBe(byId("zed"));
  });

  it("falls back to the first installed one when there is no choice, or it was uninstalled", () => {
    expect(pickEditor(installed, undefined)).toBe(byId("vscode"));
    expect(pickEditor(installed, "cursor")).toBe(byId("vscode"));
  });

  it("returns null when there is nothing to open with", () => {
    expect(pickEditor([], "vscode")).toBeNull();
  });
});
