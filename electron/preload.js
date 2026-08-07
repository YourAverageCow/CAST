// Narrow, explicit bridge between the page (web/app.js, still treated as
// ordinary untrusted web content — contextIsolation stays on, nodeIntegration
// stays off) and Electron's native side. The page gets exactly these calls
// and nothing else — no raw ipcRenderer, no Node/fs/child_process access.
// Widening this surface should be a deliberate, individually-reviewed choice.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  getAppInfo: () => ipcRenderer.invoke("get-app-info"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  quitAndInstall: () => ipcRenderer.invoke("quit-and-install"),
  openReleasesPage: () => ipcRenderer.invoke("open-releases-page"),
  chooseOutputFolder: () => ipcRenderer.invoke("choose-output-folder"),
  saveVideoFile: (bytes, folder, filename) => ipcRenderer.invoke("save-video-file", bytes, folder, filename),
  // Returns an unsubscribe function, same convention as DOM addEventListener.
  onUpdateStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on("update-status", handler);
    return () => ipcRenderer.removeListener("update-status", handler);
  },
});
