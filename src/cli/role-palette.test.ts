import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRoleCommandEntries } from "./helpers/chat.helpers.js";
import { getCommandPalette } from "./helpers/chat-input.helpers.js";
import { commandInsertText } from "./constants/chat.constants.js";
import type { ChatUIState } from "./models/chat.types.js";

let ws: string;

// listRoles merges the built-in roles shipped in prompts/roles/ with the workspace's own, so a
// fresh temp workspace already has `auditor`. Assertions below name their role rather than
// assuming the list is empty.
const names = (ws: string) => buildRoleCommandEntries(ws).map((e) => e.command);

const role = (name: string, description = "does a thing") =>
  writeFileSync(
    join(ws, ".rei", "roles", `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\nbaseMode: planning\n---\nBody.\n`,
  );

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-palette-"));
  mkdirSync(join(ws, ".rei", "roles"), { recursive: true });
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const state = (input: string): ChatUIState =>
  ({ inputBuffer: input, busy: false, paletteClosed: false }) as ChatUIState;

describe("buildRoleCommandEntries", () => {
  it("turns a role file into an invocable palette entry", () => {
    role("reviewer", "reviews plans");
    const entry = buildRoleCommandEntries(ws).find((e) => e.command.startsWith("/reviewer"))!;
    expect(entry.command).toBe("/reviewer <task>");
    expect(entry.description).toContain("reviews plans");
  });

  it("marks it as a role, so it is not mistaken for a built-in", () => {
    role("reviewer");
    const entry = buildRoleCommandEntries(ws).find((e) => e.command.startsWith("/reviewer"))!;
    expect(entry.description).toContain("role ·");
  });

  it("leaves out a role shadowed by a built-in command", () => {
    // Completing `/trace` to the role would insert something that runs the built-in instead.
    role("trace");
    role("reviewer");
    expect(names(ws)).toContain("/reviewer <task>");
    expect(names(ws)).not.toContain("/trace <task>");
  });

  it("still offers the built-in roles when the workspace has no roles dir of its own", () => {
    expect(names(join(ws, "nope"))).toContain("/auditor <task>");
  });
});

describe("the palette completes a role name", () => {
  it("offers the role for a prefix of its name", () => {
    const items = getCommandPalette(state("/aud"), buildRoleCommandEntries(ws));
    expect(items.map((i) => i.command)).toContain("/auditor <task>");
  });

  it("inserts just the name and a space, leaving the cursor on the task", () => {
    const entry = buildRoleCommandEntries(ws).find((e) => e.command.startsWith("/auditor"))!;
    expect(commandInsertText(entry.command)).toBe("/auditor ");
  });

  it("lists roles after the built-ins on a bare /", () => {
    role("reviewer");
    const items = getCommandPalette(state("/"), buildRoleCommandEntries(ws));
    expect(items[0].command).toBe("/exit"); // the first built-in, unchanged
    // Mirrors dispatch: every static command comes before the first data-driven one.
    const firstRole = items.findIndex((i) => i.description.startsWith("role ·"));
    const lastBuiltin = items.map((i) => i.description.startsWith("role ·")).lastIndexOf(false);
    expect(firstRole).toBeGreaterThan(lastBuiltin);
  });

  it("still offers the built-in when a prefix matches both", () => {
    role("rolodex"); // shares the "/rol" prefix with /role and /roles
    const items = getCommandPalette(state("/rol"), buildRoleCommandEntries(ws));
    expect(items.map((i) => i.command)).toContain("/roles");
    expect(items.map((i) => i.command)).toContain("/rolodex <task>");
  });

  it("behaves exactly as before when there are no roles", () => {
    expect(getCommandPalette(state("/ex"), [])).toEqual(getCommandPalette(state("/ex")));
  });

  it("matches case-insensitively, as the built-ins already did", () => {
    expect(getCommandPalette(state("/AUD"), buildRoleCommandEntries(ws))).toHaveLength(1);
  });
});

/**
 * A role has two invocations and both get typed, so both complete. Only the isolated form was
 * offered, which left `/role git-` with nothing: the palette matches whole commands by prefix, and
 * `/role <name>` is not in the static command list — it exists only because a file does.
 */
describe("both ways to invoke a role complete", () => {
  it("offers /role <name> for a prefix of the name", () => {
    role("git-expert");
    const items = getCommandPalette(state("/role git-"), buildRoleCommandEntries(ws));
    expect(items.map((i) => i.command)).toContain("/role git-expert");
  });

  it("inserts it ready to send, with no placeholder to delete", () => {
    // Unlike `/git-expert <task>`, this one is complete as typed.
    expect(commandInsertText("/role git-expert")).toBe("/role git-expert");
  });

  it("still offers the isolated form on the bare name", () => {
    role("git-expert");
    const items = getCommandPalette(state("/git-"), buildRoleCommandEntries(ws));
    expect(items.map((i) => i.command)).toContain("/git-expert <task>");
  });

  it("gives every role exactly two entries", () => {
    role("reviewer");
    const mine = buildRoleCommandEntries(ws).filter((e) => e.command.includes("reviewer"));
    expect(mine.map((e) => e.command).sort()).toEqual(["/reviewer <task>", "/role reviewer"]);
  });

  it("leaves the built-in /role and /roles reachable", () => {
    role("reviewer");
    const items = getCommandPalette(state("/role"), buildRoleCommandEntries(ws));
    expect(items.map((i) => i.command)).toContain("/roles");
  });

  it("does not offer /role <name> for a role shadowed by a built-in", () => {
    role("trace");
    expect(buildRoleCommandEntries(ws).map((e) => e.command)).not.toContain("/role trace");
  });
});
