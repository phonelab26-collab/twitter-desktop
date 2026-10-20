/**
 * Live discovery of Relay operation ids from the logged-out web client.
 *
 * X ships the Relay query ids inside the `x-web` JS bundles. Every redeploy
 * produces a new set of ids, which is why the bundled snapshot in
 * `operations.ts` can go stale.
 *
 * The crawler starts at the `x.com` entry bundle and follows every
 * `assets/*.js` reference it finds. Lazy chunks that no bundle references
 * (HANDOFF §5.2, §8) are out of its reach.
 */
import { fetchPinned, MAX_BUNDLE_BYTES, MAX_PAGE_BYTES, readTextCapped } from './body';
import { BUNDLE_BASE_URL, USER_AGENT, WEB_ORIGIN } from './constants';
import { OPERATIONS, type OperationInfo } from './operations';

export interface DiscoveredOperation {
  relayId: string;
  kind: 'query' | 'mutation';
}

export interface CrawlResult {
  operations: Readonly<Record<string, DiscoveredOperation>>;
  /** Bundles that could not be downloaded; the crawl is partial when > 0. */
  failedBundles: number;
  /** Descriptors skipped because their relay id was malformed. */
  rejectedDescriptors: number;
  /** False when bundles failed or the file/time/byte budget stopped the crawl. */
  complete: boolean;
}

export interface CrawlOptions {
  /** Maximum number of bundles to download. */
  maxFiles?: number;
  /** Maximum number of parallel downloads. */
  concurrency?: number;
  /** Overall deadline in milliseconds. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * A persisted-query descriptor as the minifier emits it, e.g.
 * params:{id:`KbQx…`,metadata:{},name:`genericTimelineQuery`,operationKind:`query`
 * Kept strict on purpose: a looser pattern pairs ids with response field
 * names that happen to sit nearby (`success`, `accept_follow_request`, …).
 */
const OPERATION_DESCRIPTOR =
  /params:\{id:`([^`]+)`,metadata:\{\},name:`([A-Za-z0-9_]+)`,operationKind:`(query|mutation)`/g;

// Bounded repetitions: an unbounded run before a literal backtracks quadratically on
// hostile input ("assets/" x 160 KB took 3.5 s on the main thread). Real refs are < 50 chars.
const ASSET_REF = /assets\/[A-Za-z0-9_.\/-]{1,200}\.js/g;
const ENTRY_BUNDLE = /https:\/\/abs\.twimg\.com\/x-web\/x-web\/[^"'\s]{0,200}?entry-client[^"'\s]{0,200}?\.js/;

const DEFAULT_MAX_FILES = 600;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 60_000;
/** One hung download must not stall its whole wave. */
const BUNDLE_TIMEOUT_MS = 15_000;
/** Total bytes one crawl may download. */
const MAX_CRAWL_BYTES = 150 * 1024 * 1024;
/** The only hosts a crawl request (or a redirect) may reach. */
const CRAWL_HOSTS: ReadonlySet<string> = new Set(['x.com', 'abs.twimg.com']);

/** Relay ids are 22 url-safe base64 characters; anything else would be put in a URL path. */
const RELAY_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * Every well-formed descriptor of a bundle. A malformed relay id is never
 * used (it would land in a URL path) and is counted, not fatal: one odd
 * descriptor must not void the whole crawl.
 */
export function extractOperations(text: string): { operations: Map<string, DiscoveredOperation>; rejected: number } {
  const operations = new Map<string, DiscoveredOperation>();
  let rejected = 0;
  for (const [, relayId, name, kind] of text.matchAll(OPERATION_DESCRIPTOR)) {
    if (!RELAY_ID_PATTERN.test(relayId)) {
      rejected += 1;
      continue;
    }
    if (!operations.has(name)) operations.set(name, { relayId, kind: kind as DiscoveredOperation['kind'] });
  }
  return { operations, rejected };
}

/** Chunk references; a ".." segment would leave the bundle directory, so it is dropped. */
export function extractAssetRefs(text: string): string[] {
  return [...new Set(text.match(ASSET_REF) ?? [])].filter((ref) => !ref.split('/').includes('..'));
}

export function findEntryBundleUrl(html: string): string {
  const match = html.match(ENTRY_BUNDLE);
  if (!match) throw new Error('Could not locate the web client entry bundle in the x.com page.');
  return match[0];
}

async function fetchText(fetchImpl: typeof fetch, url: string, accept: string, maxBytes: number): Promise<string> {
  const response = await fetchPinned(
    fetchImpl,
    url,
    { headers: { 'user-agent': USER_AGENT, accept }, signal: AbortSignal.timeout(BUNDLE_TIMEOUT_MS) },
    CRAWL_HOSTS,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
  }
  return readTextCapped(response, maxBytes);
}

/**
 * Crawls the web client bundles breadth-first, one wave of `concurrency`
 * downloads at a time, and returns every operation it can find.
 */
export async function crawlOperations(options: CrawlOptions = {}): Promise<CrawlResult> {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const entry = findEntryBundleUrl(await fetchText(fetchImpl, WEB_ORIGIN, 'text/html', MAX_PAGE_BYTES));
  const queued = new Set<string>([entry]);
  const pending: string[] = [entry];
  const operations = new Map<string, DiscoveredOperation>();
  let fetched = 0;
  let failedBundles = 0;
  let rejectedDescriptors = 0;
  let bytes = 0;

  while (pending.length > 0 && fetched < maxFiles && Date.now() < deadline && bytes < MAX_CRAWL_BYTES) {
    const wave = pending.splice(0, Math.min(concurrency, maxFiles - fetched));
    fetched += wave.length;
    const results = await Promise.allSettled(wave.map((url) => fetchText(fetchImpl, url, '*/*', MAX_BUNDLE_BYTES)));

    for (const result of results) {
      if (result.status === 'rejected') {
        failedBundles += 1;
        continue;
      }
      bytes += result.value.length;
      const extracted = extractOperations(result.value);
      rejectedDescriptors += extracted.rejected;
      for (const [name, op] of extracted.operations) {
        if (!operations.has(name)) operations.set(name, op);
      }
      for (const ref of extractAssetRefs(result.value)) {
        const url = BUNDLE_BASE_URL + ref;
        if (!queued.has(url)) {
          queued.add(url);
          pending.push(url);
        }
      }
    }
  }

  if (operations.size === 0) {
    throw new Error(
      `Crawl found no operation (${fetched} bundles fetched, ${failedBundles} failed). ` +
        'The bundle format or the entry page probably changed.',
    );
  }
  return {
    operations: Object.fromEntries(operations),
    failedBundles,
    rejectedDescriptors,
    complete: failedBundles === 0 && pending.length === 0,
  };
}

/**
 * Returns a registry that merges the bundled snapshot with the live crawl.
 * Live ids win: they are the ids the current deployment actually serves.
 */
export async function fetchOperationRegistry(
  options: CrawlOptions = {},
): Promise<Readonly<Record<string, OperationInfo>>> {
  const crawl = await crawlOperations(options);
  // A partial crawl may simply have missed the bundle that holds an operation:
  // reporting that operation as "not present" would be false. Fail instead (not cached).
  if (!crawl.complete) {
    throw new Error(
      `Partial crawl (${crawl.failedBundles} bundle(s) failed or the crawl budget ran out); try again later.`,
    );
  }
  const { operations } = crawl;
  // No prototype: a bundle naming an operation "__proto__" must not replace the registry's prototype.
  const merged: Record<string, OperationInfo> = Object.assign(Object.create(null) as Record<string, OperationInfo>, OPERATIONS);

  for (const [name, live] of Object.entries(operations)) {
    const known = OPERATIONS[name];
    merged[name] = {
      relayId: live.relayId,
      kind: live.kind,
      args: known?.args ?? [],
      guest: known?.guest ?? false,
    };
  }
  return merged;
}
