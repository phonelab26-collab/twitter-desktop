/**
 * What the agent link reads from x.com's own traffic in the "Mon X" view:
 * which responses carry a feed, and the posts in them. Pure functions; the
 * Electron side (cdpTap.ts) only hands over response metadata and bodies.
 *
 * Nothing here sends a request to X: the posts are the ones x.com already
 * loaded for the user. Only feeds known by name are read (allow-lists, never
 * a guess); personal timelines (bookmarks, likes, notifications, messages)
 * and feeds the app does not know are reported, not read.
 */
import { OPERATIONS } from '../api/operations';
import { asRecord, parseTimelineItems, type TimelineItem } from '../api/parsers';
import { extractSsrResults } from '../api/ssr';
import { isXUrl } from '../xpolicy';

export type FeedSource = 'home' | 'search' | 'list' | 'profile' | 'post' | 'community' | 'trending';

export const FEED_SOURCES: readonly FeedSource[] = ['home', 'search', 'list', 'profile', 'post', 'community', 'trending'];

/**
 * Operations whose timelines are read: the classic web client's names and
 * the x-web (Relay) names of operations.ts, which a signed-in x.com uses.
 * Not genericTimelineQuery: it pages any timeline by an opaque id, likes and
 * bookmarks included.
 */
const CAPTURED_OPERATIONS: ReadonlyMap<string, FeedSource> = new Map<string, FeedSource>([
  ['HomeTimeline', 'home'],
  ['HomeLatestTimeline', 'home'],
  ['HomeTimelineQuery', 'home'],
  ['HomeLatestTimelineQuery', 'home'],
  ['SearchTimeline', 'search'],
  ['SearchByRawQuery', 'search'],
  ['ListLatestTweetsTimeline', 'list'],
  ['listTweetsQuery', 'list'],
  ['UserTweets', 'profile'],
  ['UserTweetsAndReplies', 'profile'],
  ['UserMedia', 'profile'],
  ['UserOriginalsTimeline', 'profile'],
  ['UserRepliesTimeline', 'profile'],
  ['UserRepostsTimeline', 'profile'],
  ['UserPhotoTimeline', 'profile'],
  ['UserVideoTimeline', 'profile'],
  ['UserHighlightsTweets', 'profile'],
  ['TweetDetail', 'post'],
  ['CommunityTweetsTimeline', 'community'],
  ['communityTimelineQuery', 'community'],
  ['communityTimelineRankedQuery', 'community'],
  ['GlobalTrendingTimelineLoggedOut', 'trending'],
  ['GlobalTrendingSearchTimelineLoggedOut', 'trending'],
  ['GlobalTrendingSearchPostsLoggedOut', 'trending'],
]);

/** An operation or response key about the user's own activity: never read. */
const PERSONAL = /bookmark|like|favorite|notification|message|(^|_)dm(_|$)/i;
/** An unknown operation that looks like a feed: reported, so a renamed one shows up. */
const FEED_LIKE = /timeline|tweets|posts|search|feed/i;

/**
 * Keys of a server-rendered response that name a feed the app reads, checked
 * from the deepest key up. Used when a page's relay id is not in the bundled
 * snapshot: X rotates them on every deploy (seen 2026-10-22), while these
 * field names stay.
 */
const KEY_SOURCES: ReadonlyArray<readonly [RegExp, FeedSource]> = [
  [/^home_timeline/, 'home'],
  [/^search_timeline$|^search_by_raw_query$/, 'search'],
  [/^profile_user_originals_timeline$/, 'profile'],
  [/^threaded_conversation/, 'post'],
  [/^global_trending/, 'trending'],
];
/** Wrapper keys that say nothing about the feed. */
const NEUTRAL_KEYS: ReadonlySet<string> = new Set(['data', 'result', 'timeline']);

/** Pages whose server-rendered results may hold a feed: home, search, a profile, a post. */
const FEED_PAGES: readonly RegExp[] = [/^\/home$/, /^\/search$/, /^\/[A-Za-z0-9_]{1,15}$/, /^\/[A-Za-z0-9_]{1,15}\/status\/\d{1,20}$/];
/** First path segments of x.com that are not profiles. */
const NOT_PROFILES: ReadonlySet<string> = new Set([
  'i', 'home', 'explore', 'search', 'notifications', 'messages', 'settings', 'bookmarks', 'lists', 'communities',
  'compose', 'account', 'login', 'logout', 'signup', 'jobs', 'premium', 'grok', 'spaces', 'tos', 'privacy', 'hashtag',
]);

/** `/i/api/graphql/<id>/<Operation>` (x.com) or `/graphql/<id>/<Operation>` (api.x.com). */
const GRAPHQL_PATH = /^\/(?:i\/api\/)?graphql\/[A-Za-z0-9_-]+\/([A-Za-z0-9_]{1,80})$/;
/** Real timelines sit 3 to 6 levels down; a deeper body is hostile or not a feed. */
const MAX_WALK_DEPTH = 24;
const MAX_WALK_NODES = 200_000;

/** What the network layer reports about a response, before its body is read. */
export interface CapturedResponse {
  url: string;
  /** CDP resource type: 'Document', 'XHR', 'Fetch'... */
  type?: string;
  status: number;
  mimeType: string;
}

export type CaptureTarget =
  | { kind: 'json'; operation: string; source: FeedSource }
  | { kind: 'page' }
  | { kind: 'personal'; operation: string }
  | { kind: 'unrecognised'; operation: string }
  | { kind: 'unsupported'; operation: string };

export type ReadableTarget = Extract<CaptureTarget, { kind: 'json' } | { kind: 'page' }>;

export interface CaptureBatch {
  operation: string;
  source: FeedSource;
  items: TimelineItem[];
  /** Post entries that no longer parse (schema drift). */
  unreadable: number;
  /** Entries that are not posts (suggested accounts, trends...). */
  otherEntries: number;
  /** Instructions or entries missing what they should carry (schema drift). */
  malformed: number;
}

export interface CaptureReading {
  batches: CaptureBatch[];
  /** Server-rendered timelines left out because they are personal. */
  personal: string[];
  /** Server-rendered timelines left out because the app does not know them. */
  unrecognised: string[];
  /** Why part or all of the body could not be read. */
  error?: string;
}

/** The GraphQL operation of an https X url, or undefined. */
export function graphqlOperation(raw: string): string | undefined {
  if (!isXUrl(raw)) return undefined;
  return GRAPHQL_PATH.exec(new URL(raw).pathname)?.[1];
}

function isFeedPage(pathname: string): boolean {
  const path = pathname.replace(/\/$/, '');
  const first = path.split('/')[1]?.toLowerCase() ?? '';
  return FEED_PAGES.some((page) => page.test(path)) && (first === 'home' || first === 'search' || !NOT_PROFILES.has(first));
}

/** Whether, and how, a response of the X view is read. Undefined: not a feed, nothing to report. */
export function captureTarget(response: CapturedResponse): CaptureTarget | undefined {
  if (response.status !== 200) return undefined;
  const operation = graphqlOperation(response.url);
  if (operation !== undefined) {
    const source = CAPTURED_OPERATIONS.get(operation);
    if (source) return response.mimeType === 'application/json' ? { kind: 'json', operation, source } : { kind: 'unsupported', operation };
    if (PERSONAL.test(operation)) return { kind: 'personal', operation };
    return FEED_LIKE.test(operation) ? { kind: 'unrecognised', operation } : undefined;
  }
  if (response.type === 'Document' && response.mimeType === 'text/html' && isXUrl(response.url) && isFeedPage(new URL(response.url).pathname)) {
    return { kind: 'page' };
  }
  return undefined;
}

/** The feed a server-rendered timeline belongs to, from the keys leading to it; undefined source: not read. */
export function classifyTimelinePath(path: readonly string[]): { source: FeedSource | undefined; label: string; personal: boolean } {
  const keys = path.filter((key) => !NEUTRAL_KEYS.has(key));
  const label = keys.join('.');
  if (keys.some((key) => PERSONAL.test(key))) return { source: undefined, label, personal: true };
  for (const key of [...keys].reverse()) {
    const match = KEY_SOURCES.find(([pattern]) => pattern.test(key));
    if (match) return { source: match[1], label: key, personal: false };
  }
  return { source: undefined, label, personal: false };
}

/** The posts of a response body that captureTarget said to read. */
export function readCapture(target: ReadableTarget, body: string): CaptureReading {
  if (target.kind === 'page') return readPage(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { batches: [], personal: [], unrecognised: [], error: `${target.operation}: response is not JSON` };
  }
  const { timelines, tooDeep } = findTimelines(parsed);
  const batches = timelines.map(({ timeline }) => ({ operation: target.operation, source: target.source, ...batchOf(timeline) }));
  const reading = { batches, personal: [], unrecognised: [] };
  if (tooDeep) return { ...reading, error: `${target.operation}: response nested too deep; part of it was not read` };
  if (timelines.length === 0) return { ...reading, error: `${target.operation}: no timeline in the response (X may have changed its format)` };
  return reading;
}

function batchOf(timeline: Record<string, unknown>): Omit<CaptureBatch, 'operation' | 'source'> {
  const { items, unreadable, otherEntries, malformed } = parseTimelineItems(timeline);
  return { items, unreadable, otherEntries, malformed };
}

/** The results x.com server-rendered into a page; only the feeds it knows are read. */
function readPage(html: string): CaptureReading {
  let results: ReturnType<typeof extractSsrResults>;
  try {
    results = extractSsrResults(html);
  } catch (error) {
    return { batches: [], personal: [], unrecognised: [], error: `x.com page: ${error instanceof Error ? error.message : String(error)}` };
  }
  const reading: CaptureReading = { batches: [], personal: [], unrecognised: [] };
  let tooDeep = false;
  for (const result of results) {
    const known = operationOfRelayId(result.relayId);
    const found = findTimelines(result.response);
    tooDeep ||= found.tooDeep;
    for (const { timeline, path } of found.timelines) {
      const verdict = known !== undefined ? verdictOfOperation(known) : classifyTimelinePath(path);
      const operation = known ?? `page:${verdict.label}`;
      if (verdict.source !== undefined) reading.batches.push({ operation, source: verdict.source, ...batchOf(timeline) });
      else if (verdict.personal) reading.personal.push(operation);
      else reading.unrecognised.push(operation);
    }
  }
  return tooDeep ? { ...reading, error: 'x.com page: a response nested too deep was not fully read' } : reading;
}

function verdictOfOperation(operation: string): { source: FeedSource | undefined; label: string; personal: boolean } {
  return { source: CAPTURED_OPERATIONS.get(operation), label: operation, personal: PERSONAL.test(operation) };
}

let relayIdNames: ReadonlyMap<string, string> | null = null;

/** The operation of a relay id in the bundled snapshot (ids rotate: an unknown one stays unknown). */
function operationOfRelayId(relayId: string): string | undefined {
  relayIdNames ??= new Map(Object.entries(OPERATIONS).map(([name, info]) => [info.relayId, name]));
  return relayIdNames.get(relayId);
}

interface FoundTimeline {
  timeline: Record<string, unknown>;
  /** The object keys leading to it (array indices left out). */
  path: readonly string[];
}

/**
 * Every object carrying an `instructions` array, without descending into
 * them or into posts. Bounded in depth and size: a hostile body cannot pin
 * the main process.
 */
function findTimelines(root: unknown): { timelines: FoundTimeline[]; tooDeep: boolean } {
  const timelines: FoundTimeline[] = [];
  const stack: Array<{ node: unknown; depth: number; path: readonly string[] }> = [{ node: root, depth: 0, path: [] }];
  let visited = 0;
  let tooDeep = false;
  while (stack.length > 0) {
    const { node, depth, path } = stack.pop() as (typeof stack)[number];
    if (!node || typeof node !== 'object') continue;
    if (depth > MAX_WALK_DEPTH || ++visited > MAX_WALK_NODES) {
      tooDeep = true;
      continue;
    }
    const record = asRecord(node);
    if (record && Array.isArray(record.instructions)) {
      timelines.push({ timeline: record, path });
      continue;
    }
    if (record?.__typename === 'Tweet') continue;
    if (Array.isArray(node)) for (const child of node) stack.push({ node: child, depth: depth + 1, path });
    else for (const [key, child] of Object.entries(node)) stack.push({ node: child, depth: depth + 1, path: [...path, key] });
  }
  return { timelines: timelines.reverse(), tooDeep };
}
