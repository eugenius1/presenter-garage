import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell, type IpcMainInvokeEvent } from "electron";
import { CHANNELS, channelName, type Reply } from "./channels";
import { defaultBackupDir } from "@presenter-garage/node/write";
import { createHandlers } from "./handlers";
import { assetPath, contentType } from "./serve";

/**
 * The desktop app: the web app, unchanged, in a window, with the main process
 * standing in for the browser's folder access.
 *
 * Electron rather than Tauri so that the main process runs `packages/node`
 * as it is -- `node:sqlite` and all -- and there is one write path, the MCP
 * server's (#29). The page runs sandboxed with context isolation and no
 * Node; what it can ask for is `channels.ts`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEME = "app";
const ORIGIN = `${SCHEME}://garage`;
/** Set by `scripts/dev.mjs` to load the web app's dev server instead of its build. Never in a packaged app. */
const devServer = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL;
/** Set by `scripts/smoke.mjs`: load the page, check it came up with its bridge, and quit with the answer. */
const smoke = process.env.PRESENTER_GARAGE_SMOKE === "1";

app.setName("Presenter Garage");

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/**
 * One copy at a time. The write path runs one apply after another within a
 * process; two copies of the app would each keep their own queue, and both
 * could pass their checks on the same song before either wrote it.
 */
if (!smoke && !app.requestSingleInstanceLock()) app.quit();

/** Whether a call came from our own page, and not from anything it might have navigated to. */
function fromOurPage(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? "";
  return url.startsWith(`${ORIGIN}/`) || (devServer !== undefined && url.startsWith(devServer));
}

function registerHandlers(): void {
  const handlers = createHandlers({
    chooseFolder: async () => {
      const window = BrowserWindow.getFocusedWindow();
      const options = { properties: ["openDirectory" as const] };
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return picked.canceled ? undefined : picked.filePaths[0];
    },
    showFolder: async (dir) => {
      const failed = await shell.openPath(dir);
      if (failed) throw new Error(failed);
    },
    stateFile: path.join(app.getPath("userData"), "state.json"),
    // The MCP server's default too, so every run on this computer is in one place.
    backupDir: defaultBackupDir(),
  });

  for (const channel of CHANNELS) {
    ipcMain.handle(channelName(channel), async (event, ...args): Promise<Reply<unknown>> => {
      if (!fromOurPage(event)) return { ok: false, error: "Refused: the call did not come from the app's own page." };
      try {
        const handler = handlers[channel] as (...a: unknown[]) => Promise<unknown>;
        return { ok: true, value: await handler(...args) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
  }
}

const isWeb = (url: string) => /^https:\/\//i.test(url);

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: "Presenter Garage",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  window.once("ready-to-show", () => window.show());

  // Links out of the app -- the licence, the source, the MCP guide -- open in
  // the person's browser; nothing else is opened at all, in or out of the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(`${ORIGIN}/`) || (devServer && url.startsWith(devServer))) return;
    event.preventDefault();
    if (isWeb(url)) void shell.openExternal(url);
  });

  void window.loadURL(devServer ?? `${ORIGIN}/`);
  return window;
}

/** Checks the page came up and found its bridge, for CI on each system; exits 0 if so. */
function runSmoke(window: BrowserWindow): void {
  const fail = (why: string) => {
    console.error(`smoke: ${why}`);
    app.exit(1);
  };
  const timer = setTimeout(() => fail("the page did not load within 60 seconds"), 60_000);
  window.webContents.once("did-fail-load", (_e, code, description) => fail(`load failed: ${code} ${description}`));
  window.webContents.once("did-finish-load", async () => {
    try {
      // The page renders after load; give React a moment.
      const ready = await window.webContents.executeJavaScript(
        `new Promise((resolve) => {
          const deadline = Date.now() + 15000;
          (function check() {
            const ok = typeof window.presenterGarage === "object" && document.querySelector("#root")?.childElementCount > 0;
            if (ok || Date.now() > deadline) resolve(ok);
            else setTimeout(check, 100);
          })();
        }).then(async (ok) => ok && Array.isArray(await window.presenterGarage.workspaces()))`
      );
      clearTimeout(timer);
      if (!ready) return fail("the page rendered nothing, or found no bridge");
      console.log("smoke: ok");
      app.exit(0);
    } catch (e) {
      fail((e as Error).message);
    }
  });
}

void app.whenReady().then(() => {
  // The page needs no camera, notifications or anything else a site can ask for.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  const webDir = path.join(here, "web");
  protocol.handle(SCHEME, async (request) => {
    const file = assetPath(webDir, request.url);
    const response = await net.fetch(pathToFileURL(file).toString()).catch(() => undefined);
    if (!response?.ok) return new Response("Not found", { status: 404 });
    return new Response(response.body, { headers: { "content-type": contentType(file) } });
  });

  registerHandlers();
  const window = createWindow();
  if (smoke) runSmoke(window);

  app.on("second-instance", () => {
    const open = BrowserWindow.getAllWindows()[0];
    if (open?.isMinimized()) open.restore();
    open?.focus();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
