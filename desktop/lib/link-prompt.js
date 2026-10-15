/**
 * The dialog a click on a link raises: what it asks, which buttons it offers and what each one does.
 * Pure, so the choices can be tested without Electron; main.js shows it and carries out the answer.
 *
 * Actions: "browser" (the system browser), "reveal" (the file manager), "editor" (the user's code
 * editor), null (Cancel). Cancel is always last and the first choice is the default, so Esc never
 * opens anything. `detail` is the whole address, because the link's visible text can say anything.
 *
 * With no editor installed the dialog is exactly the one from before editors existed.
 */
export function linkPrompt(link, { editor, manager }) {
  const cancel = { label: "Cancel", action: null };
  const toEditor = editor ? [{ label: `Open in ${editor.name}`, action: "editor" }] : [];

  if (link.kind === "web") {
    return prompt(`Open ${link.host} in your browser?`, link.url, [{ label: "Open", action: "browser" }, cancel]);
  }
  if (link.page) {
    return editor
      ? prompt(`Open ${link.name}?`, link.path, [{ label: "Open in browser", action: "browser" }, ...toEditor, cancel])
      : prompt(`Open ${link.name} in your browser?`, link.path, [{ label: "Open", action: "browser" }, cancel]);
  }
  return editor
    ? prompt(`Open ${link.name}?`, link.path, [...toEditor, { label: `Show in ${manager}`, action: "reveal" }, cancel])
    : prompt(`Show ${link.name} in ${manager}?`, link.path, [{ label: "Show", action: "reveal" }, cancel]);
}

function prompt(message, detail, choices) {
  return { message, detail, choices, defaultId: 0, cancelId: choices.length - 1 };
}
