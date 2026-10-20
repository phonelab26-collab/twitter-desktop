import { describe, expect, it, vi } from 'vitest';
import { BlockedRedirectError, BodyTooLargeError, fetchPinned, readTextCapped } from '../api/body';
import { Semaphore, WindowBudget } from '../budget';
import { forbiddenSwitch } from '../guard';

// guard.ts imports Electron; only its pure helper is tested here.
vi.mock('electron', () => ({ app: { on: vi.fn(), isPackaged: true }, dialog: { showErrorBox: vi.fn() } }));

describe('forbiddenSwitch (packaged launch)', () => {
  it('flags switches that open a debug port, redirect traffic or weaken the sandbox', () => {
    for (const arg of [
      '--remote-debugging-port=9222',
      '--inspect=9229',
      '--proxy-server=http://evil:8080',
      '--host-resolver-rules=MAP x.com 1.2.3.4',
      '--ignore-certificate-errors',
      '--no-sandbox',
      '--user-data-dir=/tmp/x',
      '--dev-server=http://localhost:1',
      '--load-extension=/tmp/ext',
    ]) {
      expect(forbiddenSwitch(['/app', arg])).toBe(arg);
    }
  });

  it('accepts a normal launch', () => {
    expect(forbiddenSwitch(['/Applications/Twitter Desktop.app/Contents/MacOS/Twitter Desktop'])).toBeUndefined();
  });
});

describe('WindowBudget', () => {
  it('allows max uses per window, then says when a slot frees up', () => {
    let now = 0;
    const budget = new WindowBudget(2, 1000, () => now);

    expect(budget.tryTake()).toEqual({ ok: true });
    expect(budget.tryTake()).toEqual({ ok: true });
    expect(budget.tryTake()).toEqual({ ok: false, retryInMs: 1000 });
    now = 1000;
    expect(budget.tryTake()).toEqual({ ok: true });
  });
});

describe('Semaphore', () => {
  it('never runs more than max tasks at once', async () => {
    const semaphore = new Semaphore(2);
    let running = 0;
    let peak = 0;
    const task = () =>
      semaphore.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
      });

    await Promise.all([task(), task(), task(), task(), task()]);

    expect(peak).toBe(2);
  });

  it('frees its slot when a task fails', async () => {
    const semaphore = new Semaphore(1);

    await expect(semaphore.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(semaphore.run(async () => 'next')).resolves.toBe('next');
  });
});

describe('readTextCapped', () => {
  it('reads a body under the limit', async () => {
    await expect(readTextCapped(new Response('héllo'), 100)).resolves.toBe('héllo');
  });

  it('refuses a declared size over the limit before reading', async () => {
    const response = new Response('x', { headers: { 'content-length': '1000000' } });

    await expect(readTextCapped(response, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('stops a body that grows past the limit while streaming (no content-length)', async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });

    await expect(readTextCapped(new Response(stream), 4096)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulls).toBeLessThan(10);
  });
});

describe('fetchPinned', () => {
  const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });

  it('follows a redirect that stays on an allowed host', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === 'https://x.com/Jack' ? redirectTo('/jack') : new Response('page'),
    ) as unknown as typeof fetch;

    const response = await fetchPinned(fetchImpl, 'https://x.com/Jack', {}, new Set(['x.com']));

    expect(await response.text()).toBe('page');
  });

  it('refuses a redirect to another host or to http', async () => {
    for (const location of ['https://evil.example/', 'http://x.com/jack']) {
      const fetchImpl = vi.fn(async () => redirectTo(location)) as unknown as typeof fetch;

      await expect(fetchPinned(fetchImpl, 'https://x.com/a', {}, new Set(['x.com']))).rejects.toBeInstanceOf(
        BlockedRedirectError,
      );
    }
  });

  it('gives up after a few hops', async () => {
    const fetchImpl = vi.fn(async () => redirectTo('https://x.com/loop')) as unknown as typeof fetch;

    await expect(fetchPinned(fetchImpl, 'https://x.com/loop', {}, new Set(['x.com']))).rejects.toBeInstanceOf(
      BlockedRedirectError,
    );
  });
});
