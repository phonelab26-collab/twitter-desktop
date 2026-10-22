import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { XService } from '../api/service';
import { registerIpcHandlers, type AgentControl, type IpcContext } from '../ipc';
import type { XViewController } from '../xview';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { ApiResult, TrendLocation } from '../../shared/types';

type Invoke = (event: unknown, ...args: unknown[]) => Promise<ApiResult<unknown>>;
const handlers = new Map<string, Invoke>();

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Invoke) => handlers.set(channel, fn) },
  shell: { openExternal: vi.fn(async () => undefined) },
}));

const place = (woeid: number): TrendLocation => ({ woeid, name: `P${woeid}`, kind: 'Country' });
const PLACES = Array.from({ length: 12 }, (_, i) => place(i + 1));

function setup(options: { trusted?: boolean } = {}) {
  handlers.clear();
  const service = {
    getProfile: vi.fn(async (name: string) => ({ screenName: name })),
    getUserTweets: vi.fn(async () => ({ items: [], cursor: null })),
    getTweet: vi.fn(async () => undefined),
    getTrendingPosts: vi.fn(async () => ({ items: [], cursor: null })),
    searchTopic: vi.fn(async () => ({ items: [], cursor: null })),
    getTrends: vi.fn(async (woeid: number) => ({ asOf: 'now', location: { name: 'x', woeid }, trends: [] })),
    getTrendLocations: vi.fn(async () => PLACES),
  };
  const xview = {
    show: vi.fn(),
    setInsets: vi.fn(),
    hide: vi.fn(),
    open: vi.fn(),
    navigate: vi.fn(),
    signOut: vi.fn(async () => 'cancelled'),
  };
  const agent = {
    status: vi.fn(() => ({ enabled: false })),
    setEnabled: vi.fn(async (on: boolean) => ({ enabled: on })),
    regenerateToken: vi.fn(() => ({ enabled: true })),
    copy: vi.fn(() => ({ enabled: true })),
  };
  const context: IpcContext = {
    isTrustedSender: () => options.trusted ?? true,
    xview: () => xview as unknown as XViewController,
    agent: () => agent as unknown as AgentControl,
  };
  registerIpcHandlers(service as unknown as XService, context);
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  };
  return { service, xview, agent, call };
}

const errorCode = (result: ApiResult<unknown>) => (result.ok ? undefined : result.error.code);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('IPC trust', () => {
  it('refuses every channel when the sender is not the app page, without calling the service', async () => {
    const { service, xview, call } = setup({ trusted: false });

    for (const channel of Object.values(IPC_CHANNELS)) {
      const result = await call(channel, 'x');
      expect(result.ok).toBe(false);
      expect(result.ok ? 0 : result.error.status).toBe(403);
    }
    expect(service.getProfile).not.toHaveBeenCalled();
    expect(xview.signOut).not.toHaveBeenCalled();
  });
});

describe('IPC agent link', () => {
  it('turns the link on or off only with a boolean', async () => {
    const { agent, call } = setup();

    expect(errorCode(await call(IPC_CHANNELS.agentSetEnabled, 'yes'))).toBe('INVALID_INPUT');
    expect(agent.setEnabled).not.toHaveBeenCalled();
    expect(await call(IPC_CHANNELS.agentSetEnabled, true)).toEqual({ ok: true, data: { enabled: true } });
  });

  it('copies only a known kind of value', async () => {
    const { agent, call } = setup();

    for (const kind of ['password', '', 42, 'token; rm -rf']) expect(errorCode(await call(IPC_CHANNELS.agentCopy, kind))).toBe('INVALID_INPUT');
    expect(agent.copy).not.toHaveBeenCalled();
    expect((await call(IPC_CHANNELS.agentCopy, 'claudeCommand')).ok).toBe(true);
    expect(agent.copy).toHaveBeenCalledWith('claudeCommand');
  });

  it('refuses the agent channels to an untrusted sender too', async () => {
    const { agent, call } = setup({ trusted: false });

    await call(IPC_CHANNELS.agentSetEnabled, true);
    await call(IPC_CHANNELS.agentCopy, 'token');

    expect(agent.setEnabled).not.toHaveBeenCalled();
    expect(agent.copy).not.toHaveBeenCalled();
  });
});

describe('IPC argument checks', () => {
  it('rejects arguments of the wrong type', async () => {
    const { service, call } = setup();

    expect(errorCode(await call(IPC_CHANNELS.getProfile, 42))).toBe('INVALID_INPUT');
    expect(errorCode(await call(IPC_CHANNELS.getTrends, '1'))).toBe('INVALID_INPUT');
    expect(errorCode(await call(IPC_CHANNELS.xviewShow, { left: -1 }))).toBe('INVALID_INPUT');
    expect(errorCode(await call(IPC_CHANNELS.xviewNavigate, 'exec'))).toBe('INVALID_INPUT');
    expect(service.getProfile).not.toHaveBeenCalled();
  });

  it('opens only https X pages in the X view', async () => {
    const { xview, call } = setup();

    expect(errorCode(await call(IPC_CHANNELS.xviewOpen, 'https://evil.example/'))).toBe('INVALID_INPUT');
    expect(errorCode(await call(IPC_CHANNELS.xviewOpen, 'javascript:alert(1)'))).toBe('INVALID_INPUT');
    expect((await call(IPC_CHANNELS.xviewOpen, 'https://x.com/jack')).ok).toBe(true);
    expect(xview.open).toHaveBeenCalledTimes(1);
    expect(xview.open).toHaveBeenCalledWith('https://x.com/jack');
  });

  it('passes a valid call through and wraps its answer', async () => {
    const { call } = setup();

    await expect(call(IPC_CHANNELS.getProfile, 'jack')).resolves.toEqual({ ok: true, data: { screenName: 'jack' } });
  });
});

describe('IPC trends protection', () => {
  it('refuses a place X does not list, without spending a trends call', async () => {
    const { service, call } = setup();

    expect(errorCode(await call(IPC_CHANNELS.getTrends, 999_999))).toBe('INVALID_INPUT');
    expect(service.getTrends).not.toHaveBeenCalled();
  });

  it('serves a repeated place from the cache', async () => {
    const { service, call } = setup();

    await call(IPC_CHANNELS.getTrends, 1);
    await call(IPC_CHANNELS.getTrends, 1);

    expect(service.getTrends).toHaveBeenCalledTimes(1);
  });

  it('stops at 10 distinct places per 15 minutes, below X\'s own limit', async () => {
    const { service, call } = setup();

    const results = [];
    for (let woeid = 1; woeid <= 11; woeid++) results.push(await call(IPC_CHANNELS.getTrends, woeid));

    expect(results.slice(0, 10).every((result) => result.ok)).toBe(true);
    expect(errorCode(results[10])).toBe('RATE_LIMITED');
    expect(service.getTrends).toHaveBeenCalledTimes(10);
  });
});

describe('IPC concurrency', () => {
  it('runs at most 4 calls of one channel at once', async () => {
    const { service, call } = setup();
    let running = 0;
    let peak = 0;
    service.getProfile.mockImplementation(async (name: string) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return { screenName: name };
    });

    await Promise.all(Array.from({ length: 10 }, (_, i) => call(IPC_CHANNELS.getProfile, `u${i}`)));

    expect(peak).toBe(4);
  });
});

describe('IPC failure logging', () => {
  it('logs a failed call in the main process without its arguments', async () => {
    const { service, call } = setup();
    service.getProfile.mockRejectedValueOnce(new Error('boom'));

    const result = await call(IPC_CHANNELS.getProfile, 'secret_handle');

    expect(result.ok).toBe(false);
    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('getProfile');
    expect(logged).not.toContain('secret_handle');
  });
});
