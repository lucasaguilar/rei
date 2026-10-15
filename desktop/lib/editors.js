/**
 * The code editors a file link — or the whole workspace — can be opened in, in the order one is
 * picked when the user has not chosen.
 *
 * Each is reached through its own URL scheme (`vscode://file/<path>`), handed to the OS like any
 * other address, not through its command-line launcher: a desktop app gets a bare PATH, so `code`
 * is often not there even when VS Code is installed. Opening a file in an editor shows it; it does
 * not run it, so this adds nothing to what a click on a link may do.
 */
export const EDITORS = [
  { id: "vscode", name: "VS Code", scheme: "vscode" },
  { id: "cursor", name: "Cursor", scheme: "cursor" },
  { id: "windsurf", name: "Windsurf", scheme: "windsurf" },
  { id: "zed", name: "Zed", scheme: "zed" },
  { id: "vscodium", name: "VSCodium", scheme: "vscodium" },
];

/** The URL that opens an absolute path (file or folder) in `editor`. */
export function editorUrl(editor, absPath) {
  // Segment by segment: a raw # or ? would end the path and turn the rest into a fragment/query.
  const encoded = absPath.split("/").map(encodeURIComponent).join("/");
  return `${editor.scheme}://file${encoded}`;
}

/**
 * The editors installed here. `nameForProtocol` is Electron's app.getApplicationNameForProtocol:
 * an app registered for the scheme answers with its name, otherwise the answer is "".
 */
export function detectEditors(nameForProtocol) {
  return EDITORS.filter((editor) => Boolean(nameForProtocol(`${editor.scheme}://`)));
}

/**
 * What the panel's selector lists: the installed editors, then the file manager. The file manager
 * is always there, so the desktop works the same with any editor — or none — installed.
 */
export function openTargets(installed, managerName) {
  return [...installed, { id: "finder", name: managerName, manager: true }];
}

/** The target a click opens: the user's choice while it is still offered, else the first one. */
export function pickTarget(targets, preferredId) {
  return targets.find((t) => t.id === preferredId) ?? targets[0];
}
