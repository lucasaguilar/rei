import { describe, it, expect } from "vitest";
import { COMMANDS, commandInsertText } from "./chat.constants.js";

/**
 * A COMMANDS entry doubles as its own help line, so tab-completion used to type the usage hint too:
 * picking `/runplan` left `/runplan [stage <num>]` in the input, and the placeholder had to be
 * deleted by hand every single time.
 */
describe("commandInsertText", () => {
  it("drops a bracketed placeholder and leaves the cursor ready for the argument", () => {
    expect(commandInsertText("/runplan [stage <num>]")).toBe("/runplan ");
    expect(commandInsertText("/think [level]")).toBe("/think ");
    expect(commandInsertText("/active [clear]")).toBe("/active ");
  });

  it("drops an angle-bracket placeholder", () => {
    expect(commandInsertText("/spec <task>")).toBe("/spec ");
    expect(commandInsertText("/savespec <name>")).toBe("/savespec ");
  });

  it("keeps a literal sub-command, cutting only at the placeholder", () => {
    expect(commandInsertText("/doc use <file>")).toBe("/doc use ");
  });

  it("leaves an argument-less command exactly as typed — ready to submit", () => {
    expect(commandInsertText("/help")).toBe("/help");
    expect(commandInsertText("/decompose")).toBe("/decompose");
  });

  it("never emits a placeholder for any real entry", () => {
    for (const { command } of COMMANDS) {
      const inserted = commandInsertText(command);
      expect(inserted, command).not.toMatch(/[[<>\]]/);
      expect(inserted.startsWith("/"), command).toBe(true);
    }
  });

  it("what it types still matches the palette filter, so the list does not vanish", () => {
    for (const { command } of COMMANDS) {
      const typed = commandInsertText(command).trim().toLowerCase();
      expect(command.toLowerCase().startsWith(typed), command).toBe(true);
    }
  });
});
