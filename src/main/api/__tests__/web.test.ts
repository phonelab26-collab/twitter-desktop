import { describe, expect, it, vi } from 'vitest';
import { ApiError, ERROR_CODES, GuestTokenProvider } from '../client';
import { WebClient } from '../web';
import { realBody } from './fixtures';

function clientWith(responses: Response[]) {
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next;
  });
  const guestTokens = { get: vi.fn(async () => 'gt-1'), invalidate: vi.fn() } as unknown as GuestTokenProvider;
  return { web: new WebClient({ fetch: fetchImpl as unknown as typeof fetch, guestTokens }), fetchImpl, guestTokens };
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('WebClient.page', () => {
  it('returns 200 and 404 pages with their html', async () => {
    const { web, fetchImpl } = clientWith([new Response('<p>ok</p>'), new Response('<p>gone</p>', { status: 404 })]);

    await expect(web.page('/jack')).resolves.toEqual({ status: 200, html: '<p>ok</p>' });
    await expect(web.page('/ghost')).resolves.toEqual({ status: 404, html: '<p>gone</p>' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://x.com/jack');
  });

  it('throws on any other status', async () => {
    const { web } = clientWith([new Response('busy', { status: 503 })]);

    const error = await rejection(web.page('/jack'));

    expect(error.status).toBe(503);
    expect(error.retriable).toBe(true);
  });
});

describe('WebClient.rest', () => {
  it('sends the bearer and guest token and parses the JSON', async () => {
    const { web, fetchImpl } = clientWith([new Response('[{"a":1}]')]);

    await expect(web.rest('/1.1/trends/available.json')).resolves.toEqual([{ a: 1 }]);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-guest-token']).toBe('gt-1');
    expect((init.headers as Record<string, string>).authorization).toMatch(/^Bearer /);
  });

  it('refreshes a rejected guest token once', async () => {
    const { web, guestTokens } = clientWith([new Response('', { status: 401 }), new Response('[]')]);

    await expect(web.rest('/1.1/trends/available.json')).resolves.toEqual([]);
    expect(guestTokens.invalidate).toHaveBeenCalledWith('gt-1');
  });

  it('turns the real "does not exist" answer into NOT_FOUND', async () => {
    const body = JSON.stringify(realBody('trends-place.unknown-woeid'));
    const { web } = clientWith([new Response(body, { status: 404 })]);

    const error = await rejection(web.rest('/1.1/trends/place.json?id=999999999'));

    expect(error.code).toBe(ERROR_CODES.NOT_FOUND);
    expect(error.message).toContain('Sorry, that page does not exist');
  });

  it('reports a failed guest token activation as a retriable NETWORK_ERROR', async () => {
    const { web, guestTokens } = clientWith([]);
    vi.mocked(guestTokens.get).mockRejectedValueOnce(new TypeError('fetch failed'));

    const error = await rejection(web.rest('/1.1/trends/available.json'));

    expect(error.code).toBe(ERROR_CODES.NETWORK);
    expect(error.retriable).toBe(true);
  });

  it('throws BAD_RESPONSE on a 200 that is not JSON', async () => {
    const { web } = clientWith([new Response('<html>')]);

    expect((await rejection(web.rest('/x'))).code).toBe(ERROR_CODES.BAD_RESPONSE);
  });
});
