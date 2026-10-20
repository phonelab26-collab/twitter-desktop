import { describe, expect, it, vi } from 'vitest';
import { ApiError, ERROR_CODES, GraphQLClient, GuestTokenProvider } from '../client';
import type { OperationInfo } from '../operations';

const OP = 'UserTweets';
const SNAPSHOT_ID = 'w5jr4AzUpoN8VpOQgrNjbw';

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function setup(handler: Handler, registry: Record<string, OperationInfo> = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/guest/activate.json')) {
      return Response.json({ guest_token: 'gt-1' });
    }
    return handler(url, init);
  }) as unknown as typeof fetch;
  const loadRegistry = vi.fn(async () => registry);
  const client = new GraphQLClient({
    fetch: fetchImpl,
    loadRegistry,
    sleep: async () => {},
    timeoutMs: 50,
  });
  return { client, calls, loadRegistry, fetchImpl };
}

/** Awaits a promise that must reject with an ApiError. */
async function apiRejection(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

const info = (relayId: string): OperationInfo => ({ relayId, kind: 'query', args: [], guest: true });

describe('GraphQLClient 404 handling', () => {
  it('reports an undeployed operation after a single re-discovery', async () => {
    const { client, loadRegistry } = setup(
      () => new Response('', { status: 404 }),
      { [OP]: info(SNAPSHOT_ID) },
    );

    const error = await apiRejection(client.request({ operationName: OP }));

    expect(error.code).toBe(ERROR_CODES.NOT_DEPLOYED);
    expect(loadRegistry).toHaveBeenCalledTimes(1);
  });

  it('retries with the rotated relay id', async () => {
    const { client } = setup(
      (url) =>
        url.includes('/NEWID/')
          ? Response.json({ data: { ok: true } })
          : new Response('', { status: 404 }),
      { [OP]: info('NEWID') },
    );

    await expect(client.request({ operationName: OP })).resolves.toEqual({ ok: true });
  });

  it('shares one crawl between concurrent 404s', async () => {
    const { client, loadRegistry } = setup(
      (url) =>
        url.includes('/NEWID/')
          ? Response.json({ data: { ok: true } })
          : new Response('', { status: 404 }),
      { [OP]: info('NEWID') },
    );

    await Promise.all([
      client.request({ operationName: OP }),
      client.request({ operationName: OP }),
      client.request({ operationName: OP }),
    ]);

    expect(loadRegistry).toHaveBeenCalledTimes(1);
  });
});

describe('GraphQLClient guest token', () => {
  it('mints a fresh guest token after a 401 and retries once', async () => {
    let graphqlCalls = 0;
    const { client, calls } = setup(() => {
      graphqlCalls += 1;
      return graphqlCalls === 1
        ? new Response('', { status: 401 })
        : Response.json({ data: { ok: true } });
    });

    await expect(client.request({ operationName: OP })).resolves.toEqual({ ok: true });
    expect(calls.filter((u) => u.includes('/guest/activate.json'))).toHaveLength(2);
  });

  it('surfaces a failed activation instead of sending an unauthenticated request', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    const provider = new GuestTokenProvider({ fetch: fetchImpl });

    await expect(provider.get()).rejects.toMatchObject({ code: ERROR_CODES.GUEST_TOKEN });
  });
});

describe('GraphQLClient transport errors', () => {
  it('turns a timeout into a retriable ApiError', async () => {
    const { client } = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    const error = await apiRejection(client.request({ operationName: OP }));

    expect(error.code).toBe(ERROR_CODES.TIMEOUT);
    expect(error.retriable).toBe(true);
  });

  it('does not retry when the caller aborts', async () => {
    const controller = new AbortController();
    const { client, fetchImpl } = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          controller.abort();
        }),
    );

    const error = await client.request({ operationName: OP, signal: controller.signal }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ name: "AbortError" });
    expect(error).not.toBeInstanceOf(ApiError);
    // One activation + one GraphQL call: no retry.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a 200 response that carries no data', async () => {
    const { client } = setup(() => Response.json({}));

    await expect(client.request({ operationName: OP })).rejects.toMatchObject({
      code: ERROR_CODES.BAD_RESPONSE,
    });
  });

  it('surfaces GraphQL errors that come with data instead of dropping them', async () => {
    const errors = [{ message: 'Timeout: Unspecified', code: 29, path: ['user', 'legacy'] }];
    const { client } = setup(() => Response.json({ data: { ok: true }, errors }));

    const error = await apiRejection(client.request({ operationName: OP }));

    expect(error.code).toBe(ERROR_CODES.PARTIAL_RESPONSE);
    expect(error.message).toContain('Timeout: Unspecified');
    expect(error.graphqlErrors).toEqual([{ message: 'Timeout: Unspecified', code: '29', path: ['user', 'legacy'] }]);
    expect(error.body).toContain('"ok":true');
    expect(error.retriable).toBe(false);
  });

  it('surfaces errors that come with an empty data object', async () => {
    const { client } = setup(() => Response.json({ data: {}, errors: [{ message: 'boom' }] }));

    await expect(client.request({ operationName: OP })).rejects.toMatchObject({
      code: ERROR_CODES.PARTIAL_RESPONSE,
    });
  });

  it('surfaces an errors member it cannot read rather than ignoring it', async () => {
    const { client } = setup(() => Response.json({ data: { ok: true }, errors: [{ code: 1 }] }));

    await expect(client.request({ operationName: OP })).rejects.toMatchObject({
      code: ERROR_CODES.PARTIAL_RESPONSE,
    });
  });

  it('returns data when the errors list is empty', async () => {
    const { client } = setup(() => Response.json({ data: { ok: true }, errors: [] }));

    await expect(client.request({ operationName: OP })).resolves.toEqual({ ok: true });
  });

  it('rejects a JSON body that is not an object as a bad response', async () => {
    const { client } = setup(() => new Response('null', { status: 200 }));

    await expect(client.request({ operationName: OP })).rejects.toMatchObject({
      code: ERROR_CODES.BAD_RESPONSE,
    });
  });

  it('rejects a 200 HTML body as a non-retriable bad response', async () => {
    const { client, fetchImpl } = setup(() => new Response('<html>', { status: 200 }));

    const error = await apiRejection(client.request({ operationName: OP }));

    expect(error.code).toBe(ERROR_CODES.BAD_RESPONSE);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('GraphQLClient retry budget', () => {
  it('still tries the rotated id after three rate-limited attempts', async () => {
    let graphqlCalls = 0;
    const { client } = setup(
      (url) => {
        graphqlCalls += 1;
        if (graphqlCalls <= 3) return new Response('', { status: 429 });
        return url.includes('/NEWID/')
          ? Response.json({ data: { ok: true } })
          : new Response('', { status: 404 });
      },
      { [OP]: info('NEWID') },
    );

    await expect(client.request({ operationName: OP })).resolves.toEqual({ ok: true });
  });

  it('stops on a failed re-discovery crawl with a DISCOVERY_FAILED the user may retry later', async () => {
    const { client, loadRegistry } = setup(() => new Response('', { status: 404 }));
    loadRegistry.mockRejectedValueOnce(new Error('Failed to load https://abs.twimg.com/x: HTTP 503'));

    const error = await apiRejection(client.request({ operationName: OP }));

    expect(error.code).toBe(ERROR_CODES.DISCOVERY_FAILED);
    expect(error.retriable).toBe(true);
  });
});

