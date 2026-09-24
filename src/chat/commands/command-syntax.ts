/**
 * What counts as a slash command, as opposed to text that merely starts with a slash.
 *
 * `startsWith("/")` was the whole test, and an absolute path is the obvious counter-example: a
 * dragged-in file or a question about one —
 *
 *   /Users/dev/www/rei/Dockerfile y render.yaml no deberían ir al repo público, ¿es correcto?
 *
 * — came back as `Unknown command:` and never reached the model. The message was not lost (it
 * stays in the buffer) but the turn was, and on a path you did not type by hand that reads as REI
 * refusing to look at your own repo.
 *
 * A command is one bare word after the slash: letters, digits, `-` or `_`, nothing else. Every
 * command REI has fits that (`/mode ask`, `/ask-document`, `/session save-as`), and no path does —
 * the second `/`, the `.` of an extension or a space in the name all disqualify it.
 */
const COMMAND_TOKEN = /^\/[A-Za-z][A-Za-z0-9_-]*$/;

export function looksLikeCommand(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return false;
  // Only the first word decides: the arguments are free-form (`/ask-document ./notas/a.md`).
  return COMMAND_TOKEN.test(trimmed.split(/\s+/)[0]);
}
