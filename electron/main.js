// Electron main process — the standalone app is this same web/ UI +
// server.js backend (native ffmpeg/whisper rendering/transcription, same as
// the `node server.js` local-launch flow), just wrapped in a real app
// window instead of a browser tab. No separate backend implementation:
// requiring server.js runs its top-level `server.listen(...)` as a side
// effect, starting the exact same HTTP server this process then points a
// BrowserWindow at.
const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");

const PORT = 8123;
const RELEASES_URL = "https://github.com/YourAverageCow/Slopdaddy/releases";

// Manual, explicit flow rather than the auto-download shortcut — an
// unsigned build (no code-signing cert set up yet) makes the actual
// apply-update step untested/possibly unreliable on macOS (Squirrel.Mac
// generally expects a signed app), so downloading/installing only ever
// happens on direct user action from Settings, never silently in the
// background. Checking for an update, by contrast, is just a GitHub API
// call — that part needs no signing and is safe to do automatically.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

function sendUpdateStatus(win, status) {
  if (win && !win.isDestroyed()) win.webContents.send("update-status", status);
}

function wireUpdater(win) {
  autoUpdater.on("checking-for-update", () => sendUpdateStatus(win, { state: "checking" }));
  autoUpdater.on("update-available", (info) => sendUpdateStatus(win, { state: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => sendUpdateStatus(win, { state: "not-available" }));
  autoUpdater.on("error", (err) => {
    sendUpdateStatus(win, { state: "error", message: (err && err.message) || String(err) });
  });
  autoUpdater.on("download-progress", (progress) => {
    sendUpdateStatus(win, { state: "downloading", percent: progress.percent });
  });
  autoUpdater.on("update-downloaded", (info) => sendUpdateStatus(win, { state: "downloaded", version: info.version }));
}

ipcMain.handle("get-app-info", () => ({ version: app.getVersion(), isPackaged: app.isPackaged }));

ipcMain.handle("check-for-updates", async () => {
  // No app-update.yml exists outside a real packaged build (electron-builder
  // generates it from the `publish` config at package time) — calling
  // checkForUpdates() in dev mode throws a confusing low-level error, so
  // short-circuit with a clear message instead.
  if (!app.isPackaged) {
    return { ok: false, error: "Update checks only work in a packaged build, not `npm start` from source." };
  }
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle("download-update", async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle("quit-and-install", () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle("open-releases-page", () => shell.openExternal(RELEASES_URL));

ipcMain.handle("choose-output-folder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("save-video-file", async (_event, bytes, folder, filename) => {
  try {
    const filePath = path.join(folder, filename);
    fs.writeFileSync(filePath, Buffer.from(bytes));
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});
// Packaged builds get their icon from electron-builder's mac/win/linux
// config (build/icon.icns|ico|png) automatically — this is only for the
// window/taskbar icon during unpackaged `npm start` runs, where Electron
// would otherwise show its own default icon. Guarded with existsSync since
// icon-loading failures here are purely cosmetic and must never be allowed
// to block the backend/window from starting.
const ICON_PATH_CANDIDATE = path.join(__dirname, "..", "build", "icon.png");
const ICON_PATH = fs.existsSync(ICON_PATH_CANDIDATE) ? ICON_PATH_CANDIDATE : undefined;

function startBackend() {
  // server.js's own `server.on("error", ...)` already treats EADDRINUSE as
  // "another instance is already serving this" rather than crashing — safe
  // to require unconditionally even if the app (or a standalone
  // `node server.js`) is somehow already running.
  require(path.join(__dirname, "..", "server.js"));
}

// The server binds its port synchronously as part of requiring it above,
// but the OS-level listen can take a beat — poll briefly rather than
// assuming it's already accepting connections the instant require() returns.
function waitForServer(url, attempts = 30, delayMs = 100) {
  return new Promise((resolve, reject) => {
    const tryOnce = (n) => {
      require("http").get(url, (res) => {
        res.resume();
        resolve();
      }).on("error", () => {
        if (n <= 0) { reject(new Error("Backend never came up")); return; }
        setTimeout(() => tryOnce(n - 1), delayMs);
      });
    };
    tryOnce(attempts);
  });
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Slopdaddy",
    icon: ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  wireUpdater(win);

  try {
    await waitForServer(`http://localhost:${PORT}/`);
  } catch (e) {
    // Fall through and let loadURL itself surface the failure — better than
    // silently showing a blank window with no explanation.
  }
  win.loadURL(`http://localhost:${PORT}/`);

  // Automatic on launch, but check-only — never auto-downloads/installs (see
  // the autoDownload=false comment above). Settings' "Check for Updates"
  // button triggers the exact same check on demand via IPC.
  if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
}

app.whenReady().then(() => {
  // macOS's dock reads BrowserWindow's `icon` option inconsistently for
  // unpackaged (`npm start`) runs — packaged builds don't need this, since
  // electron-builder embeds build/icon.icns into the app bundle itself.
  // Purely cosmetic: never let a missing/unreadable icon file block startup
  // (confirmed live — an unhandled rejection here previously took down the
  // whole startup sequence before the backend/window ever got a chance to run).
  try {
    if (ICON_PATH && process.platform === "darwin" && app.dock) app.dock.setIcon(ICON_PATH);
  } catch (e) { /* cosmetic only */ }
  startBackend();
  createWindow();

  app.on("activate", () => {
    // macOS convention: clicking the dock icon with no windows open should
    // reopen one instead of doing nothing.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Standard convention everywhere except macOS, where apps commonly stay
  // running (with no windows) until explicitly quit from the dock/menu.
  if (process.platform !== "darwin") app.quit();
});
