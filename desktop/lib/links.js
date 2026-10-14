import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What a click on a link in the terminal may do. Two kinds leave the app, both after asking:
 *  - http(s) → the user's browser;
 *  - file:// inside the workspace → shown in the file manager. Shown, never opened: opening a file
 *    can run it (a .command, an .app), and the text that named it came from a model. The one
 *    exception is a web page (`page: true`): REI builds sites, and an .html runs in the browser's
 *    sandbox, not as a program.
 * Everything else — javascript:, data:, a file outside the workspace, garbage — is refused.
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
      file = path.resolve(fileURLToPath(url));
    } catch {
      return { kind: "refused" }; // file://other-host/… — not a local path
    }
    const root = path.resolve(workspace);
    // root + separator, not a bare prefix: /project-evil starts with /project too.
    if (file === root || file.startsWith(root + path.sep)) {
      return /\.html?$/i.test(file) ? { kind: "file", path: file, page: true } : { kind: "file", path: file };
    }
  }

  return { kind: "refused" };
}
