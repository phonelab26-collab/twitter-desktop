/**
 * High-level operations for a guest, over three sources (docs/HANDOFF.md §4.1):
 *   - GraphQL API: getProfile, getTweet, getTrendingPosts, searchTopic.
 *     Variables found with the 422 `must be defined` loop
 *     (a local probe script, docs/HANDOFF.md §13), roots checked against __fixtures__/<op>.real.json.
 *   - x.com profile page: getUserTweets. The API refuses UserOriginalsTimeline
 *     to guests (404), but x.com runs it while rendering the page (ssr.ts).
 *   - legacy REST: getTrends, getTrendLocations (1.1/trends/*).
 *
 * Guests get one page only: profile timelines end with
 * TimelineTerminateTimeline and trending timelines with a log-in prompt, so
 * `cursor` is null (no account, no pagination).
 *
 * Every method either returns data read from the response or throws an
 * ApiError: a response whose shape is not the expected one is never turned
 * into an empty result.
 */
import { ApiError, ERROR_CODES, GraphQLClient, GuestTokenProvider } from './client';
import { PROVIDER_FLAG_PREFIX } from './constants';
import { GUEST_PROVIDER_VARIABLES, OPERATIONS } from './operations';
import {
  asRecord,
  parseProfile,
  parseTimelineEntries,
  parseTweet,
  tweetResultType,
  UNAVAILABLE_TWEET_TYPES,
} from './parsers';
import { extractSsrResults, hasSsrStream, type SsrResult } from './ssr';
import { parseTrendLocations, parseTrendPlace } from './trends';
import { WebClient, type WebSource } from './web';
import type {
  CursorPage,
  RateLimitState,
  TrendList,
  TrendLocation,
  Tweet,
  UserProfile,
} from '../../shared/types';

export const OPERATIONS_USED = {
  profile: 'UserByScreenName',
  /** Server-rendered into x.com/<handle>; a 404 on the public API. */
  userTweets: 'UserOriginalsTimeline',
  tweetResult: 'TweetResultByRestId',
  trendingPosts: 'GlobalTrendingTimelineLoggedOut',
  trendSearch: 'GlobalTrendingSearchTimelineLoggedOut',
} as const;

const DEFAULT_PAGE_SIZE = 20;

/** Yahoo WOEID of "Worldwide" in 1.1/trends/available.json. */
export const WORLDWIDE_WOEID = 1;

/** X handles: 1 to 15 letters, digits or underscores. */
const SCREEN_NAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const TWEET_ID_PATTERN = /^[0-9]{1,20}$/;
const MAX_TOPIC_LENGTH = 100;

/** A user result X reports as gone: not found for the caller, not a schema change. */
const UNAVAILABLE_USER_TYPE = 'UserUnavailable';

/**
 * The trending ops require `timeFilter`; `Day` is what the logged-out web
 * client sends and the only value validated (an unknown one is a 422).
 */
const TRENDING_TIME_FILTER = 'Day';

export interface PageOptions {
  count?: number;
  cursor?: string | null;
}

type Json = Record<string, any>;

function unexpectedShape(operationName: string, path: string): ApiError {
  return new ApiError(
    200,
    `"${operationName}" response has no "${path}"; the X schema probably changed.`,
    ERROR_CODES.UNEXPECTED_SHAPE,
    { retriable: false },
  );
}

/** X answers `{"data":{}}` (real capture) for a handle that does not exist. */
function isEmptyData(data: unknown): boolean {
  const record = asRecord(data);
  return record !== undefined && Object.keys(record).length === 0;
}

function userNotFound(operationName: string, screenName: string): ApiError {
  return new ApiError(
    404,
    `"${operationName}": user @${screenName} does not exist.`,
    ERROR_CODES.USER_NOT_FOUND,
    { retriable: false },
  );
}

/** Follows `path` in a response, failing loudly on the first missing segment. */
function requirePath(data: unknown, operationName: string, path: readonly string[]): Json {
  let node = asRecord(data);
  for (const [index, key] of path.entries()) {
    node = asRecord(node?.[key]);
    if (!node) throw unexpectedShape(operationName, path.slice(0, index + 1).join('.'));
  }
  if (!node) throw unexpectedShape(operationName, '(root)');
  return node;
}

function invalidInput(message: string): ApiError {
  return new ApiError(0, message, ERROR_CODES.INVALID_INPUT, { retriable: false });
}

/** A handle as typed by a user ("@jack" included), validated before it reaches a URL. */
export function normaliseScreenName(input: string): string {
  const screenName = input.trim().replace(/^@/, '');
  if (!SCREEN_NAME_PATTERN.test(screenName)) {
    throw invalidInput(`"${input}" is not a valid X handle (1-15 letters, digits or _).`);
  }
  return screenName;
}

function requireTweetId(input: string): string {
  const id = input.trim();
  if (!TWEET_ID_PATTERN.test(id)) throw invalidInput(`"${input}" is not a tweet id.`);
  return id;
}

/** The server-rendered result of the user's own timeline on their profile page. */
function originalsResult(results: SsrResult[], screenName: string): SsrResult | undefined {
  return results.find(
    (result) =>
      String(result.variables.screenName ?? '').toLowerCase() === screenName.toLowerCase() &&
      asRecord(asRecord(asRecord(result.response.data)?.user_result_by_screen_name)?.result)
        ?.profile_user_originals_timeline !== undefined,
  );
}

/** True when a server-rendered UserByScreenName says the account is protected. */
function isProtected(results: SsrResult[]): boolean {
  return results.some((result) => {
    const user = asRecord(asRecord(asRecord(result.response.data)?.user_result_by_screen_name)?.result);
    return asRecord(user?.privacy)?.protected === true;
  });
}

/** Keys of a results root that X sends without `result` for an unknown id (real capture). */
const NOT_FOUND_ROOT_KEYS: ReadonlySet<string> = new Set(['id', 'rest_id', '__typename']);

/**
 * True only for the bare not-found root ({id, rest_id}): a root that carries
 * other fields but no `result` is a renamed field, not a missing account or post.
 */
function isNotFoundRoot(root: Json): boolean {
  return root.result === undefined && Object.keys(root).every((key) => NOT_FOUND_ROOT_KEYS.has(key));
}

/** A timeline object must carry an `instructions` array; anything else is a schema change. */
function requireTimeline(data: unknown, operationName: string, path: readonly string[]): Json {
  const timeline = requirePath(data, operationName, path);
  if (!Array.isArray(timeline.instructions)) {
    throw unexpectedShape(operationName, `${path.join('.')}.instructions`);
  }
  return timeline;
}

/** The tweets of a timeline; an entry that no longer parses is a schema change. */
function tweetPage(timeline: Json, operationName: string): CursorPage<Tweet> {
  const { tweets, cursor, unrecognised } = parseTimelineEntries(timeline);
  if (unrecognised > 0) {
    throw new ApiError(
      200,
      `"${operationName}" returned ${unrecognised} tweet entr${unrecognised === 1 ? 'y' : 'ies'} ` +
        'that could not be parsed; the X schema probably changed.',
      ERROR_CODES.UNEXPECTED_SHAPE,
      { retriable: false },
    );
  }
  return { items: tweets, cursor };
}

/** A service whose GraphQL and web clients share one guest token. */
export function createXService(): XService {
  const guestTokens = new GuestTokenProvider();
  return new XService(new GraphQLClient({ guestTokens }), new WebClient({ guestTokens }));
}

export class XService {
  constructor(
    private readonly client: GraphQLClient = new GraphQLClient(),
    private readonly web: WebSource = new WebClient(),
  ) {}

  get rateLimit(): RateLimitState {
    return this.client.rateLimit;
  }

  /**
   * The four validated guest flags, plus any other provider flag the
   * operation declares (sent as `false`, like the logged-out web client).
   */
  private variables(operationName: string, extra: Record<string, unknown>): Record<string, unknown> {
    const declaredFlags = (OPERATIONS[operationName]?.args ?? [])
      .filter((arg) => arg.startsWith(PROVIDER_FLAG_PREFIX) && !(arg in GUEST_PROVIDER_VARIABLES))
      .map((arg) => [arg, false] as const);
    return { ...GUEST_PROVIDER_VARIABLES, ...Object.fromEntries(declaredFlags), ...extra };
  }

  private query(operationName: string, extra: Record<string, unknown>): Promise<unknown> {
    return this.client.request<unknown>({
      operationName,
      variables: this.variables(operationName, extra),
    });
  }

  /**
   * Fetches a profile by handle. Resolves to undefined when the handle does
   * not exist (X answers `{"data":{}}`, real capture), the root has no
   * `result`, or the user is UserUnavailable. Anything else that does not
   * read as a profile (a missing root, a User without id or handle) is a
   * schema change and throws, so it is never shown as "user not found".
   */
  async getProfile(input: string): Promise<UserProfile | undefined> {
    const op = OPERATIONS_USED.profile;
    const data = await this.query(op, { screenName: normaliseScreenName(input) });
    if (isEmptyData(data)) return undefined;
    const root = requirePath(data, op, ['user_result_by_screen_name']);
    if (isNotFoundRoot(root)) return undefined;
    if (root.result === undefined) throw unexpectedShape(op, 'user_result_by_screen_name.result');
    const profile = parseProfile(root);
    if (profile) return profile;
    if (asRecord(root.result)?.__typename === UNAVAILABLE_USER_TYPE) return undefined;
    throw unexpectedShape(op, 'user_result_by_screen_name.result (User)');
  }

  /**
   * A user's latest original posts (pinned post first, flagged `pinned`), as
   * x.com server-renders them into the profile page for a logged-out visitor:
   * about five posts, and no cursor (the timeline ends with
   * TimelineTerminateTimeline). An unknown handle is a 404 page and throws
   * USER_NOT_FOUND; a protected account throws PROTECTED_ACCOUNT.
   */
  async getUserTweets(input: string, signal?: AbortSignal): Promise<CursorPage<Tweet>> {
    const op = OPERATIONS_USED.userTweets;
    const screenName = normaliseScreenName(input);
    const page = await this.web.page(`/${screenName}`, signal);
    if (page.status === 404) throw userNotFound(op, screenName);

    const results = extractSsrResults(page.html);
    if (results.length === 0) {
      if (!hasSsrStream(page.html)) {
        // Not even the streaming framework: the page format changed, retrying will not help.
        throw unexpectedShape(op, 'x.com profile page stream (data-tsr-stream-part)');
      }
      // The usual page, rendered without data (login wall, temporary block): worth retrying.
      throw new ApiError(page.status, `x.com/${screenName} was served without its data; try again later.`, ERROR_CODES.PAGE_UNAVAILABLE, {
        retriable: true,
      });
    }
    const result = originalsResult(results, screenName);
    if (!result) {
      if (isProtected(results)) {
        throw new ApiError(403, `@${screenName} is protected: guests cannot see its posts.`, ERROR_CODES.PROTECTED_ACCOUNT, {
          retriable: false,
        });
      }
      throw unexpectedShape(op, 'x.com profile page result (profile_user_originals_timeline)');
    }
    if (Array.isArray(result.response.errors) && result.response.errors.length > 0) {
      throw new ApiError(200, `"${op}" was rendered with errors; the posts may be incomplete.`, ERROR_CODES.PARTIAL_RESPONSE, {
        body: JSON.stringify(result.response.errors).slice(0, 2000),
        retriable: false,
      });
    }
    const timeline = requireTimeline(result.response.data, op, [
      'user_result_by_screen_name',
      'result',
      'profile_user_originals_timeline',
      'timeline',
    ]);
    return tweetPage(timeline, op);
  }

  /**
   * Fetches a single tweet by its numeric id. `withFocalTweet` is required
   * (422 without it). An unknown id comes back as the root without `result`
   * and an unavailable tweet as a TweetUnavailable/TweetTombstone result:
   * both resolve to undefined. Any other result that is not a tweet throws.
   */
  async getTweet(input: string): Promise<Tweet | undefined> {
    const op = OPERATIONS_USED.tweetResult;
    const data = await this.query(op, { restId: requireTweetId(input), withFocalTweet: true });
    const root = requirePath(data, op, ['tweet_result_by_rest_id']);
    if (isNotFoundRoot(root)) return undefined;
    if (root.result === undefined) throw unexpectedShape(op, 'tweet_result_by_rest_id.result');
    const tweet = parseTweet(root);
    if (tweet) return tweet;
    const type = tweetResultType(root);
    if (type && UNAVAILABLE_TWEET_TYPES.has(type)) return undefined;
    throw unexpectedShape(op, 'tweet_result_by_rest_id.result (Tweet)');
  }

  /**
   * The logged-out "trending" timeline. It carries trending posts, not trend
   * names (real capture: TimelineTweet entries plus a log-in prompt), so it is
   * exposed as a tweet page. Guests get no cursor: the timeline ends with the
   * prompt, and `cursor` is then null.
   */
  async getTrendingPosts(options: PageOptions = {}): Promise<CursorPage<Tweet>> {
    const op = OPERATIONS_USED.trendingPosts;
    const data = await this.query(op, {
      timeFilter: TRENDING_TIME_FILTER,
      count: options.count ?? DEFAULT_PAGE_SIZE,
      cursor: options.cursor ?? null,
    });
    const timeline = requireTimeline(data, op, ['global_trending_timeline_logged_out', 'timeline']);
    return tweetPage(timeline, op);
  }

  /**
   * Trending posts about a topic tag. A tag X does not know yields only the
   * log-in prompt, so an empty page here is the server's answer.
   */
  async searchTopic(tag: string, options: PageOptions = {}): Promise<CursorPage<Tweet>> {
    const op = OPERATIONS_USED.trendSearch;
    const topic = tag.trim().replace(/^#/, '').trim();
    if (!topic || topic.length > MAX_TOPIC_LENGTH) throw invalidInput(`"${tag}" is not a topic.`);
    const data = await this.query(op, {
      tag: topic,
      timeFilter: TRENDING_TIME_FILTER,
      count: options.count ?? DEFAULT_PAGE_SIZE,
      cursor: options.cursor ?? null,
    });
    const timeline = requireTimeline(data, op, ['global_trending_search_timeline_logged_out', 'timeline']);
    return tweetPage(timeline, op);
  }

  /**
   * Trend names for a place (legacy REST, the only guest source of them).
   * X allows 15 calls per 15 minutes: callers should cache. An unknown woeid
   * throws NOT_FOUND.
   */
  async getTrends(woeid: number = WORLDWIDE_WOEID, signal?: AbortSignal): Promise<TrendList> {
    if (!Number.isSafeInteger(woeid) || woeid <= 0) throw invalidInput(`"${woeid}" is not a WOEID.`);
    const path = `/1.1/trends/place.json?id=${woeid}`;
    return parseTrendPlace(await this.web.rest<unknown>(path, signal), path);
  }

  /** The places X computes trends for (Worldwide, countries, towns). */
  async getTrendLocations(signal?: AbortSignal): Promise<TrendLocation[]> {
    const path = '/1.1/trends/available.json';
    return parseTrendLocations(await this.web.rest<unknown>(path, signal), path);
  }

  /** Re-crawls the live bundles, e.g. after X redeployed. */
  refreshOperations(): Promise<number> {
    return this.client.refreshRegistry();
  }
}
