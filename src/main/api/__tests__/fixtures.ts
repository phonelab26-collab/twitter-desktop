/**
 * Real guest responses captured with a local probe script (2026-10-19; the
 * research scripts are not published, see docs/HANDOFF.md §13).
 * Each file is the raw body of a 200; the request variables that produced it
 * are listed in docs/HANDOFF.md §4.1. Loaded with JSON.parse rather than a
 * JSON import so tsc does not infer a type for 66 KB payloads.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, any>;

const FIXTURES_DIR = join(__dirname, '..', '__fixtures__');

/** The `data` member of a saved response; throws if the file has none. */
export function realData(name: string): Json {
  const body = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.real.json`), 'utf8')) as Json;
  if (!body.data || typeof body.data !== 'object') {
    throw new Error(`Fixture ${name}.real.json has no data member`);
  }
  return body.data as Json;
}

/** A saved body exactly as received (REST responses are top-level arrays). */
export function realBody(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.real.json`), 'utf8')) as unknown;
}

/** A saved x.com page, as served to a logged-out visitor. */
export function realPage(name: string): string {
  return readFileSync(join(FIXTURES_DIR, `${name}.real.html`), 'utf8');
}

/** The timeline object under `data.<root>.timeline`. */
export function realTimeline(name: string, root: string): Json {
  const timeline = realData(name)[root]?.timeline;
  if (!timeline) throw new Error(`Fixture ${name}.real.json has no ${root}.timeline`);
  return timeline as Json;
}

/** A timeline entry by its real `entry_id`. */
export function realEntry(timeline: Json, entryId: string): Json {
  const entry = (timeline.instructions as Json[])
    .flatMap((instruction) => (instruction.entries ?? []) as Json[])
    .find((candidate) => candidate.entry_id === entryId);
  if (!entry) throw new Error(`No entry ${entryId} in fixture timeline`);
  return entry;
}

/** The raw tweet result of a real `tweet-<id>` entry. */
export function realTweetNode(timeline: Json, tweetId: string): Json {
  return realEntry(timeline, `tweet-${tweetId}`).content.content.tweet_results.result as Json;
}

export const SEARCH_FIXTURE = 'GlobalTrendingSearchTimelineLoggedOut';
export const SEARCH_ROOT = 'global_trending_search_timeline_logged_out';
export const TRENDING_FIXTURE = 'GlobalTrendingTimelineLoggedOut';
export const TRENDING_ROOT = 'global_trending_timeline_logged_out';
