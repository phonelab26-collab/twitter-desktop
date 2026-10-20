import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../cache';
import { externalUrl } from '../ipc';

// Hoisted by vitest above the imports: ipc.ts must not load the real Electron.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, shell: { openExternal: vi.fn() } }));

describe('TtlCache', () => {
  it('serves a value until it expires, then loads again', async () => {
    let now = 0;
    const cache = new TtlCache<string, number>(1000, () => now);
    const load = vi.fn(async () => now);

    expect(await cache.get('k', load)).toBe(0);
    now = 999;
    expect(await cache.get('k', load)).toBe(0);
    now = 1000;
    expect(await cache.get('k', load)).toBe(1000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('never keeps a failure: the next call loads again', async () => {
    const cache = new TtlCache<string, number>(60_000);
    const failing = vi.fn(async () => {
      throw new Error('rate limited');
    });

    await expect(cache.get('k', failing)).rejects.toThrow('rate limited');
    await expect(cache.get('k', async () => 7)).resolves.toBe(7);
  });

  it('shares one pending load between concurrent callers', async () => {
    const cache = new TtlCache<string, number>(60_000);
    const load = vi.fn(async () => 1);

    await Promise.all([cache.get('k', load), cache.get('k', load)]);

    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('externalUrl (links the renderer may open)', () => {
  it('accepts https links to x.com and twitter.com, upgrading http', () => {
    expect(externalUrl('https://x.com/jack/status/20')).toBe('https://x.com/jack/status/20');
    expect(externalUrl('http://twitter.com/search?q=%23a')).toBe('https://twitter.com/search?q=%23a');
  });

  it('rejects any other host, scheme or type', () => {
    for (const bad of ['https://evil.example/x.com', 'file:///etc/passwd', 'javascript:alert(1)', 'https://x.com.evil.io/', 42]) {
      expect(() => externalUrl(bad)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
  });
});
