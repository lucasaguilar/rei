import { describe, expect, it } from "vitest";
import { EDITORS } from "./editors.js";
import { linkPrompt } from "./link-prompt.js";

const vscode = EDITORS.find((e) => e.id === "vscode");
const web = { kind: "web", url: "https://www.reuters.com/world/x", host: "www.reuters.com" };
const file = { kind: "file", path: "/w/src/a.ts", name: "src/a.ts" };
const page = { kind: "file", path: "/w/news/index.html", name: "news/index.html", page: true };

/** The buttons as the user reads them, each with what it does. */
const buttons = (prompt) => prompt.choices.map((c) => `${c.label} → ${c.action ?? "nothing"}`);

describe("linkPrompt — what the dialog offers for a link", () => {
  it("offers to open a web address in the browser, and shows the whole address", () => {
    const prompt = linkPrompt(web, { editor: vscode, manager: "Finder" });
    expect(prompt.message).toBe("Open www.reuters.com in your browser?");
    expect(prompt.detail).toBe("https://www.reuters.com/world/x");
    expect(buttons(prompt)).toEqual(["Open → browser", "Cancel → nothing"]);
  });

  it("offers a workspace file to the editor first, Finder second", () => {
    const prompt = linkPrompt(file, { editor: vscode, manager: "Finder" });
    expect(prompt.message).toBe("Open src/a.ts?");
    expect(prompt.detail).toBe("/w/src/a.ts");
    expect(buttons(prompt)).toEqual(["Open in VS Code → editor", "Show in Finder → reveal", "Cancel → nothing"]);
  });

  it("offers a web page to the browser first and to the editor, to read its source", () => {
    const prompt = linkPrompt(page, { editor: vscode, manager: "Finder" });
    expect(buttons(prompt)).toEqual(["Open in browser → browser", "Open in VS Code → editor", "Cancel → nothing"]);
  });

  it("without an editor installed, asks exactly what it asked before", () => {
    expect(linkPrompt(file, { editor: null, manager: "Finder" })).toMatchObject({
      message: "Show src/a.ts in Finder?",
      choices: [{ label: "Show", action: "reveal" }, { label: "Cancel", action: null }],
    });
    expect(linkPrompt(page, { editor: null, manager: "Finder" })).toMatchObject({
      message: "Open news/index.html in your browser?",
      choices: [{ label: "Open", action: "browser" }, { label: "Cancel", action: null }],
    });
  });

  it("puts the first choice as the default and Cancel last, so Esc never opens anything", () => {
    const prompt = linkPrompt(file, { editor: vscode, manager: "Finder" });
    expect(prompt.defaultId).toBe(0);
    expect(prompt.cancelId).toBe(prompt.choices.length - 1);
    expect(prompt.choices[prompt.cancelId].action).toBeNull();
  });
});
