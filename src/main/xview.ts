/**
 * The "Mon X" tab: the real x.com, shown in a WebContentsView laid over the
 * app window's content area. The user signs in on X's own login page; the
 * app never sees the password. The session lives in its own persistent
 * partition, so the login survives restarts and never mixes with the app UI.
 *
 * The view has no preload, so x.com cannot reach the app's IPC. The view
 * never shows a page outside X (navigations and server redirects included):
 * there is no address bar, so a foreign page could pass for X. Sign-in
 * popups stay on X and the exact sign-in hosts; other links open in the
 * system browser, rate-limited (rules in xpolicy.ts).
 */
import { app, BrowserWindow, dialog, Notification, session, shell, WebContentsView, type Session, type WebContents } from 'electron';
import {
  browserUserAgent,
  createOpenLimiter,
  isSignInFlowUrl,
  isPermissionAllowed,
  isXUrl,
  originForLog,
  popupDecision,
  webHref,
  X_HOME_URL,
  type ViewBounds,
} from './xpolicy';
import { createUnreadTracker, type Unread } from './unread';
import { APP_NAVIGATE_EVENT, type X_LOAD_FAILED_EVENT } from '../shared/ipc';

/**
 * Packaged app: persistent, so the login survives restarts; its cookies are
 * encrypted on disk by the enableCookieEncryption fuse (package.json).
 * Unpackaged runs (npm start, npm run dev) have no fuse, so their X session
 * stays in memory only and is never written to disk in clear.
 */
const X_PARTITION = app.isPackaged ? 'persist:x-account' : 'x-account-memory';
/** X's own sign-out page: ends the session on X's servers too. */
const X_LOGOUT_URL = 'https://x.com/logout';
/** Downloads (e.g. a saved image) only from X and its CDN. */
const DOWNLOAD_DOMAINS = ['x.com', 'twitter.com', 'twimg.com'];
const EXTERNAL_OPEN_INTERVAL_MS = 1000;
/** The app's own background (main.ts), shown by the view until x.com paints. */
const X_VIEW_BACKGROUND = '#0f1419';

export type XNavigation = 'back' | 'forward' | 'reload' | 'home';

/** Main → renderer event: x.com failed to load in the "Mon X" view. */
const X_LOAD_FAILED_CHANNEL: typeof X_LOAD_FAILED_EVENT = 'xview:loadFailed';

const allowExternalOpen = createOpenLimiter(EXTERNAL_OPEN_INTERVAL_MS);

/** Opens a web link in the system browser: the checked href, never the raw string. */
function openExternally(raw: string): void {
  const href = webHref(raw);
  if (!href) {
    console.warn(`Refused to open a non-web link from x.com (${originForLog(raw)}).`);
    return;
  }
  if (!allowExternalOpen()) {
    console.warn(`Dropped a link to ${originForLog(href)}: links are limited to one per second.`);
    return;
  }
  shell.openExternal(href).catch((error: unknown) => console.error(`Could not open ${originForLog(href)}:`, error));
}

/** Loads a URL; an aborted load (superseded by a redirect or a click) is normal, any other failure is logged. */
function load(contents: WebContents, url: string): void {
  contents.loadURL(url).catch((error: unknown) => {
    if ((error as { code?: unknown }).code !== 'ERR_ABORTED') {
      console.error(`x.com view failed to load ${originForLog(url)}:`, error);
    }
  });
}

let configured: Session | null = null;

function isDownloadAllowed(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && DOWNLOAD_DOMAINS.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** Shared by the X view and its sign-in popups: no Node, sandboxed, no <webview>. */
function xWebPreferences(): Electron.WebPreferences {
  return {
    session: xSession(),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webviewTag: false,
    safeDialogs: true,
    spellcheck: false,
  };
}

/** Configures the X session once: browser user agent and permission policy, judged on the requesting frame. */
function xSession(): Session {
  if (configured) return configured;
  const xs = session.fromPartition(X_PARTITION);
  xs.setUserAgent(browserUserAgent(xs.getUserAgent()));
  xs.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    callback(isPermissionAllowed(permission, details.requestingUrl, types));
  });
  xs.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    isPermissionAllowed(permission, requestingOrigin, details.mediaType ? [details.mediaType] : []),
  );
  xs.setSpellCheckerEnabled(false);
  // Open the connection to x.com before the first request needs it.
  xs.preconnect({ url: X_HOME_URL, numSockets: 2 });
  xs.on('will-download', (event, item) => {
    if (!isDownloadAllowed(item.getURL())) {
      console.warn(`Blocked a download from ${originForLog(item.getURL())}.`);
      event.preventDefault();
    }
  });
  configured = xs;
  return xs;
}

/**
 * Keeps a WebContents on the pages `allowed` accepts: link clicks and server
 * redirects alike (will-navigate does not fire for a redirect target). A
 * page that still lands elsewhere is replaced by `fallback`.
 */
function confine(contents: WebContents, allowed: (url: string) => boolean, fallback: () => void): void {
  contents.on('will-navigate', (event, url) => {
    if (allowed(url)) return;
    event.preventDefault();
    openExternally(url);
  });
  contents.on('will-redirect', (event, url) => {
    if (allowed(url)) return;
    event.preventDefault();
    openExternally(url);
  });
  contents.on('did-navigate', (_event, url) => {
    // Only web pages: a failed load shows chrome-error://, which must not trigger a reload loop.
    if (webHref(url) && !allowed(url)) {
      console.warn(`x.com view landed on ${originForLog(url)}; leaving it.`);
      fallback();
    }
  });
}

/** Sign-in popups (Google, Apple) may only walk the sign-in flow; they close back into the X view. */
function guardSignInPopup(popup: BrowserWindow): void {
  confine(popup.webContents, isSignInFlowUrl, () => popup.close());
  // A popup whose very first load was refused would stay open and empty.
  popup.webContents.on('did-finish-load', () => {
    if (!popup.isDestroyed() && popup.webContents.getURL() === '') popup.close();
  });
  popup.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
}

function guardXContents(contents: WebContents): void {
  confine(contents, isXUrl, () => load(contents, X_HOME_URL));
  contents.setWindowOpenHandler(({ url, referrer }) => {
    // The frame that opens it (an iframe has its own referrer), else the page.
    const decision = popupDecision(url, referrer.url || contents.getURL());
    if (decision === 'allow') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          autoHideMenuBar: true,
          webPreferences: xWebPreferences(),
        },
      };
    }
    if (decision === 'external') openExternally(url);
    return { action: 'deny' };
  });
  contents.on('did-create-window', guardSignInPopup);
}

/** Dock badge on macOS, launcher badge elsewhere where the platform has one. */
function setAppBadge(text: string): void {
  if (process.platform === 'darwin') app.dock?.setBadge(text);
  else app.setBadgeCount(Number.parseInt(text, 10) || 0);
}

export class XViewController {
  private view: WebContentsView | null = null;
  private readonly unread = createUnreadTracker(
    { setBadge: setAppBadge, notify: (unread) => this.notifyUnread(unread) },
    () => this.isWatchingX(),
  );

  /** Kept until clicked or closed: a garbage-collected notification loses its click. */
  private readonly pending = new Set<Notification>();
  private warnedNoNotifications = false;

  constructor(private readonly window: BrowserWindow) {
    // The badge outlives the window on macOS: never leave a count with no source.
    window.on('closed', () => {
      this.view = null;
      this.unread.reset();
    });
  }

  /** True while the window is focused and the "Mon X" tab is the one on screen. */
  private isWatchingX(): boolean {
    return !this.window.isDestroyed() && this.window.isFocused() && Boolean(this.view?.getVisible());
  }

  /** The text is fixed here: nothing x.com wrote is shown in the notification. */
  private notifyUnread({ count, overflow }: Unread): void {
    if (!Notification.isSupported()) {
      if (!this.warnedNoNotifications) console.warn('Native notifications are not supported here; only the badge is shown.');
      this.warnedNoNotifications = true;
      return;
    }
    const notification = new Notification({
      title: 'Twitter Desktop',
      body: `${count}${overflow ? '+' : ''} notification${count > 1 || overflow ? 's' : ''} non lue${count > 1 || overflow ? 's' : ''} sur X`,
    });
    this.pending.add(notification);
    notification.on('close', () => this.pending.delete(notification));
    notification.on('click', () => {
      this.pending.delete(notification);
      if (this.window.isDestroyed()) return;
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
      this.window.webContents.send(APP_NAVIGATE_EVENT, 'x');
    });
    notification.show();
  }

  /** Created on first use so the X session only starts when the tab is opened. */
  private ensure(): WebContentsView {
    if (this.view) return this.view;
    const view = new WebContentsView({ webPreferences: xWebPreferences() });
    // Dark like the app while x.com loads, instead of a white flash.
    view.setBackgroundColor(X_VIEW_BACKGROUND);
    guardXContents(view.webContents);
    view.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED: a load replaced by another one, not a failure.
      if (!isMainFrame || code === -3) return;
      this.reportLoadFailure(`x.com n'a pas pu être chargé (${description}, ${originForLog(url)}).`);
    });
    view.webContents.on('page-title-updated', (_event, title) => this.unread.onTitle(title));
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    load(view.webContents, X_HOME_URL);
    this.view = view;
    return view;
  }

  /**
   * Starts loading x.com now, hidden, in parallel with the app's own page:
   * the app opens on "Mon X", so the load would otherwise wait for the tab.
   */
  warmUp(): void {
    this.ensure();
  }

  show(bounds: ViewBounds): void {
    const view = this.ensure();
    view.setBounds(bounds);
    view.setVisible(true);
    view.webContents.focus();
  }

  setBounds(bounds: ViewBounds): void {
    this.view?.setBounds(bounds);
  }

  hide(): void {
    this.view?.setVisible(false);
    this.window.webContents.focus();
  }

  /** Opens an X page in the tab. Callers validate with isXUrl first. */
  open(url: string): void {
    if (!isXUrl(url)) throw new Error(`Not an X url (${originForLog(url)}).`);
    load(this.ensure().webContents, url);
  }

  navigate(action: XNavigation): void {
    const contents = this.ensure().webContents;
    const history = contents.navigationHistory;
    if (action === 'back' && history.canGoBack()) history.goBack();
    else if (action === 'forward' && history.canGoForward()) history.goForward();
    else if (action === 'reload') contents.reload();
    else if (action === 'home') load(contents, X_HOME_URL);
  }

  /** Tells the app UI (the "Mon X" banner) that x.com failed to load. */
  private reportLoadFailure(message: string): void {
    console.error(message);
    if (!this.window.isDestroyed()) this.window.webContents.send(X_LOAD_FAILED_CHANNEL, message);
  }

  /**
   * Sign-out, confirmed in the main process (a compromised page cannot skip
   * the dialog). Clearing local data does not end the session on X's
   * servers, so the user is offered X's own sign-out page first.
   */
  async signOut(): Promise<'cleared' | 'logout-page' | 'cancelled'> {
    const { response } = await dialog.showMessageBox(this.window, {
      type: 'warning',
      buttons: ['Ouvrir la déconnexion de X', 'Effacer les données locales', 'Annuler'],
      defaultId: 0,
      cancelId: 2,
      message: 'Se déconnecter de X',
      detail:
        "1. « Ouvrir la déconnexion de X » ferme ta session chez X (recommandé, à faire en premier).\n" +
        "2. « Effacer les données locales » supprime ensuite les cookies et données de X gardés sur cet ordinateur. " +
        "Seul, cela ne ferme pas la session côté X.",
    });
    if (response === 0) {
      this.unread.reset();
      load(this.ensure().webContents, X_LOGOUT_URL);
      return 'logout-page';
    }
    if (response !== 1) return 'cancelled';
    try {
      await xSession().clearStorageData();
      await xSession().clearCache();
    } finally {
      // Whatever happened, never keep showing a page from the cleared session.
      if (this.view) load(this.view.webContents, X_HOME_URL);
      // After the load starts: the old page's last title cannot relight the badge.
      this.unread.reset();
    }
    return 'cleared';
  }
}
