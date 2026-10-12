const { contextBridge, ipcRenderer } = require("electron");

// If this line is missing from the DevTools console, main.js is not loading
// this file and nothing below reaches the page.
console.log("[preload] loaded");

contextBridge.exposeInMainWorld("launcher", {
  bridgeVersion: 8,
  getConfig: () => ipcRenderer.invoke("config:get"),
  getAddresses: () => ipcRenderer.invoke("network:addresses"),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
  saveConfig: (cfg) => ipcRenderer.invoke("config:save", cfg),
  browse: (current) => ipcRenderer.invoke("dialog:browse", current),
  runService: (svc) => ipcRenderer.invoke("service:run", svc),
  runAll: (cfg) => ipcRenderer.invoke("service:run-all", cfg),
  stopService: (svc) => ipcRenderer.invoke("service:stop", svc),
  stopAll: (cfg) => ipcRenderer.invoke("service:stop-all", cfg),
  fixMysql: (svc) => ipcRenderer.invoke("service:fix-mysql", svc),
  getStatus: () => ipcRenderer.invoke("service:status"),
  onStatus: (cb) => ipcRenderer.on("launcher:status", (_e, data) => cb(data)),
  onStartupProgress: (cb) => ipcRenderer.on("launcher:startup-progress", (_e, data) => cb(data)),
  onLog: (cb) => ipcRenderer.on("launcher:log", (_e, msg) => cb(msg)),
  onClosing: (cb) => ipcRenderer.on("launcher:closing", () => cb()),
  onConfirmClose: (cb) => ipcRenderer.on("launcher:confirm-close", (_e, running) => cb(running)),
  answerClose: (answer) => ipcRenderer.invoke("close:answer", answer)
});
