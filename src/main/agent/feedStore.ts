/**
 * The posts the agent link captured from x.com, in memory only (nothing is
 * written to disk; quitting the app or turning the link off empties it).
 *
 * Every new post gets a sequence number, in capture order. An agent polls
 * with `afterSeq` and resumes from `nextSeq`: unlike post ids, this never
 * skips a post that arrives late ("For you" and scrolling deliver older
 * posts after newer ones). The epoch changes when the buffer is emptied, so
 * an old cursor is reported as reset instead of silently matching new posts.
 */
import { randomUUID } from 'node:crypto';
import type { TimelineItem } from '../api/parsers';
import type { FeedSource } from './capture';
import { isKnownPublic, mergePost, toAgentPost, type AgentPost } from './post';

export interface FeedBatch {
  items: readonly TimelineItem[];
  source: FeedSource;
  operation: string;
}

interface Entry {
  readonly seq: number;
  readonly post: AgentPost;
  readonly sources: readonly FeedSource[];
  readonly firstSeenAt: number;
  readonly snapshotAt: number;
}

export interface StoredPost extends AgentPost {
  seq: number;
  sources: FeedSource[];
  /** When the app first saw the post; `updatedAt`: its latest snapshot. */
  capturedAt: string;
  updatedAt: string;
}

export interface FeedQuery {
  afterSeq?: number;
  /** The epoch `afterSeq` belongs to; another epoch means the buffer was emptied since. */
  epoch?: string;
  limit: number;
  sources?: readonly FeedSource[];
  /** Normalised, e.g. "$TSLA". */
  cashtag?: string;
  contains?: string;
  author?: string;
  includePromoted?: boolean;
  includeProtected?: boolean;
}

export interface FeedPage {
  epoch: string;
  posts: StoredPost[];
  /** The `afterSeq` of the next poll. */
  nextSeq: number;
  /** Posts were dropped (buffer full or emptied) before this poller saw them. */
  gap: boolean;
  /** The given epoch is over: the cursor was restarted from the beginning. */
  reset: boolean;
}

export interface StatsOptions {
  windowMs: number;
  top: number;
  now: number;
  includePromoted?: boolean;
  includeProtected?: boolean;
}

const DEFAULT_CAPACITY = 2000;

const iso = (ms: number) => new Date(ms).toISOString();

export class FeedStore {
  private entries = new Map<string, Entry>();
  private lastSeq = 0;
  private evictedThrough = 0;
  private currentEpoch: string;

  constructor(
    private readonly capacity = DEFAULT_CAPACITY,
    private readonly newEpoch: () => string = () => randomUUID().slice(0, 8),
  ) {
    this.currentEpoch = newEpoch();
  }

  get epoch(): string {
    return this.currentEpoch;
  }

  get size(): number {
    return this.entries.size;
  }

  /** The sequence number of the latest new post (0: none yet in this epoch). */
  get latestSeq(): number {
    return this.lastSeq;
  }

  /** `snapshotAt`: when X answered; a late, older answer never overrides a newer one. */
  add(batch: FeedBatch, snapshotAt: number): { added: number; updated: number } {
    let added = 0;
    let updated = 0;
    for (const item of batch.items) {
      const post = toAgentPost(item.tweet, item);
      const existing = this.entries.get(post.id);
      if (!existing) {
        this.lastSeq += 1;
        this.entries.set(post.id, { seq: this.lastSeq, post, sources: [batch.source], firstSeenAt: snapshotAt, snapshotAt });
        added += 1;
        continue;
      }
      const newer = snapshotAt >= existing.snapshotAt;
      this.entries.set(post.id, {
        ...existing,
        post: newer ? mergePost(existing.post, post) : mergePost(post, existing.post),
        sources: existing.sources.includes(batch.source) ? existing.sources : [...existing.sources, batch.source],
        snapshotAt: Math.max(snapshotAt, existing.snapshotAt),
      });
      updated += 1;
    }
    this.evict();
    return { added, updated };
  }

  /** Empties the buffer and starts a new epoch (sign-out, account change, link off). */
  clear(): void {
    this.entries = new Map();
    this.lastSeq = 0;
    this.evictedThrough = 0;
    this.currentEpoch = this.newEpoch();
  }

  query(query: FeedQuery): FeedPage {
    // A cursor from another epoch, or past the latest post (the buffer was emptied and the
    // poller did not send its epoch): restart from the beginning and say so.
    const reset =
      (query.epoch !== undefined && query.epoch !== this.currentEpoch) || (query.afterSeq !== undefined && query.afterSeq > this.lastSeq);
    const after = reset ? 0 : query.afterSeq;
    const matching = [...this.entries.values()].filter((entry) => matches(entry, query));
    if (after === undefined) {
      const latest = matching.slice(-query.limit).reverse();
      return { epoch: this.currentEpoch, posts: latest.map(stored), nextSeq: this.lastSeq, gap: false, reset };
    }
    const newer = matching.filter((entry) => entry.seq > after);
    const page = newer.slice(0, query.limit);
    const truncated = newer.length > page.length;
    return {
      epoch: this.currentEpoch,
      posts: page.map(stored),
      nextSeq: truncated ? page[page.length - 1].seq : Math.max(after, this.lastSeq),
      gap: reset || after < this.evictedThrough,
      reset,
    };
  }

  /** Cashtag mentions in the posts written within the window, and what was left out. */
  cashtagStats(options: StatsOptions) {
    const from = options.now - options.windowMs;
    const coverage = { postsInWindow: 0, withoutDate: 0, futureDated: 0, promotedLeftOut: 0, notKnownPublicLeftOut: 0, bufferSize: this.entries.size };
    const tally = new Map<string, Tally>();
    for (const { post } of this.entries.values()) {
      const created = post.createdAt === undefined ? NaN : Date.parse(post.createdAt);
      if (!Number.isFinite(created)) {
        coverage.withoutDate += 1;
        continue;
      }
      if (created > options.now) {
        coverage.futureDated += 1;
        continue;
      }
      if (created < from) continue;
      if (post.promoted === true && !options.includePromoted) {
        coverage.promotedLeftOut += 1;
        continue;
      }
      if (!isKnownPublic(post) && !options.includeProtected) {
        coverage.notKnownPublicLeftOut += 1;
        continue;
      }
      coverage.postsInWindow += 1;
      for (const cashtag of post.cashtags) tally.set(cashtag, addToTally(tally.get(cashtag), post, created));
    }
    const cashtags = [...tally.entries()]
      .map(([cashtag, entry]) => summarise(cashtag, entry))
      .sort((a, b) => b.posts - a.posts || b.authors - a.authors)
      .slice(0, options.top);
    return { from: iso(from), to: iso(options.now), cashtags, coverage };
  }

  /** The oldest captures go first once the buffer is full. */
  private evict(): void {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.capacity) break;
      this.entries.delete(id);
      this.evictedThrough = entry.seq;
    }
  }
}

function stored(entry: Entry): StoredPost {
  return { ...entry.post, seq: entry.seq, sources: [...entry.sources], capturedAt: iso(entry.firstSeenAt), updatedAt: iso(entry.snapshotAt) };
}

function matches(entry: Entry, query: FeedQuery): boolean {
  const { post } = entry;
  if (post.promoted === true && !query.includePromoted) return false;
  // Fails closed: a post is served only when X said its author (and any quoted one) is public.
  if (!isKnownPublic(post) && !query.includeProtected) return false;
  if (query.sources && query.sources.length > 0 && !entry.sources.some((source) => query.sources?.includes(source))) return false;
  if (query.cashtag && !post.cashtags.includes(query.cashtag) && !post.quoted?.cashtags.includes(query.cashtag)) return false;
  if (query.author && post.author.handle.toLowerCase() !== query.author.toLowerCase()) return false;
  if (query.contains) {
    const needle = query.contains.toLowerCase();
    const texts = [post.text, post.reposted?.text, post.quoted?.text];
    if (!texts.some((text) => text?.toLowerCase().includes(needle))) return false;
  }
  return true;
}

interface Tally {
  posts: number;
  authors: ReadonlySet<string>;
  likes: { sum: number; known: number };
  reposts: { sum: number; known: number };
  views: { sum: number; known: number };
  first: number;
  last: number;
}

/** A sum over the posts whose count is known, with how many that is. */
const addKnown = (total: { sum: number; known: number }, value: number | undefined) =>
  value === undefined ? total : { sum: total.sum + value, known: total.known + 1 };

function addToTally(tally: Tally | undefined, post: AgentPost, created: number): Tally {
  const base: Tally = tally ?? {
    posts: 0,
    authors: new Set(),
    likes: { sum: 0, known: 0 },
    reposts: { sum: 0, known: 0 },
    views: { sum: 0, known: 0 },
    first: created,
    last: created,
  };
  return {
    posts: base.posts + 1,
    authors: new Set([...base.authors, post.author.handle.toLowerCase()]),
    likes: addKnown(base.likes, post.counts.likes),
    reposts: addKnown(base.reposts, post.counts.reposts),
    views: addKnown(base.views, post.counts.views),
    first: Math.min(base.first, created),
    last: Math.max(base.last, created),
  };
}

function summarise(cashtag: string, tally: Tally) {
  return {
    cashtag,
    posts: tally.posts,
    authors: tally.authors.size,
    likes: tally.likes,
    reposts: tally.reposts,
    views: tally.views,
    firstPostAt: iso(tally.first),
    lastPostAt: iso(tally.last),
  };
}
