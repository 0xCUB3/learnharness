/*
 * Preload (2026-09-17, narrow-window wave): the ONLY bridge between the
 * sandboxed renderer and the main process. contextIsolation + sandbox are
 * on (electron/main.cjs), so this file is the renderer's entire access to
 * Electron — keep it a minimal, explicit API surface.
 *
 *   window.lh.expandWindow() — widen the window to the sidebar auto-close
 *   threshold (928px) when the sidebar is opened below it. The main
 *   process clamps: no-op if the window is already wide enough.
 *
 * Channel names are mirrored in electron/main.cjs — keep them in sync.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lh", {
	expandWindow: () => ipcRenderer.send("lh:expand-window"),
});
