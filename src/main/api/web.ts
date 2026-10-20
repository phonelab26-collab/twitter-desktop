/**
 * The two non-GraphQL sources a guest can still read (docs/HANDOFF.md §5.3, §6):
 *   - x.com pages, whose server-rendered GraphQL results ssr.ts extracts;
 *   - the legacy REST API on api.x.com (1.1/trends/*), with the guest token.
 *
 * Errors follow client.ts: every failure is an ApiError, a guest token
 * rejected with 401/403 is refreshed once, and nothing is retried silently.
 */
import { BlockedRedirectError, fetchPinned, MAX_ERROR_BYTES, MAX_JSON_BYTES, MAX_PAGE_BYTES, readTextCapped } from './body';
import { ApiError, ERROR_CODES, GuestTokenProvider, toTransportError } from './client';
import { API_HOST, BEARER_TOKEN, USER_AGENT, WEB_ORIGIN } from './constants';

const REQUEST_TIMEOUT_MS = 30_000;
/** A page request (no token) may follow redirects within x.com only. */
const PAGE_HOSTS: ReadonlySet<string> = new Set(['x.com']);

type FetchFn = typeof fetch;

export interface WebPage {
  /** 200 for a page with content; x.com answers 404 for an unknown handle. */
  status: number;
  html: string;
}

/** What XService needs beyond GraphQL; tests replace it with a fake. */
export interface WebSource {
  page(path: string, signal?: AbortSignal): Promise<WebPage>;
  rest<T>(path: string, signal?: AbortSignal): Promise<T>;
}

export interface WebClientOptions {
  fetch?: FetchFn;
  guestTokens?: GuestTokenProvider;
  timeoutMs?: number;
}

export class WebClient implements WebSource {
  private readonly fetchImpl: FetchFn;
  private readonly guestTokens: GuestTokenProvider;
  private readonly timeoutMs: number;

  constructor(options: WebClientOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.guestTokens =
      options.guestTokens ?? new GuestTokenProvider({ fetch: this.fetchImpl, timeoutMs: this.timeoutMs });
  }

  /**
   * GETs an x.com page as a logged-out browser. Only 200 and 404 carry a page;
   * redirects are followed only within x.com (a renamed or re-cased handle).
   */
  async page(path: string, signal?: AbortSignal): Promise<WebPage> {
    if (!path.startsWith('/')) throw new Error(`Page path must start with "/": ${path}`);
    const what = `x.com${path}`;
    return this.guard(what, signal, async () => {
      const response = await fetchPinned(this.fetchImpl, `${WEB_ORIGIN}${path}`, this.init({ accept: 'text/html' }, signal), PAGE_HOSTS);
      if (response.status !== 200 && response.status !== 404) {
        const body = await readTextCapped(response, MAX_ERROR_BYTES).catch(() => '');
        throw new ApiError(response.status, `${what} answered HTTP ${response.status}.`, ERROR_CODES.HTTP_ERROR, { body });
      }
      return { status: response.status, html: await readTextCapped(response, MAX_PAGE_BYTES) };
    });
  }

  /** GETs a legacy REST endpoint with the guest token and returns its JSON. Redirects are refused. */
  async rest<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.guard(path, signal, async () => {
      let refreshed = false;
      for (;;) {
        const token = await this.guestTokens.get();
        const response = await this.fetchImpl(
          `https://${API_HOST}${path}`,
          // A redirect would carry the guest token to another URL: fail instead.
          {
            ...this.init({ accept: 'application/json', authorization: `Bearer ${BEARER_TOKEN}`, 'x-guest-token': token }, signal),
            redirect: 'error',
          },
        );
        if ((response.status === 401 || response.status === 403) && !refreshed) {
          await response.body?.cancel().catch(() => undefined);
          refreshed = true;
          this.guestTokens.invalidate(token);
          continue;
        }
        if (!response.ok) {
          const body = await readTextCapped(response, MAX_ERROR_BYTES).catch(() => '');
          throw restError(response.status, path, body);
        }
        const body = await readTextCapped(response, MAX_JSON_BYTES);
        try {
          return JSON.parse(body) as T;
        } catch {
          throw new ApiError(response.status, `${path} returned a non-JSON body.`, ERROR_CODES.BAD_RESPONSE, {
            body,
            retriable: false,
          });
        }
      }
    });
  }

  private init(headers: Record<string, string>, signal?: AbortSignal): RequestInit {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return {
      method: 'GET',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'en-US,en;q=0.9', ...headers },
    };
  }

  /**
   * Runs one request, body read included, and turns every failure into an
   * ApiError with its real cause (guest token, network, timeout, size, redirect).
   */
  private async guard<T>(what: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (error instanceof BlockedRedirectError) {
        throw new ApiError(0, `${what}: ${error.message}`, ERROR_CODES.BAD_RESPONSE, { retriable: false });
      }
      throw toTransportError(error, signal);
    }
  }
}

/** REST errors are `{"errors":[{"code":34,"message":"..."}]}`; code 34 is "does not exist". */
function restError(status: number, path: string, body: string): ApiError {
  let message = `${path} answered HTTP ${status}.`;
  let code: string | undefined;
  try {
    const first = (JSON.parse(body) as { errors?: Array<{ code?: unknown; message?: unknown }> }).errors?.[0];
    if (typeof first?.message === 'string') message = `${path}: ${first.message}`;
    if (first?.code !== undefined) code = String(first.code);
  } catch {
    // Not JSON (an HTML error page): the status and the raw body say it all.
  }
  return new ApiError(status, message, status === 404 ? ERROR_CODES.NOT_FOUND : (code ?? ERROR_CODES.HTTP_ERROR), { body });
}
