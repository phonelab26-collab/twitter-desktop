/**
 * Electron entry point. The window is locked down: context isolation, no Node
 * in the renderer, sandboxed preload, CSP, no navigation away from the app
 * and no new windows. Process-wide protections live in guard.ts, the "Mon X"
 * view in xview.ts.
 */
import { app, BrowserWindow, session, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createXService } from './api/service';
import { failStart, installGlobalGuards, refuseDangerousSwitches } from './guard';
import { registerIpcHandlers } from './ipc';
import { installMenu } from './menu';
import { XViewController } from './xview';
import { APP_NAVIGATE_EVENT } from '../shared/ipc';

refuseDangerousSwitches();

if (!app.isPackaged) {
  // Development never shares a profile with the packaged app (whose cookies are encrypted)
  // nor with other Electron apps run from a terminal (default profile name "Electron").
  app.setPath('userData', join(app.getPath('appData'), 'Twitter Desktop (dev)'));
}

/**
 * `npm run dev` passes `--dev-server=<url>` (the Vite server for src/renderer).
 * Never honoured in a packaged app (guard.ts also refuses the switch there),
 * and only a localhost URL is accepted.
 */
const DEV_SERVER_URL = app.isPackaged
  ? undefined
  : process.argv
      .find((arg) => arg.startsWith('--dev-server='))
      ?.slice('--dev-server='.length)
      .match(/^http:\/\/localhost:\d+\/?$/)?.[0];
const DEV_SERVER_RETRY_MS = 500;
const DEV_SERVER_MAX_ATTEMPTS = 60;

const RENDERER_INDEX = join(__dirname, '..', 'renderer', 'index.html');
const RENDERER_URL = pathToFileURL(RENDERER_INDEX).href;

/** Images and videos come from X's CDNs; nothing else is loaded remotely. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // Vite's React preamble is an inline script: allowed in dev only.
  "script-src 'self'" + (DEV_SERVER_URL ? " 'unsafe-inline'" : ''),
  "style-src 'self' 'unsafe-inline'",
  'img-src https://pbs.twimg.com https://abs.twimg.com data:',
  'media-src https://video.twimg.com',
  "connect-src 'self'" + (DEV_SERVER_URL ? ' ws: http://localhost:*' : ''),
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Same origin as the dev server; a prefix test would also accept localhost:5273.evil.com. */
function isDevServerUrl(url: string): boolean {
  if (!DEV_SERVER_URL) return false;
  try {
    return new URL(url).origin === new URL(DEV_SERVER_URL).origin;
  } catch {
    return false;
  }
}

/** The app's own page: the built index.html, or the dev server in development. */
function isAppPageUrl(url: string): boolean {
  return url.split('#')[0] === RENDERER_URL || isDevServerUrl(url);
}

/** The app needs no camera, notification, geolocation... permission: deny all. */
function hardenDefaultSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setSpellCheckerEnabled(false);
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CONTENT_SECURITY_POLICY] },
    });
  });
}

/** Waits for the Vite dev server instead of depending on wait-on. */
async function loadDevServer(window: BrowserWindow, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await window.loadURL(url);
      return;
    } catch (error) {
      if (attempt >= DEV_SERVER_MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, DEV_SERVER_RETRY_MS));
    }
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 500,
    title: 'Twitter Desktop',
    backgroundColor: '#0f1419',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!isDevServerUrl(url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isDevServerUrl(url)) event.preventDefault();
  });
  // Unlike the two above, this event passes a single details object.
  contents.on('will-frame-navigate', (details) => {
    if (!isDevServerUrl(details.url)) details.preventDefault();
  });
  return window;
}

/** The app window and its "Mon X" view; replaced when macOS reopens a window. */
let current: { window: BrowserWindow; xview: XViewController } | null = null;

function openMainWindow(): BrowserWindow {
  const window = createWindow();
  current = { window, xview: new XViewController(window) };
  window.on('closed', () => {
    if (current?.window === window) current = null;
  });
  return window;
}

function loadApp(window: BrowserWindow): Promise<void> {
  return DEV_SERVER_URL ? loadDevServer(window, DEV_SERVER_URL) : window.loadFile(RENDERER_INDEX);
}

/** Only the main frame of the app's own page may call IPC: never x.com, an iframe or another page. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (!current || event.sender !== current.window.webContents) return false;
  const frame = event.senderFrame;
  return frame !== null && frame === event.sender.mainFrame && isAppPageUrl(frame.url);
}

/** In development the Dock shows Electron's icon; the packaged app gets build/icon.icns. */
function showDevDockIcon(): void {
  if (app.isPackaged || process.platform !== 'darwin' || !app.dock) return;
  app.dock.setIcon(join(__dirname, '..', '..', 'build', 'icon.png'));
}

async function start(): Promise<void> {
  await app.whenReady();
  showDevDockIcon();
  installGlobalGuards();
  hardenDefaultSession();
  installMenu((view) => {
    if (current && !current.window.isDestroyed()) current.window.webContents.send(APP_NAVIGATE_EVENT, view);
  });
  registerIpcHandlers(createXService(), {
    isTrustedSender,
    xview: () => {
      if (!current) throw new Error('No app window is open.');
      return current.xview;
    },
  });
  await loadApp(openMainWindow());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) return;
    loadApp(openMainWindow()).catch(failStart);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// One instance only: two processes on one profile would share (and could corrupt) the X session.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = current?.window;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  start().catch(failStart);
}
