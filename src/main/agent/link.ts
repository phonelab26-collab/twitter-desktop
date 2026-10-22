/**
 * The agent link: lets a local agent (Claude Code, a script...) read the X
 * feed of the "Mon X" tab, read-only. Off by default, turned on only after a
 * main-process confirmation. While on: a local server (server.ts) answers
 * with the token, and the capture (cdpTap.ts) reads the x.com view's traffic
 * into an in-memory buffer (feedStore.ts). Turning it off stops both and
 * empties the buffer.
 */
import type { AgentCopyKind, AgentStatus, CaptureStatus } from '../../shared/agent';
import type { CaptureReading } from './capture';
import { CaptureTap, type DebuggerPort, type TapStats } from './cdpTap';
import { FeedStore } from './feedStore';
import type { GuestGateway } from './guest';
import type { McpDeps } from './mcp';
import { startAgentServer, type AgentServer } from './server';
import { loadAgentSettings, newToken, saveAgentSettings, type Encryptor, type SettingsFile } from './settings';
import { AGENT_TOOLS, callTool } from './tools';

/** A copied token stays on the clipboard this long, unless something else was copied since. */
const CLIPBOARD_CLEAR_MS = 60_000;
const TOKEN_MASK = '••••••••';
const LOOPBACK = '127.0.0.1';

export interface AgentLinkDeps {
  port: number;
  settingsFile: SettingsFile;
  encryptor: Encryptor;
  guest: GuestGateway;
  /** Electron's clipboard (asynchronous since Electron 44). */
  clipboard: { writeText(text: string): Promise<void>; readText(): Promise<string>; clear(): void };
  /** Asks the user (main-process dialog) before the link is turned on. */
  confirmEnable(): Promise<boolean>;
  appVersion: string;
  now?: () => number;
  schedule?: (task: () => void, ms: number) => void;
}

/** What the link needs to know about the x.com view. */
export interface XViewProbe {
  isVisible(): boolean;
  url(): string;
}

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);
/** A file-system error by its code only: its message carries an absolute path. */
const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'erreur inconnue';
};

function isHomeTimeline(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && (url.hostname === 'x.com' || url.hostname === 'twitter.com') && url.pathname === '/home';
  } catch {
    return false;
  }
}

function listenError(error: unknown, port: number): string {
  const code = (error as { code?: unknown }).code;
  if (code === 'EADDRINUSE') {
    return `Le port ${port} est déjà utilisé par un autre programme : le lien agent ne peut pas démarrer. Le jeton a été renouvelé par précaution.`;
  }
  return `Le serveur local n'a pas démarré (${errorText(error)}). Le jeton a été renouvelé par précaution.`;
}

export class AgentLink {
  private readonly store = new FeedStore();
  private readonly now: () => number;
  private readonly schedule: (task: () => void, ms: number) => void;
  private enabled = false;
  private token: string | null = null;
  private tokenPersisted = false;
  private settingsIssue?: string;
  private server: AgentServer | null = null;
  private serverError?: string;
  private view: { port: DebuggerPort; probe: XViewProbe } | null = null;
  private tap: CaptureTap | null = null;
  private lastTapStats?: TapStats;
  private captureError?: string;
  private lastCaptureAt?: number;
  private unreadable = 0;
  private requests: { count: number; lastAt?: number } = { count: 0 };
  private clipboardClearsAt?: number;
  /** The last value carrying the token put on the clipboard, until it is wiped. */
  private copiedSecret: string | null = null;
  /** Turning on and off, attaching and stopping run one at a time, in call order. */
  private transitions: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AgentLinkDeps) {
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? ((task, ms) => void setTimeout(task, ms));
  }

  /** Reads the saved settings; reopens the link if it was on (the user agreed then). */
  init(): Promise<void> {
    return this.serial(async () => {
      const loaded = loadAgentSettings(this.deps.settingsFile, this.deps.encryptor);
      this.settingsIssue = loaded.issue;
      this.token = loaded.token;
      this.tokenPersisted = loaded.token !== null;
      if (loaded.enabled) await this.turnOn();
    });
  }

  setEnabled(on: boolean): Promise<AgentStatus> {
    return this.serial(async () => {
      if (on === this.enabled) return this.status();
      if (!on) await this.turnOff();
      else if (await this.deps.confirmEnable()) await this.turnOn();
      return this.status();
    });
  }

  /** The old token stops working at once: the server reads the current one on every request. */
  regenerateToken(): AgentStatus {
    this.token = newToken();
    this.persist();
    return this.status();
  }

  /** Puts a value on the clipboard; anything carrying the token is wiped after a minute. */
  async copy(kind: AgentCopyKind): Promise<AgentStatus> {
    if (!this.enabled || !this.token) throw new Error("Active le lien agent d'abord.");
    const text = this.commandText(kind, this.token);
    await this.deps.clipboard.writeText(text);
    if (kind === 'token' || kind === 'claudeCommand') this.scheduleClipboardClear(text);
    return this.status();
  }

  /** The x.com view (re)created: captured from now on while the link is on. */
  attachView(port: DebuggerPort, probe: XViewProbe): Promise<void> {
    return this.serial(async () => {
      await this.stopCapture('x.com view replaced');
      this.view = { port, probe };
      if (this.enabled) await this.startCapture();
    });
  }

  /** The window closed: no more capture, but the posts already read stay available. */
  viewClosed(): Promise<void> {
    return this.serial(async () => {
      await this.stopCapture('window closed');
      this.view = null;
    });
  }

  /** Another account, or signed out: the previous account's posts must not be served. */
  clearFeed(): void {
    this.store.clear();
    this.lastCaptureAt = undefined;
    this.unreadable = 0;
  }

  /** On quit: capture and server stopped, a copied token wiped from the clipboard. */
  stop(): Promise<void> {
    return this.serial(async () => {
      await this.stopCapture('app quit');
      await this.server?.close();
      this.server = null;
      await this.wipeClipboard();
    });
  }

  status(): AgentStatus {
    const stats = this.tap?.stats ?? this.lastTapStats;
    const url = this.mcpUrl();
    return {
      enabled: this.enabled,
      server: { state: this.server ? 'listening' : this.serverError ? 'error' : 'off', url, message: this.serverError },
      tokenPersisted: this.tokenPersisted,
      settingsIssue: this.settingsIssue,
      commands: { mcpUrl: url, claudeCommand: this.commandText('claudeCommand', TOKEN_MASK), curlCommand: this.commandText('curlCommand', TOKEN_MASK) },
      capture: {
        ...this.captureStatus(),
        posts: this.store.size,
        epoch: this.store.epoch,
        bodiesUnavailable: stats?.bodiesUnavailable ?? 0,
        personal: Object.keys(stats?.personal ?? {}),
        unrecognised: Object.keys(stats?.unrecognised ?? {}),
        unsupported: Object.keys(stats?.unsupported ?? {}),
      },
      requests: { count: this.requests.count, lastAt: iso(this.requests.lastAt) },
      clipboardClearsAt: iso(this.clipboardClearsAt),
    };
  }

  captureStatus(): CaptureStatus {
    const stats = this.tap?.stats ?? this.lastTapStats;
    const capturing = this.enabled && this.tap?.stats.attached === true;
    return {
      capturing,
      xView: this.view ? 'open' : 'closed',
      xViewVisible: this.view?.probe.isVisible() ?? false,
      onHomeTimeline: this.view ? isHomeTimeline(this.view.probe.url()) : false,
      lastCaptureAt: iso(this.lastCaptureAt),
      stoppedAt: capturing ? undefined : iso(stats?.stoppedAt),
      stopReason: capturing ? undefined : (this.captureError ?? stats?.stopReason),
      unreadablePosts: this.unreadable,
      errors: stats?.errors ?? 0,
      lastError: stats?.lastError,
    };
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.transitions.then(task, task);
    this.transitions = run.catch(() => undefined);
    return run;
  }

  /** Wipes `text` from the clipboard in a minute (or at quit), unless the user copied something else since. */
  private scheduleClipboardClear(text: string): void {
    const clearsAt = this.now() + CLIPBOARD_CLEAR_MS;
    this.clipboardClearsAt = clearsAt;
    this.copiedSecret = text;
    this.schedule(() => {
      if (this.clipboardClearsAt === clearsAt) void this.wipeClipboard();
    }, CLIPBOARD_CLEAR_MS);
  }

  private async wipeClipboard(): Promise<void> {
    const secret = this.copiedSecret;
    this.copiedSecret = null;
    this.clipboardClearsAt = undefined;
    if (secret === null) return;
    try {
      if ((await this.deps.clipboard.readText()) === secret) this.deps.clipboard.clear();
    } catch (error) {
      console.error('[agent] could not check the clipboard to wipe the token:', errorText(error));
    }
  }

  private async turnOn(): Promise<void> {
    this.token ??= newToken();
    try {
      this.server = await startAgentServer({
        port: this.deps.port,
        token: () => this.token ?? '',
        mcp: this.mcpDeps(),
        onAuthorized: () => (this.requests = { count: this.requests.count + 1, lastAt: this.now() }),
      });
    } catch (error) {
      console.error('[agent] the local server did not start:', errorText(error));
      this.serverError = listenError(error, this.deps.port);
      // Whatever holds the port may receive the token from a configured agent: never reuse it.
      this.token = newToken();
      this.enabled = false;
      this.persist();
      return;
    }
    this.serverError = undefined;
    this.enabled = true;
    this.persist();
    await this.startCapture();
  }

  private async turnOff(): Promise<void> {
    this.enabled = false;
    await this.stopCapture('link turned off');
    await this.server?.close();
    this.server = null;
    this.store.clear();
    this.lastCaptureAt = undefined;
    this.persist();
  }

  private persist(): void {
    if (!this.token) return;
    try {
      this.tokenPersisted = saveAgentSettings(this.deps.settingsFile, this.deps.encryptor, { enabled: this.enabled, token: this.token }).tokenPersisted;
      this.settingsIssue = undefined;
    } catch (error) {
      console.error('[agent] settings not saved:', errorCode(error));
      this.settingsIssue = `Les réglages du lien agent n'ont pas pu être enregistrés (${errorCode(error)}).`;
    }
  }

  private async startCapture(): Promise<void> {
    if (!this.view || this.tap) return;
    const tap = new CaptureTap(this.view.port, (reading, snapshotAt) => this.onReading(reading, snapshotAt), this.now);
    this.captureError = undefined;
    try {
      await tap.start();
      this.tap = tap;
    } catch (error) {
      console.error('[agent] capture not started:', errorText(error));
      this.captureError = `capture impossible: ${errorText(error)}`;
      this.lastTapStats = tap.stats;
    }
  }

  private async stopCapture(reason: string): Promise<void> {
    const tap = this.tap;
    if (!tap) return;
    this.tap = null;
    await tap.stop(reason);
    this.lastTapStats = tap.stats;
  }

  private onReading(reading: CaptureReading, snapshotAt: number): void {
    let changed = 0;
    for (const batch of reading.batches) {
      const { added, updated } = this.store.add(batch, snapshotAt);
      changed += added + updated;
      // Both mean X changed its format: never let them read as "0 posts, 0 errors".
      this.unreadable += batch.unreadable + batch.malformed;
    }
    if (changed > 0) this.lastCaptureAt = this.now();
  }

  private mcpDeps(): McpDeps {
    return {
      info: { name: 'twitter-desktop', title: 'Twitter Desktop', version: this.deps.appVersion },
      tools: AGENT_TOOLS,
      call: (name, args) => callTool(name, args, { store: this.store, guest: this.deps.guest, capture: () => this.captureStatus(), now: this.now }),
    };
  }

  private mcpUrl(): string {
    return `http://${LOOPBACK}:${this.server?.port ?? this.deps.port}/mcp`;
  }

  private commandText(kind: AgentCopyKind, token: string): string {
    const url = this.mcpUrl();
    switch (kind) {
      case 'token':
        return token;
      case 'mcpUrl':
        return url;
      case 'claudeCommand':
        // Local scope: only Claude Code started in the folder the command is run from sees the feed.
        return `claude mcp add --transport http --scope local x-desktop ${url} --header "Authorization: Bearer ${token}"`;
      case 'curlCommand':
        return (
          `curl -s -X POST ${url.replace(/\/mcp$/, '/api/tools/get_feed')} -H "Authorization: Bearer $X_DESKTOP_TOKEN" ` +
          `-H "Content-Type: application/json" -d '{"limit":20}'`
        );
    }
  }
}
