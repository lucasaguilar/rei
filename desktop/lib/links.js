import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What a click on a link in the terminal may do. Two kinds leave the app, both after asking:
 *  - http(s) → the user's browser;
 *  - file:// inside the workspace → shown in the file manager. Shown, never opened: opening a file
 *    can run it (a .command, an .app), and the text that named it came from a model. The one
 *    exception is a web page (`page: true`): REI builds sites, and an .html runs in the browser's
 *    sandbox, not as a program.
 * Paths are judged by what they really are, symlinks resolved: a link inside the workspace can point
 * outside it, and page.html → run.command would run the script, because macOS opens the target.
 * Everything else — javascript:, data:, a file outside the workspace or missing, garbage — is refused.
 */
export function classifyLink(raw, workspace) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "refused" };
  }

  if (url.protocol === "http:" || url.protocol === "https:") {
    return { kind: "web", url: url.href, host: url.host };
  }

  if (url.protocol === "file:") {
    let file;
    try {
      file = fs.realpathSync(fileURLToPath(url));
    } catch {
      return { kind: "refused" }; // file://other-host/…, or nothing there to show
    }
    let root;
    try {
      root = fs.realpathSync(workspace);
    } catch {
      return { kind: "refused" };
    }
    // root + separator, not a bare prefix: /project-evil starts with /project too.
    if (file === root || file.startsWith(root + path.sep)) {
      // Named against the resolved root too: against the one as given, a workspace reached through a
      // symlink would make the dialog ask about ../../private/….
      const name = path.relative(root, file) || path.basename(file);
      return /\.html?$/i.test(file) ? { kind: "file", path: file, name, page: true } : { kind: "file", path: file, name };
    }
  }

  return { kind: "refused" };
}
