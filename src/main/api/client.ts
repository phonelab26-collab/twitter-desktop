/**
 * Low-level GraphQL client for the reverse-engineered `api.x.com/graphql` endpoint.
 *
 * Protocol summary (validated against the live web client, see docs/HANDOFF.md §3):
 *   GET https://api.x.com/graphql/{relayId}/{OperationName}?variables=<urlencoded json>
 *   Authorization: Bearer <guest bearer>
 *   x-guest-token: <minted by /1.1/guest/activate.json>
 *   User-Agent: <browser UA>            (required: the server rejects other clients)
 *
 * Status semantics (HANDOFF §4): 404 with an empty body usually means the
 * operation is not deployed server-side, NOT that the relay id rotated. The
 * client therefore re-discovers an id at most once per request and gives up
 * as soon as the live bundles confirm the id it already used.
 */
import {
  API_HOST,
  BEARER_TOKEN,
  GRAPHQL_BASE_PATH,
  GUEST_ACTIVATE_PATH,
  USER_AGENT,
} from './constants';
import { Semaphore } from '../budget';
import {
  BodyTooLargeError,
  MAX_ACTIVATE_BYTES,
  MAX_ERROR_BYTES,
  MAX_JSON_BYTES,
  readTextCapped,
} from './body';
import { fetchOperationRegistry } from './discovery';
import { OPERATIONS, type OperationInfo } from './operations';
import type { ApiError as ApiErrorShape, ApiResult, RateLimitState } from '../../shared/types';

const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
/** GraphQL requests in flight at once, whatever the number of callers. */
const MAX_CONCURRENT_REQUESTS = 4;
/** Upstream text kept in an ApiError: bounded, so X cannot push megabytes to the UI or the logs. */
const MAX_MESSAGE_CHARS = 300;
const MAX_BODY_CHARS = 2000;
/** A crawl walks hundreds of bundles: never repeat one within this window. */
const REGISTRY_TTL_MS = 5 * 60_000;

export const ERROR_CODES = {
  NOT_DEPLOYED: 'OPERATION_NOT_DEPLOYED',
  UNKNOWN_OPERATION: 'UNKNOWN_OPERATION',
  GUEST_TOKEN: 'GUEST_TOKEN_UNAVAILABLE',
  DISCOVERY_FAILED: 'DISCOVERY_FAILED',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK_ERROR',
  BAD_RESPONSE: 'BAD_RESPONSE',
  UNEXPECTED_SHAPE: 'UNEXPECTED_SHAPE',
  /** A 200 that carries GraphQL `errors` next to its data: the data may be incomplete. */
  PARTIAL_RESPONSE: 'PARTIAL_RESPONSE',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  /** A REST resource X reports as absent (HTTP 404, error code 34). */
  NOT_FOUND: 'NOT_FOUND',
  /** The account is protected: guests cannot see its posts. */
  PROTECTED_ACCOUNT: 'PROTECTED_ACCOUNT',
  /** x.com served a page without any rendered data (login wall, temporary block): retry later. */
  PAGE_UNAVAILABLE: 'PAGE_UNAVAILABLE',
  /** The app's own limit on a quota-limited endpoint was reached. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** X answered with an HTTP error status (403, 5xx...) where a page or JSON was expected. */
  HTTP_ERROR: 'HTTP_ERROR',
  /** Bad input rejected before any request (handle, woeid, tweet id). */
  INVALID_INPUT: 'INVALID_INPUT',
} as const;

type FetchFn = typeof fetch;
type Registry = Readonly<Record<string, OperationInfo>>;

export interface RequestOptions {
  variables?: Record<string, unknown>;
  operationName: string;
  /** Relay id. When absent it is looked up from the local operations registry. */
  relayId?: string;
  signal?: AbortSignal;
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; code?: number | string; path?: unknown[] }>;
}

export interface GraphQLErrorDetail {
  message: string;
  code?: string;
  path?: unknown[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retriable: boolean;
  /** The full, untruncated response body. */
  readonly body?: string;
  /** Parsed GraphQL errors, when the body carried them. */
  readonly graphqlErrors?: GraphQLErrorDetail[];

  constructor(
    status: number,
    message: string,
    code?: string,
    extra?: { body?: string; graphqlErrors?: GraphQLErrorDetail[]; retriable?: boolean },
  ) {
    super(truncate(message, MAX_MESSAGE_CHARS));
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retriable = extra?.retriable ?? (status === 429 || status === 0 || status >= 500);
    this.body = extra?.body === undefined ? undefined : truncate(extra.body, MAX_BODY_CHARS);
    this.graphqlErrors = extra?.graphqlErrors;
  }

  /**
   * The names of the GraphQL variables the server said were missing.
   *
   * X replies with `path: ["variable", "<name>"]` for every required variable
   * that was not supplied, so this drives the discovery of an operation's
   * required variable set.
   */
  get missingVariables(): string[] {
    const names: string[] = [];
    for (const error of this.graphqlErrors ?? []) {
      const path = error.path;
      if (Array.isArray(path) && path[0] === 'variable' && typeof path[1] === 'string') {
        names.push(path[1]);
      }
    }
    return names;
  }

  toJSON(): ApiErrorShape {
    return {
      message: this.message,
      status: this.status,
      code: this.code,
      retriable: this.retriable,
    };
  }
}

/**
 * Mints and caches the `x-guest-token` that the logged-out web client sends.
 * A failed activation is an error: sending the request without the token only
 * turns it into an opaque 401 further down.
 */
export class GuestTokenProvider {
  private token: string | null = null;
  private pending: Promise<string> | null = null;
  private readonly bearer: string;
  private readonly userAgent: string;
  private readonly fetchImpl: FetchFn;
  private readonly timeoutMs: number;

  constructor(
    options: { bearer?: string; userAgent?: string; fetch?: FetchFn; timeoutMs?: number } = {},
  ) {
    this.bearer = options.bearer ?? BEARER_TOKEN;
    this.userAgent = options.userAgent ?? USER_AGENT;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async get(): Promise<string> {
    if (this.token) return this.token;
    this.pending ??= this.activate().finally(() => {
      this.pending = null;
    });
    this.token = await this.pending;
    return this.token;
  }

  /**
   * Discards the cached token so the next call mints a fresh one. When the
   * rejected token is given, a newer token minted meanwhile by a concurrent
   * request is kept instead of being thrown away too.
   */
  invalidate(rejected?: string): void {
    if (rejected === undefined || this.token === rejected) this.token = null;
  }

  private async activate(): Promise<string> {
    const response = await this.fetchImpl(`https://${API_HOST}${GUEST_ACTIVATE_PATH}`, {
      method: 'POST',
      // A redirect would carry the bearer's request somewhere else.
      redirect: 'error',
      headers: { authorization: `Bearer ${this.bearer}`, 'user-agent': this.userAgent },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new ApiError(
        response.status,
        `Guest token activation failed: HTTP ${response.status}.`,
        ERROR_CODES.GUEST_TOKEN,
      );
    }
    const text = await readTextCapped(response, MAX_ACTIVATE_BYTES);
    let payload: { guest_token?: unknown };
    try {
      payload = JSON.parse(text) as { guest_token?: unknown };
    } catch {
      throw new ApiError(response.status, 'Guest activation returned a non-JSON body.', ERROR_CODES.GUEST_TOKEN, {
        body: text,
        retriable: false,
      });
    }
    if (typeof payload.guest_token !== 'string' || !payload.guest_token) {
      throw new ApiError(response.status, 'Guest activation returned no token.', ERROR_CODES.GUEST_TOKEN);
    }
    return payload.guest_token;
  }
}

export class RateLimiter {
  private limit = 150;
  private remaining = 150;
  private resetAt = 0;

  updateFrom(headers: Headers): void {
    const limit = Number(headers.get('x-rate-limit-limit'));
    const remaining = Number(headers.get('x-rate-limit-remaining'));
    const reset = Number(headers.get('x-rate-limit-reset'));
    if (headers.has('x-rate-limit-limit') && Number.isFinite(limit) && limit > 0) this.limit = limit;
    if (headers.has('x-rate-limit-remaining') && Number.isFinite(remaining) && remaining >= 0) {
      this.remaining = remaining;
    }
    if (Number.isFinite(reset) && reset > 0) this.resetAt = reset * 1000;
  }

  get state(): RateLimitState {
    return { limit: this.limit, remaining: this.remaining, resetAt: this.resetAt };
  }

  /** Milliseconds to wait before the next request is allowed. */
  waitTime(now = Date.now()): number {
    return Math.min(this.blockedFor(now), MAX_RATE_LIMIT_WAIT_MS);
  }

  /** Milliseconds until the window resets when no request is left, else 0 (uncapped). */
  blockedFor(now = Date.now()): number {
    if (this.remaining > 0 || now >= this.resetAt) return 0;
    return this.resetAt - now + 1000;
  }

  /** Counts a request as sent before its response arrives, so concurrent callers see it. */
  reserve(): void {
    if (this.remaining > 0) this.remaining -= 1;
  }
}

export interface GraphQLClientOptions {
  bearer?: string;
  userAgent?: string;
  fetch?: FetchFn;
  guestTokens?: GuestTokenProvider;
  /** Live operation registry loader. Defaults to crawling the x-web bundles. */
  loadRegistry?: () => Promise<Registry>;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export class GraphQLClient {
  private readonly rateLimiter = new RateLimiter();
  private readonly slots = new Semaphore(MAX_CONCURRENT_REQUESTS);
  private readonly relayIdCache = new Map<string, string>();
  private registry: { loadedAt: number; promise: Promise<Registry> } | null = null;
  private readonly bearer: string;
  private readonly userAgent: string;
  private readonly fetchImpl: FetchFn;
  private readonly guestTokens: GuestTokenProvider;
  private readonly loadRegistry: () => Promise<Registry>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: GraphQLClientOptions = {}) {
    this.bearer = options.bearer ?? BEARER_TOKEN;
    this.userAgent = options.userAgent ?? USER_AGENT;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.guestTokens =
      options.guestTokens ??
      new GuestTokenProvider({
        bearer: this.bearer,
        userAgent: this.userAgent,
        fetch: this.fetchImpl,
        timeoutMs: options.timeoutMs,
      });
    this.loadRegistry = options.loadRegistry ?? (() => fetchOperationRegistry({ fetch: this.fetchImpl }));
    this.sleep = options.sleep ?? delay;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  get rateLimit(): RateLimitState {
    return this.rateLimiter.state;
  }

  /** Cached id, then bundled snapshot, then live discovery. */
  async resolveRelayId(operationName: string): Promise<string> {
    const cached = this.relayIdCache.get(operationName) ?? OPERATIONS[operationName]?.relayId;
    if (cached) return cached;
    return this.rediscover(operationName);
  }

  /** Forces a fresh crawl and returns the number of operations it found. */
  async refreshRegistry(): Promise<number> {
    this.registry = null;
    this.relayIdCache.clear();
    return Object.keys(await this.liveRegistry()).length;
  }

  /**
   * Sends one operation. 404 (id rotation) and 401/403 (stale guest token)
   * each get one recovery that does not consume the retry budget; transient
   * failures (timeouts, 429, 5xx) are retried up to MAX_ATTEMPTS times.
   */
  async request<T>(options: RequestOptions): Promise<T> {
    const { operationName, signal } = options;
    let relayId = options.relayId ?? (await this.resolveRelayId(operationName));
    let rediscovered = Boolean(options.relayId);
    let guestRefreshed = false;
    let failures = 0;

    for (;;) {
      let failure: ApiError;
      let retryDelay = backoff(failures);
      try {
        const url = buildUrl(relayId, operationName, options.variables ?? {});
        const { response, guestToken } = await this.slots.run(async () => {
          await this.waitForRateLimit();
          this.rateLimiter.reserve();
          return this.send(url, signal);
        });
        this.rateLimiter.updateFrom(response.headers);

        if (response.status === 404) {
          if (rediscovered) throw notDeployed(operationName, relayId);
          rediscovered = true;
          const fresh = await this.rediscover(operationName);
          if (fresh === relayId) throw notDeployed(operationName, relayId);
          relayId = fresh;
          continue;
        }
        if ((response.status === 401 || response.status === 403) && !guestRefreshed) {
          guestRefreshed = true;
          this.guestTokens.invalidate(guestToken);
          continue;
        }
        if (response.ok) return await readPayload<T>(response, operationName);
        if (response.status === 429) retryDelay = retryAfterMs(response, this.rateLimiter.waitTime(), retryDelay);
        failure = await errorFromResponse(response);
      } catch (error) {
        // Re-discovery already gave its verdict; re-sending the stale id would only report a 404.
        if (error instanceof ApiError && error.code === ERROR_CODES.DISCOVERY_FAILED) throw error;
        failure = toTransportError(error, signal);
      }

      failures += 1;
      if (!failure.retriable || failures >= MAX_ATTEMPTS) throw failure;
      await this.sleep(retryDelay);
    }
  }

  /**
   * Waits for the rate-limit window when it resets within a minute; a longer
   * wait fails now (RATE_LIMITED) instead of re-sending every minute until
   * the reset.
   */
  private async waitForRateLimit(): Promise<void> {
    const blocked = this.rateLimiter.blockedFor();
    if (blocked > MAX_RATE_LIMIT_WAIT_MS) {
      const minutes = Math.ceil(blocked / 60_000);
      throw new ApiError(429, `X rate limit reached; try again in ${minutes} min.`, ERROR_CODES.RATE_LIMITED, {
        retriable: false,
      });
    }
    await this.sleep(blocked);
  }

  /**
   * Re-resolves an id from the live bundles. Concurrent callers share one
   * crawl, and a crawl is reused for REGISTRY_TTL_MS.
   */
  private async rediscover(operationName: string): Promise<string> {
    let registry: Registry;
    try {
      registry = await this.liveRegistry();
    } catch (error) {
      throw new ApiError(
        0,
        `Relay id re-discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        ERROR_CODES.DISCOVERY_FAILED,
        // A failed or partial crawl is not cached: trying again later may succeed.
        { retriable: true },
      );
    }
    const found = registry[operationName];
    if (!found) {
      throw new ApiError(
        404,
        `Operation "${operationName}" is not present in the live web client.`,
        ERROR_CODES.UNKNOWN_OPERATION,
        { retriable: false },
      );
    }
    this.relayIdCache.set(operationName, found.relayId);
    return found.relayId;
  }

  private liveRegistry(): Promise<Registry> {
    const now = Date.now();
    if (this.registry && now - this.registry.loadedAt < REGISTRY_TTL_MS) {
      return this.registry.promise;
    }
    const promise = this.loadRegistry();
    const entry = { loadedAt: now, promise };
    this.registry = entry;
    // A failed crawl must not be cached: the next caller retries it.
    promise.catch(() => {
      if (this.registry === entry) this.registry = null;
    });
    return promise;
  }

  private async send(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ response: Response; guestToken: string }> {
    const guestToken = await this.guestTokens.get();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const response = await this.fetchImpl(url, {
      method: 'GET',
      // A redirect would send the guest token to another URL: fail instead.
      redirect: 'error',
      signal: combined,
      headers: {
        authorization: `Bearer ${this.bearer}`,
        'user-agent': this.userAgent,
        'x-guest-token': guestToken,
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
        accept: 'application/json',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    return { response, guestToken };
  }
}

function buildUrl(relayId: string, operationName: string, variables: Record<string, unknown>): string {
  const encoded = encodeURIComponent(JSON.stringify(variables));
  return `https://${API_HOST}${GRAPHQL_BASE_PATH}/${relayId}/${operationName}?variables=${encoded}`;
}

function notDeployed(operationName: string, relayId: string): ApiError {
  return new ApiError(
    404,
    `Operation "${operationName}" (${relayId}) is not deployed for guests.`,
    ERROR_CODES.NOT_DEPLOYED,
    { retriable: false },
  );
}

/**
 * The real reason of a failed fetch: undici reports "fetch failed" and puts
 * the DNS, TLS, refused-connection or redirect cause in `error.cause`.
 */
export function networkDetail(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const parts = [cause?.code, cause?.message].filter((part): part is string => typeof part === 'string' && part !== '');
  const base = error instanceof Error ? error.message : String(error);
  return parts.length > 0 ? `${base} (${parts.join(': ')})` : base;
}

/**
 * Caller aborts propagate untouched; ApiErrors pass through; an oversized body
 * is BAD_RESPONSE; timeouts and network failures become ApiErrors with their cause.
 */
export function toTransportError(error: unknown, callerSignal?: AbortSignal): ApiError {
  if (callerSignal?.aborted) throw error;
  if (error instanceof ApiError) return error;
  if (error instanceof BodyTooLargeError) {
    return new ApiError(0, `X sent a response larger than ${error.limit} bytes.`, ERROR_CODES.BAD_RESPONSE, {
      retriable: false,
    });
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ApiError(0, 'Request to X timed out.', ERROR_CODES.TIMEOUT);
  }
  return new ApiError(0, `Network error: ${networkDetail(error)}`, ERROR_CODES.NETWORK);
}

/** retry-after, else the rate-limit reset, else the regular backoff. */
function retryAfterMs(response: Response, resetWait: number, backoffWait: number): number {
  const seconds = Number(response.headers.get('retry-after'));
  const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : resetWait || backoffWait;
  return Math.min(wait, MAX_RATE_LIMIT_WAIT_MS);
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  // The status is the error; a body too large or cut off only loses the detail.
  const body = await readTextCapped(response, MAX_ERROR_BYTES).catch((error: unknown) => `(body unreadable: ${networkDetail(error)})`);
  const details = parseGraphQLErrors(body);
  const first = details[0];
  return new ApiError(
    response.status,
    first?.message ?? `HTTP ${response.status}: ${truncate(body, 200)}`,
    first?.code,
    { body, graphqlErrors: details },
  );
}

/**
 * The `data` of a 200. GraphQL `errors` are never dropped: with data they
 * mean the data may be incomplete (`{"data":{},"errors":[...]}` is not an
 * empty answer), so they throw PARTIAL_RESPONSE with the full body attached.
 */
async function readPayload<T>(response: Response, operationName: string): Promise<T> {
  const text = await readTextCapped(response, MAX_JSON_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(
      response.status,
      `"${operationName}" returned a non-JSON-object body: ${truncate(text, 120)}`,
      ERROR_CODES.BAD_RESPONSE,
      { body: text, retriable: false },
    );
  }
  const payload = parsed as GraphQLResponse<T>;
  const hasData = payload.data !== undefined && payload.data !== null;
  const rawErrors: unknown = payload.errors;
  const hasErrors = Array.isArray(rawErrors)
    ? rawErrors.length > 0
    : rawErrors !== undefined && rawErrors !== null;
  if (hasData && !hasErrors) return payload.data as T;

  const graphqlErrors = graphQLErrorsOf(parsed);
  const fallback = hasErrors
    ? `"${operationName}" returned GraphQL errors it could not read.`
    : `"${operationName}" returned no data.`;
  throw new ApiError(
    response.status,
    graphqlErrors[0]?.message ?? fallback,
    hasData ? ERROR_CODES.PARTIAL_RESPONSE : (graphqlErrors[0]?.code ?? ERROR_CODES.BAD_RESPONSE),
    { body: text, graphqlErrors, retriable: false },
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Parses the GraphQL error list out of a response body. A body that is not
 * JSON simply carries no GraphQL errors; the caller keeps the raw text.
 */
function parseGraphQLErrors(body: string): GraphQLErrorDetail[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  return graphQLErrorsOf(parsed);
}

/** The readable entries (those with a string message) of a payload's `errors`. */
function graphQLErrorsOf(payload: unknown): GraphQLErrorDetail[] {
  const errors = (payload as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .filter((error): error is GraphQLErrorDetail => typeof error?.message === 'string')
    .map((error) => ({
      message: error.message,
      code: error.code !== undefined ? String(error.code) : undefined,
      path: Array.isArray(error.path) ? error.path : undefined,
    }));
}

function backoff(attempt: number): number {
  return 500 * 2 ** attempt + Math.random() * 250;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export function toResult<T>(promise: Promise<T>): Promise<ApiResult<T>> {
  return promise.then(
    (data) => ({ ok: true, data }),
    (error) => ({
      ok: false,
      error:
        error instanceof ApiError
          ? error.toJSON()
          : {
              message: error instanceof Error ? error.message : String(error),
              status: 0,
              retriable: false,
            },
    }),
  );
}
