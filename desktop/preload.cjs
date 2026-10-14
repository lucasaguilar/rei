// The renderer's only door to the pty. CommonJS because sandboxed preloads cannot be ESM.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rei", {
  start: (size) => ipcRenderer.invoke("pty:start", size),
  write: (data) => ipcRenderer.send("pty:write", data),
  resize: (cols, rows) => ipcRenderer.send("pty:resize", { cols, rows }),
  onData: (fn) => ipcRenderer.on("pty:data", (_e, data) => fn(data)),
  onExit: (fn) => ipcRenderer.on("pty:exit", (_e, code) => fn(code)),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch) => ipcRenderer.send("settings:set", patch),
  openLink: (url) => ipcRenderer.invoke("link:open", url),
});
