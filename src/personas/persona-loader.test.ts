import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadPersona, listPersonas, resolvePersonaTools } from "./persona-loader.js";

/**
 * Phase 1 of docs/persona-spec.md: reading and validating persona files. Strict on purpose — a
 * persona misconfigured on a public channel must fail loudly at load, not half-apply.
 */

let ws: string;
let builtinDir: string;

function write(dir: string, name: string, content: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), content);
}
const wsDir = () => path.join(ws, ".rei", "personas");
const load = (name: string) => loadPersona(name, ws, { builtinDir });

const persona = (fields: string, body = "You are the assistant of Acme Co.") =>
  `---\n${fields}\n---\n\n${body}\n`;

beforeEach(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rei-persona-ws-")));
  builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), "rei-persona-builtin-"));
});
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(builtinDir, { recursive: true, force: true });
});

describe("loadPersona — reading", () => {
  it("parses every field of the contract", () => {
    write(
      builtinDir,
      "sales",
      persona(
        [
          "name: sales",
          "description: Commercial assistant for Acme Co.",
          'tools: [read_files, grep_code, "mcp:*"]',
          "knowledgeDir: kb/sales",
          "preferredModel: qwen/qwen3.6-plus",
          "language: es",
          "maxReplyChars: 1200",
          'handoff: "To talk to a person: sales@acme.example"',
        ].join("\n"),
      ),
    );
    const r = load("sales");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.persona).toMatchObject({
      name: "sales",
      description: "Commercial assistant for Acme Co.",
      tools: ["read_files", "grep_code", "mcp:*"],
      knowledgeDir: path.join(ws, "kb", "sales"),
      preferredModel: "qwen/qwen3.6-plus",
      language: "es",
      maxReplyChars: 1200,
      handoff: "To talk to a person: sales@acme.example",
      source: "builtin",
    });
    expect(r.persona.body).toBe("You are the assistant of Acme Co.");
  });

  it("defaults: every tool the surface offers, the workspace, the user's language, a generic hand-off", () => {
    write(builtinDir, "general", persona("name: general\ndescription: General assistant"));
    const r = load("general");
    expect(r.ok && r.persona).toMatchObject({
      tools: undefined,
      knowledgeDir: undefined,
      language: "auto",
      maxReplyChars: undefined,
      handoff: "I can't help with that here.",
    });
  });

  it("the workspace's persona wins over the shipped one with the same name", () => {
    write(builtinDir, "sales", persona("name: sales\ndescription: shipped"));
    write(wsDir(), "sales", persona("name: sales\ndescription: the client's own"));
    const r = load("sales");
    expect(r.ok && r.persona.description).toBe("the client's own");
    expect(r.ok && r.persona.source).toBe("workspace");
  });

  it("is case-insensitive on the requested name", () => {
    write(builtinDir, "sales", persona("name: sales\ndescription: d"));
    expect(load("Sales").ok).toBe(true);
  });
});

describe("loadPersona — refusals", () => {
  const error = (name: string) => {
    const r = load(name);
    return r.ok ? "" : r.error;
  };

  it("says where it looked when the persona does not exist", () => {
    expect(error("ghost")).toMatch(/not found.*\.rei\/personas.*built-in/s);
  });

  it("refuses a name that could walk out of the personas directory", () => {
    // REI_PERSONA comes from an env file or a flag; "../" there must not read arbitrary .md files.
    fs.writeFileSync(path.join(ws, "secret.md"), persona("name: secret\ndescription: d"));
    for (const bad of ["../secret", "a/b", "..", "", "x y"]) {
      expect(error(bad)).toMatch(/invalid persona name/i);
    }
  });

  it("requires a description and a body", () => {
    write(builtinDir, "nodesc", persona("name: nodesc"));
    write(builtinDir, "nobody", persona("name: nobody\ndescription: d", ""));
    expect(error("nodesc")).toMatch(/description/);
    expect(error("nobody")).toMatch(/body/);
  });

  it("requires the name inside the file to match the file name", () => {
    write(builtinDir, "sales", persona("name: support\ndescription: d"));
    expect(error("sales")).toMatch(/name.*support.*sales/);
  });

  it("validates maxReplyChars, language and tools", () => {
    write(builtinDir, "a", persona("name: a\ndescription: d\nmaxReplyChars: lots"));
    write(builtinDir, "b", persona("name: b\ndescription: d\nmaxReplyChars: 0"));
    write(builtinDir, "c", persona("name: c\ndescription: d\nlanguage: spanish please"));
    write(builtinDir, "e", persona("name: e\ndescription: d\ntools: read_files"));
    expect(error("a")).toMatch(/maxReplyChars/);
    expect(error("b")).toMatch(/maxReplyChars/);
    expect(error("c")).toMatch(/language/);
    expect(error("e")).toMatch(/tools.*list/);
  });

  it("refuses a knowledgeDir outside the workspace or inside .rei/", () => {
    // .rei/ holds every conversation of a multi-user channel; a persona must not be pointed at it.
    const bad = ["../elsewhere", "/etc", ".rei", ".rei/sessions", "kb/../../out"];
    bad.forEach((dir, i) => write(builtinDir, `k${i}`, persona(`name: k${i}\ndescription: d\nknowledgeDir: ${dir}`)));
    bad.forEach((_, i) => expect(error(`k${i}`)).toMatch(/knowledgeDir/));
  });
});

describe("listPersonas", () => {
  it("lists every persona, the workspace's winning, and shows broken ones with their error", () => {
    write(builtinDir, "sales", persona("name: sales\ndescription: shipped"));
    write(builtinDir, "support", persona("name: support\ndescription: help desk"));
    write(wsDir(), "sales", persona("name: sales\ndescription: the client's own"));
    write(wsDir(), "broken", persona("name: broken"));
    const list = listPersonas(ws, { builtinDir });
    expect(list.map((p) => p.name)).toEqual(["broken", "sales", "support"]);
    expect(list.find((p) => p.name === "sales")).toMatchObject({ description: "the client's own", source: "workspace" });
    expect(list.find((p) => p.name === "broken")?.error).toMatch(/description/);
  });
});

describe("resolvePersonaTools — narrows, never widens", () => {
  const offered = ["read_files", "grep_code", "list_files", "web_search", "mcp:spotify/play", "mcp:spotify/search", "mcp:github/issues"];

  it("without a tools field, the persona gets what the surface offers", () => {
    expect(resolvePersonaTools({}, offered)).toEqual({ tools: offered, dropped: [] });
  });

  it("keeps only what is both listed and offered, and reports the rest", () => {
    const r = resolvePersonaTools({ tools: ["read_files", "run_command", "made_up"] }, offered);
    expect(r.tools).toEqual(["read_files"]);
    expect(r.dropped).toEqual(["run_command", "made_up"]);
  });

  it("mcp:* matches every offered MCP tool, mcp:<server>/* only that server's", () => {
    expect(resolvePersonaTools({ tools: ["mcp:*"] }, offered).tools).toEqual([
      "mcp:spotify/play",
      "mcp:spotify/search",
      "mcp:github/issues",
    ]);
    expect(resolvePersonaTools({ tools: ["mcp:spotify/*"] }, offered).tools).toEqual([
      "mcp:spotify/play",
      "mcp:spotify/search",
    ]);
  });

  it("matches MCP tools offered in their wire form (mcp:server__tool) too", () => {
    const wire = ["mcp:spotify__play"];
    expect(resolvePersonaTools({ tools: ["mcp:spotify/*"] }, wire).tools).toEqual(["mcp:spotify__play"]);
  });

  it("a pattern that matches nothing offered is reported, not silently ignored", () => {
    expect(resolvePersonaTools({ tools: ["mcp:slack/*"] }, offered).dropped).toEqual(["mcp:slack/*"]);
  });
});
