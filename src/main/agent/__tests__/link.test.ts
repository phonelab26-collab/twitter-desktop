import { readFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuestGateway } from '../guest';
import { AgentLink, type AgentLinkDeps } from '../link';
import type { DebuggerPort } from '../cdpTap';
import type { Encryptor, SettingsFile } from '../settings';

const TRENDING = readFileSync(join(__dirname, '..', '..', 'api', '__fixtures__', 'GlobalTrendingTimelineLoggedOut.real.json'), 'utf8');
const TIMELINE_URL = 'https://api.x.com/graphql/65vLZc4n6GXaOs_GVYqU1g/GlobalTrendingTimelineLoggedOut';

type Listener = (...args: any[]) => void;

class FakeDebugger implements DebuggerPort {
  attached = false;
  body = TRENDING;
  private readonly listeners = new Map<string, Listener[]>();
  attach(): void {
    this.attached = true;
  }
  detach(): void {
    this.attached = false;
  }
  isAttached(): boolean {
    return this.attached;
  }
  async sendCommand(method: string): Promise<any> {
    return method === 'Network.getResponseBody' ? { body: this.body, base64Encoded: false } : {};
  }
  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  removeListener(event: string, listener: Listener): this {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
    return this;
  }
  /** x.com loads a timeline. */
  loadTimeline(requestId: string, url = TIMELINE_URL): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({}, 'Network.responseReceived', { requestId, type: 'Fetch', response: { url, status: 200, mimeType: 'application/json' } });
      listener({}, 'Network.loadingFinished', { requestId });
    }
  }
}

const encryptor: Encryptor = { isAvailable: () => true, encrypt: (text) => Buffer.from(text), decrypt: (data) => data.toString() };
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const links: AgentLink[] = [];
const blockers: Server[] = [];
afterEach(async () => {
  await Promise.all(links.splice(0).map((link) => link.stop()));
  await Promise.all(blockers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function setup(overrides: Partial<AgentLinkDeps> = {}) {
  let saved: string | undefined;
  const settingsFile: SettingsFile = { read: () => saved, write: (content) => (saved = content) };
  let clip = '';
  const timers: Array<() => void> = [];
  const deps: AgentLinkDeps = {
    port: 0,
    settingsFile,
    encryptor,
    guest: {} as GuestGateway,
    clipboard: {
      writeText: async (text) => {
        clip = text;
      },
      readText: async () => clip,
      clear: () => (clip = ''),
    },
    confirmEnable: vi.fn(async () => true),
    appVersion: '9.9.9',
    schedule: (fn) => timers.push(fn),
    ...overrides,
  };
  const link = new AgentLink(deps);
  links.push(link);
  return { link, deps, saved: () => saved, clip: () => clip, runTimers: () => timers.splice(0).forEach((fn) => fn()) };
}

function post(url: string, token: string, body: unknown): Promise<{ status: number; json: any }> {
  const { port, pathname } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('AgentLink', () => {
  it('starts off, and turns on only after the user confirms', async () => {
    const declined = setup({ confirmEnable: vi.fn(async () => false) });
    await declined.link.init();
    expect((await declined.link.setEnabled(true)).enabled).toBe(false);

    const { link, saved } = setup();
    await link.init();
    expect(link.status()).toMatchObject({ enabled: false, server: { state: 'off' } });

    const status = await link.setEnabled(true);

    expect(status).toMatchObject({ enabled: true, server: { state: 'listening' }, tokenPersisted: true });
    expect(status.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(JSON.parse(saved() ?? '{}')).toMatchObject({ version: 1, enabled: true });
  });

  it('never shows the token to the UI, but copies it and wipes it from the clipboard later', async () => {
    const { link, clip, runTimers } = setup();
    await link.init();
    const status = await link.setEnabled(true);
    // Local scope: only the Claude Code sessions of the folder it is added from see the feed.
    expect(status.commands.claudeCommand).toContain('--scope local');
    expect(JSON.stringify(status)).not.toMatch(/Bearer [A-Za-z0-9_-]{43}/);

    const copied = await link.copy('token');
    const token = clip();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(copied.clipboardClearsAt).toBeDefined();

    runTimers();
    await settle();
    expect(clip()).toBe('');
  });

  it('wipes the copied token from the clipboard when the app quits', async () => {
    const { link, clip } = setup();
    await link.init();
    await link.setEnabled(true);
    await link.copy('claudeCommand');
    expect(clip()).toContain('Bearer ');

    await link.stop();

    expect(clip()).toBe('');
  });

  it('serves the tools with its token, and a new token replaces the old one at once', async () => {
    const { link, clip } = setup();
    await link.init();
    const { server } = await link.setEnabled(true);
    await link.copy('token');
    const first = clip();

    const reply = await post(server.url, first, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'feed_status', arguments: {} } });
    expect(reply.json.result.structuredContent).toMatchObject({ capture: { capturing: false, xView: 'closed' } });
    expect(link.status().requests.count).toBe(1);

    link.regenerateToken();
    expect((await post(server.url, first, { jsonrpc: '2.0', id: 2, method: 'ping' })).status).toBe(401);
  });

  it('captures the feed of the x.com view while on, and forgets it when turned off', async () => {
    const { link } = setup();
    await link.init();
    await link.setEnabled(true);
    const port = new FakeDebugger();
    await link.attachView(port, { isVisible: () => true, url: () => 'https://x.com/home' });

    port.loadTimeline('1');
    await settle();

    expect(link.status().capture).toMatchObject({ capturing: true, onHomeTimeline: true, xViewVisible: true, posts: 20 });
    expect(link.status().capture.lastCaptureAt).toBeDefined();
    const off = await link.setEnabled(false);
    expect(port.attached).toBe(false);
    expect(off).toMatchObject({ enabled: false, server: { state: 'off' }, capture: { capturing: false, posts: 0 } });
    // The posts are gone: no "last capture" left pointing at them.
    expect(off.capture.lastCaptureAt).toBeUndefined();
  });

  it('does not capture while off, and keeps the feed when only the window closes', async () => {
    const { link } = setup();
    await link.init();
    const port = new FakeDebugger();
    await link.attachView(port, { isVisible: () => false, url: () => 'https://x.com/home' });
    expect(port.attached).toBe(false);

    await link.setEnabled(true);
    expect(port.attached).toBe(true);
    port.loadTimeline('1');
    await settle();

    await link.viewClosed();
    expect(link.status().capture).toMatchObject({ capturing: false, xView: 'closed', posts: 20, stopReason: 'window closed' });
  });

  it('reports entries it could not read and feeds it does not know, never "0 posts, 0 errors"', async () => {
    const { link } = setup();
    await link.init();
    await link.setEnabled(true);
    const port = new FakeDebugger();
    port.body = JSON.stringify({ data: { home: { home_timeline_urt: { instructions: [{ type: 'TimelineAddEntries', entriez: [] }] } } } });
    await link.attachView(port, { isVisible: () => true, url: () => 'https://x.com/home' });

    port.loadTimeline('1', 'https://x.com/i/api/graphql/abc/HomeTimeline');
    port.loadTimeline('2', 'https://x.com/i/api/graphql/abc/HomeTimelineV2');
    await settle();

    expect(link.status().capture).toMatchObject({ unreadablePosts: 1, unrecognised: ['HomeTimelineV2'], posts: 0 });
  });

  it('runs one transition at a time: two quick "on" make one server, and "off" stops it', async () => {
    const { link } = setup();
    await link.init();

    const [first, second] = await Promise.all([link.setEnabled(true), link.setEnabled(true)]);
    expect(first.enabled && second.enabled).toBe(true);
    const off = await link.setEnabled(false);

    expect(off.server.state).toBe('off');
    await expect(post(first.server.url, 'x'.repeat(43), { jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow(/ECONNREFUSED/);
  });

  it('empties the feed when the X account changes or signs out', async () => {
    const { link } = setup();
    await link.init();
    await link.setEnabled(true);
    const port = new FakeDebugger();
    await link.attachView(port, { isVisible: () => true, url: () => 'https://x.com/home' });
    port.loadTimeline('1');
    await settle();
    const before = link.status().capture.epoch;

    link.clearFeed();

    expect(link.status().capture).toMatchObject({ posts: 0 });
    expect(link.status().capture.epoch).not.toBe(before);
  });

  it('reports a busy port, stays off and renews the token', async () => {
    const blocker = createServer();
    blockers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const busyPort = (blocker.address() as { port: number }).port;
    const { link, saved } = setup({ port: busyPort });
    await link.init();
    await link.setEnabled(true);
    const savedToken = JSON.parse(saved() ?? '{}').token;

    const status = link.status();

    expect(status).toMatchObject({ enabled: false, server: { state: 'error' } });
    expect(status.server.message).toMatch(String(busyPort));
    expect(savedToken).toBeDefined();
  });

  it('reopens on launch when it was on, without asking again', async () => {
    const first = setup();
    await first.link.init();
    await first.link.setEnabled(true);
    await first.link.stop();
    const saved = first.saved();

    const confirmEnable = vi.fn(async () => true);
    const again = setup({ confirmEnable, settingsFile: { read: () => saved, write: () => undefined } });
    await again.link.init();

    expect(again.link.status()).toMatchObject({ enabled: true, server: { state: 'listening' } });
    expect(confirmEnable).not.toHaveBeenCalled();
  });
});
