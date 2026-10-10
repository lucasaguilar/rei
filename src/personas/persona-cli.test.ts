import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { personaCommands } from "../chat/commands/persona-commands.js";
import { roleCommands } from "../chat/commands/role-commands.js";
import { saveSession, loadCurrentSession } from "../chat/session-store.js";
import { chooseStartupPersona, startupPersona } from "./persona-startup.js";
import type { CommandContext, CommandResult } from "../chat/commands/command-handler.js";
import type { ChatSession } from "../chat/types.js";

/** Phase 4 of docs/persona-spec.md: /persona, persistence, and which persona a session starts as. */

let ws: string;
beforeEach(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rei-persona-cli-")));
  const dir = path.join(ws, ".rei", "personas");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "sales.md"), "---\nname: sales\ndescription: Commercial assistant\n---\n\nYou sell.\n");
  fs.writeFileSync(path.join(dir, "broken.md"), "---\nname: broken\n---\n\nNo description.\n");
  fs.mkdirSync(path.join(ws, ".rei", "roles"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".rei", "roles", "reviewer.md"), "---\nname: reviewer\ndescription: d\nbaseMode: planning\n---\nBody.\n");
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

const session = (over: Partial<ChatSession> = {}): ChatSession =>
  ({ messages: [], mode: "ask", ...over }) as ChatSession;
const run = (command: string, s: ChatSession, handler = personaCommands): CommandResult =>
  handler.run({ command, session: s, workspacePath: ws } as unknown as CommandContext) as CommandResult;
const plain = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, "");

describe("/persona", () => {
  it("matches /persona and its arguments, nothing else", () => {
    for (const c of ["/persona", "/persona sales", "/persona off"]) expect(personaCommands.match(c)).toBe(true);
    expect(personaCommands.match("/personas")).toBe(false);
    expect(personaCommands.match("/role sales")).toBe(false);
  });

  it("lists the personas, marks the active one and shows a broken one with its error", () => {
    const out = plain(run("/persona", session({ persona: "sales" })).response);
    expect(out).toMatch(/▶ sales/);
    expect(out).toMatch(/broken.*description/s);
  });

  it("switches to a persona and saves it with the session", () => {
    const r = run("/persona sales", session());
    expect(r.success).toBe(true);
    expect(r.newSession?.persona).toBe("sales");
    expect(loadCurrentSession(ws)?.persona).toBe("sales");
  });

  it("refuses an unknown or broken persona and changes nothing", () => {
    for (const name of ["ghost", "broken"]) {
      const r = run(`/persona ${name}`, session());
      expect(r.success).toBe(false);
      expect(r.newSession).toBeUndefined();
      expect(r.response).toMatch(new RegExp(name));
    }
  });

  it("/persona off returns to plain REI, and that is saved too", () => {
    const r = run("/persona off", session({ persona: "sales" }));
    expect(r.newSession?.persona).toBeUndefined();
    expect(loadCurrentSession(ws)?.persona).toBeUndefined();
  });
});

describe("/role while a persona is active", () => {
  it("refuses instead of half-applying a posture the persona would ignore", () => {
    const r = run("/role reviewer", session({ persona: "sales" }), roleCommands);
    expect(r.success).toBe(false);
    expect(r.newSession).toBeUndefined();
    expect(r.response).toMatch(/persona.*sales.*\/persona off/s);
  });

  it("still lists roles", () => {
    expect(run("/roles", session({ persona: "sales" }), roleCommands).success).toBe(true);
  });
});

describe("persistence", () => {
  it("a saved session comes back with its persona", () => {
    saveSession(ws, { messages: [], mode: "ask", persona: "sales" });
    expect(loadCurrentSession(ws)?.persona).toBe("sales");
  });
});

describe("which persona a session starts as", () => {
  it("--persona beats the resumed session's, which beats REI_PERSONA", () => {
    expect(chooseStartupPersona({ flag: "a", persisted: "b", envDefault: "c", resumed: true })).toEqual({ name: "a", from: "--persona" });
    expect(chooseStartupPersona({ persisted: "b", envDefault: "c", resumed: true })).toEqual({ name: "b", from: "the saved session" });
    expect(chooseStartupPersona({ envDefault: "c", resumed: false })).toEqual({ name: "c", from: "REI_PERSONA" });
  });

  it("REI_PERSONA is for NEW sessions: a resumed one without a persona stays plain REI", () => {
    // It may have been switched off with /persona off; the config default must not undo that.
    expect(chooseStartupPersona({ envDefault: "c", resumed: true })).toEqual({});
  });

  it("an invalid choice is reported and the session starts as plain REI", () => {
    const r = startupPersona({ flag: "ghost", resumed: false, workspacePath: ws });
    expect(r.persona).toBeUndefined();
    expect(r.warning).toMatch(/ghost.*--persona.*plain REI/s);
    expect(startupPersona({ flag: "sales", resumed: false, workspacePath: ws })).toEqual({ persona: "sales" });
  });
});

describe("the shipped daily persona", () => {
  it("loads, and cannot touch the repository — no read tools, no knowledgeDir", async () => {
    const { loadPersona, resolvePersonaTools } = await import("./persona-loader.js");
    const r = loadPersona("daily", ws); // no .rei/personas/daily.md here → the shipped one
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.persona.source).toBe("builtin");
    expect(r.persona.knowledgeDir).toBeUndefined();
    const offered = ["read_files", "grep_code", "list_files", "run_command", "web_search", "weather", "mcp:spotify/play"];
    expect(resolvePersonaTools(r.persona, offered).tools).toEqual(["web_search", "weather", "mcp:spotify/play"]);
  });
});
