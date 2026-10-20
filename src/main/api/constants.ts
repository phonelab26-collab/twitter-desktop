/**
 * Protocol constants for the reverse-engineered X GraphQL API.
 *
 * These values were extracted from the live `x-web` client bundle. The bearer
 * token and the relay query ids are deployment-scoped: X rotates them on every
 * redeploy, so the runtime re-resolves them dynamically (see `operations.ts`).
 */

/** Guest (unauthenticated) bearer token embedded in the web client bundle. */
export const BEARER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

/**
 * The API rejects requests whose User-Agent does not look like a real
 * browser, so we always send a desktop Chrome UA.
 */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export const API_HOST = 'api.x.com';
export const GRAPHQL_BASE_PATH = '/graphql';
export const WEB_ORIGIN = 'https://x.com';

/** Guest activation endpoint that mints a `x-guest-token`. */
export const GUEST_ACTIVATE_PATH = '/1.1/guest/activate.json';

/** Base URL of the web client bundle directory, used for relay-id discovery. */
export const BUNDLE_BASE_URL = 'https://abs.twimg.com/x-web/x-web/';

/**
 * Path of the web client entry bundle. Its hash changes on every deploy, so it
 * is resolved by fetching `https://x.com/` and reading the `<script src>`.
 */
export const ENTRY_BUNDLE_PATH = '/x-web/x-web/entry-client-logged-out.js';

/** Requests per rate-limit window. The server reports this in the headers. */
export const DEFAULT_RATE_LIMIT = 150;

/**
 * Provider feature flags that the Relay endpoint requires. Sending them all as
 * `false` is what the logged-out web client does.
 */
export const PROVIDER_FLAG_PREFIX = '__relay_internal__pv__';
