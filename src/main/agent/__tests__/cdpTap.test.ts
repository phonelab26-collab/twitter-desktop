import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CaptureTap, isAllowedCommand, MAX_NAMES, MAX_PENDING, MAX_READS, OTHER_NAMES, restrictDebugger, type DebuggerPort } from '../cdpTap';

const TRENDING = readFileSync(join(__dirname, '..', '..', 'api', '__fixtures__', 'GlobalTrendingTimelineLoggedOut.real.json'), 'utf8');
const TIMELINE_URL = 'https://api.x.com/graphql/65vLZc4n6GXaOs_GVYqU1g/GlobalTrendingTimelineLoggedOut?variables=%7B%7D';

type Listener = (...args: any[]) => void;

/** Stands in for webContents.debugger: records commands, replays CDP events. */
class FakeDebugger implements DebuggerPort {
  attached = false;
  failAttach = false;
  readonly commands: Array<[string, unknown]> = [];
  readonly bodies = new Map<string, { body: string; base64Encoded: boolean }>();
  private readonly listeners = new Map<string, Listener[]>();

  attach(): void {
    if (this.failAttach) throw new Error('Another debugger is already attached to the target.');
    this.attached = true;
  }

  detach(): void {
    this.attached = false;
  }

  isAttached(): boolean {
    return this.attached;
  }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<any> {
    this.commands.push([method, params]);
    if (method !== 'Network.getResponseBody') return {};
    const body = this.bodies.get(String(params?.requestId));
    if (!body) throw new Error('No resource with given identifier found');
    return body;
  }

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
    return this;
  }

  emit(method: string, params: Record<string, unknown>): void {
    for (const listener of this.listeners.get('message') ?? []) listener({}, method, params);
  }

  emitDetach(reason: string): void {
    for (const listener of this.listeners.get('detach') ?? []) listener({}, reason);
  }

  respond(requestId: string, url: string, mimeType = 'application/json', type = 'Fetch'): void {
    this.emit('Network.responseReceived', { requestId, type, response: { url, status: 200, mimeType } });
  }

  finish(requestId: string): void {
    this.emit('Network.loadingFinished', { requestId });
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function started(onReading = vi.fn()) {
  const port = new FakeDebugger();
  const tap = new CaptureTap(port, onReading, () => 42);
  await tap.start();
  return { port, tap, onReading };
}

describe('isAllowedCommand', () => {
  it('lets the tap read the network, nothing else (no script, no input, no cookies)', () => {
    for (const method of ['Network.enable', 'Network.disable', 'Network.getResponseBody']) expect(isAllowedCommand(method)).toBe(true);
    for (const method of ['Runtime.evaluate', 'Runtime.enable', 'Input.dispatchMouseEvent', 'Network.getCookies', 'Page.navigate']) {
      expect(isAllowedCommand(method)).toBe(false);
    }
  });
});

describe('CaptureTap', () => {
  it('attaches and enables the network domain with bounded buffers', async () => {
    const { port, tap } = await started();

    expect(port.attached).toBe(true);
    expect(port.commands[0][0]).toBe('Network.enable');
    expect(port.commands[0][1]).toMatchObject({ maxTotalBufferSize: expect.any(Number), maxResourceBufferSize: expect.any(Number) });
    expect(tap.stats).toMatchObject({ attached: true, startedAt: 42 });
  });

  it('reads the body of a feed response, base64 or not, with the time X answered', async () => {
    const { port, onReading, tap } = await started();
    port.bodies.set('1', { body: TRENDING, base64Encoded: false });
    port.bodies.set('2', { body: Buffer.from(TRENDING).toString('base64'), base64Encoded: true });

    for (const id of ['1', '2']) {
      port.respond(id, TIMELINE_URL);
      port.finish(id);
    }
    await settle();

    expect(onReading).toHaveBeenCalledTimes(2);
    for (const [reading, snapshotAt] of onReading.mock.calls) {
      expect(reading.batches[0].items).toHaveLength(20);
      expect(snapshotAt).toBe(42);
    }
    expect(tap.stats).toMatchObject({ responsesRead: 2, errors: 0 });
  });

  it('never reads the body of other responses, and counts personal timelines it leaves out', async () => {
    const { port, tap } = await started();

    port.respond('img', 'https://pbs.twimg.com/media/a.jpg', 'image/jpeg', 'Image');
    port.respond('bm', 'https://x.com/i/api/graphql/abc/Bookmarks');
    port.finish('img');
    port.finish('bm');
    await settle();

    expect(port.commands.filter(([method]) => method === 'Network.getResponseBody')).toEqual([]);
    expect(tap.stats.personal).toEqual({ Bookmarks: 1 });
  });

  it('counts a body the browser no longer has instead of skipping it silently', async () => {
    const { port, tap } = await started();

    port.respond('gone', TIMELINE_URL);
    port.finish('gone');
    await settle();

    expect(tap.stats).toMatchObject({ bodiesUnavailable: 1, lastError: expect.stringContaining('No resource') });
  });

  it('forgets a failed load, and bounds the responses waiting for their body', async () => {
    const { port, tap } = await started();
    port.respond('failed', TIMELINE_URL);
    port.emit('Network.loadingFailed', { requestId: 'failed' });
    port.finish('failed');
    for (let i = 0; i < MAX_PENDING + 10; i++) port.respond(`r${i}`, TIMELINE_URL);
    await settle();

    expect(port.commands.filter(([method]) => method === 'Network.getResponseBody')).toEqual([]);
    expect(tap.stats.dropped).toBe(10);
  });

  it('reports when the debugger is taken away', async () => {
    const { port, tap } = await started();

    port.emitDetach('target closed');

    expect(tap.stats).toMatchObject({ attached: false, stopReason: 'target closed' });
  });

  it('stops: network off, detached, deaf to later events', async () => {
    const { port, tap, onReading } = await started();
    port.bodies.set('late', { body: TRENDING, base64Encoded: false });

    await tap.stop('link turned off');
    port.respond('late', TIMELINE_URL);
    port.finish('late');
    await settle();

    expect(port.commands.map(([method]) => method)).toEqual(['Network.enable', 'Network.disable']);
    expect(port.attached).toBe(false);
    expect(onReading).not.toHaveBeenCalled();
    expect(tap.stats).toMatchObject({ attached: false, stopReason: 'link turned off' });
  });

  it('fails loudly when it cannot attach (DevTools already open)', async () => {
    const port = new FakeDebugger();
    port.failAttach = true;
    const tap = new CaptureTap(port, vi.fn());

    await expect(tap.start()).rejects.toThrow(/already attached/);
    expect(tap.stats.attached).toBe(false);
  });
});

describe('CaptureTap under hostile traffic', () => {
  it('keeps at most a few dozen operation names, the rest counted together', async () => {
    const { port, tap } = await started();

    for (let i = 0; i < 500; i++) port.respond(`b${i}`, `https://x.com/i/api/graphql/abc/BookmarksSpam${i}`);

    expect(Object.keys(tap.stats.personal).length).toBeLessThanOrEqual(MAX_NAMES + 1);
    expect(tap.stats.personal[OTHER_NAMES]).toBe(500 - MAX_NAMES);
  });

  it('reads only a few bodies at once and counts the ones it had to skip', async () => {
    const port = new FakeDebugger();
    const pending: Array<() => void> = [];
    port.sendCommand = async (method: string) => {
      if (method !== 'Network.getResponseBody') return {};
      await new Promise<void>((resolve) => pending.push(resolve));
      return { body: TRENDING, base64Encoded: false };
    };
    const tap = new CaptureTap(port, vi.fn());
    await tap.start();

    for (let i = 0; i < MAX_READS + 3; i++) {
      port.respond(`r${i}`, TIMELINE_URL);
      port.finish(`r${i}`);
    }

    expect(pending).toHaveLength(MAX_READS);
    expect(tap.stats.dropped).toBe(3);
  });

  it('counts a reading that fails instead of losing it silently', async () => {
    const onReading = vi.fn(() => {
      throw new Error('store exploded');
    });
    const { port, tap } = await started(onReading);
    port.bodies.set('1', { body: TRENDING, base64Encoded: false });

    port.respond('1', TIMELINE_URL);
    port.finish('1');
    await settle();

    expect(tap.stats).toMatchObject({ errors: 1, lastError: expect.stringContaining('store exploded') });
  });
});

describe('restrictDebugger', () => {
  it('forwards the three network reads and refuses every other command', async () => {
    const port = new FakeDebugger();
    const restricted = restrictDebugger(port);

    await expect(restricted.sendCommand('Runtime.evaluate', { expression: '1' })).rejects.toThrow(/not allowed/);
    await expect(restricted.sendCommand('Network.enable')).resolves.toEqual({});
    expect(port.commands.map(([method]) => method)).toEqual(['Network.enable']);
  });
});
