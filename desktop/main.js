import { app, BrowserWindow, dialog, ipcMain } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import { missingBuild, reiLaunch, workspaceFromArgv } from "./lib/launch.js";
import { DEFAULT_PHOSPHOR, PHOSPHORS } from "./renderer/phosphors.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

let win;
let shell;
let shellListeners = [];

/**
 * Kills REI and resolves once the pty has really gone. Quitting while node-pty's native reader is
 * still alive aborts Electron (an uncaught Napi::Error), so the app waits — up to a second, after
 * which a stuck child is not worth hanging the window for.
 */
function stopShell() {
  const running = shell;
  if (!running) return Promise.resolve();
  shell = undefined;
  return new Promise((resolve) => {
    const done = () => {
      for (const l of shellListeners) l.dispose();
      shellListeners = [];
      resolve();
    };
    running.onExit(done);
    setTimeout(done, 1000);
    running.kill();
  });
}

async function chooseWorkspace() {
  const fromArgs = workspaceFromArgv(process.argv.slice(1));
  if (fromArgs) return fromArgs;
  const picked = await dialog.showOpenDialog({
    title: "Open a project in REI",
    properties: ["openDirectory"],
  });
  return picked.canceled ? os.homedir() : picked.filePaths[0];
}

async function createWindow() {
  if (missingBuild(repoRoot)) {
    dialog.showErrorBox("REI is not built", `Run \`npm run build\` in ${repoRoot} first.`);
    app.quit();
    return;
  }
  const workspace = await chooseWorkspace();
  const phosphor = DEFAULT_PHOSPHOR;

  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    title: `REI — ${path.basename(workspace)}`,
    backgroundColor: PHOSPHORS[phosphor].screen,
    show: !process.env.REI_DESKTOP_SNAPSHOT,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The renderer asks once it has measured the terminal, so REI's first frame is drawn at the
  // real size instead of 80x24 and then reflowed.
  ipcMain.handle("pty:start", (_e, { cols, rows }) => {
    if (shell) return;
    const launch = reiLaunch({ repoRoot, workspace, phosphor, env: process.env });
    shell = pty.spawn(launch.command, launch.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: launch.cwd,
      env: launch.env,
    });
    shellListeners = [
      shell.onData((data) => win?.webContents.send("pty:data", data)),
      shell.onExit(({ exitCode }) => {
        shell = undefined;
        win?.webContents.send("pty:exit", exitCode);
      }),
    ];
  });
  ipcMain.on("pty:write", (_e, data) => shell?.write(data));
  ipcMain.on("pty:resize", (_e, { cols, rows }) => shell?.resize(cols, rows));

  await win.loadFile(path.join(here, "renderer", "index.html"), { query: { phosphor } });

  // REI_DESKTOP_SNAPSHOT=<file.png>: draw, save one frame, quit — how a change to the screen is
  // checked without someone watching the window.
  const snapshot = process.env.REI_DESKTOP_SNAPSHOT;
  if (snapshot) {
    win.webContents.on("console-message", (e) => console.log(`[renderer] ${e.message}`));
    setTimeout(async () => {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(snapshot, image.toPNG());
      await stopShell();
      app.exit(0); // not quit(): nothing should get a chance to keep a snapshot run alive
    }, Number(process.env.REI_DESKTOP_SNAPSHOT_DELAY ?? 6000));
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", async () => {
  // Closing the window is closing REI: the pty must not outlive it as an orphan agent.
  await stopShell();
  app.quit();
});
