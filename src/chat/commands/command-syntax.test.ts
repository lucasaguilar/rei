import { describe, it, expect } from "vitest";
import { looksLikeCommand } from "./command-syntax.js";
import { COMMANDS } from "../../cli/constants/chat.constants.js";
import { commandInsertText } from "../../cli/constants/chat.constants.js";

/**
 * The regression: `/Users/dev/www/rei/Dockerfile y render.yaml no deberían ir al repo público`
 * came back as `Unknown command:` — a question about your own files, answered by the parser
 * instead of the model, because "starts with a slash" was the whole definition of a command.
 */
describe("looksLikeCommand", () => {
  it("rejects an absolute path, typed or dragged in", () => {
    expect(looksLikeCommand("/Users/dev/www/rei/Dockerfile ¿va al repo público?")).toBe(false);
    expect(looksLikeCommand("/etc/hosts")).toBe(false);
    expect(looksLikeCommand("/tmp/captura.png")).toBe(false);
    // A file that does not exist yet is just as much not-a-command.
    expect(looksLikeCommand("/Users/dev/todavia-no-existe.yaml")).toBe(false);
  });

  it("accepts every command REI actually ships", () => {
    for (const entry of COMMANDS) {
      const typed = commandInsertText(entry.command).trim();
      expect(looksLikeCommand(typed), entry.command).toBe(true);
    }
  });

  it("accepts a command with free-form arguments, including paths", () => {
    expect(looksLikeCommand("/mode ask")).toBe(true);
    expect(looksLikeCommand("/ask-document /Users/dev/notas/acta.pdf")).toBe(true);
    expect(looksLikeCommand("/session save-as refactor")).toBe(true);
  });

  it("rejects what is not a slash-word at all", () => {
    expect(looksLikeCommand("hola")).toBe(false);
    expect(looksLikeCommand("")).toBe(false);
    expect(looksLikeCommand("/")).toBe(false);
    expect(looksLikeCommand("//comentario")).toBe(false);
    expect(looksLikeCommand("2/3 de los tests")).toBe(false);
  });
});
