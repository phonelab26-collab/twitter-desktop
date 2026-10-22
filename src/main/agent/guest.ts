/**
 * The guest (logged-out) X data an agent may ask for, behind the agent's own
 * caches and budgets. The app UI keeps its own (ipc.ts); both draw on the
 * same guest token and IP, so the agent only gets a share: for trends, UI 10
 * + agent 4 calls per 15 minutes stays under X's limit of 15.
 */
import { ApiError, ERROR_CODES } from '../api/client';
import { normaliseScreenName, type XService } from '../api/service';
import { Semaphore, WindowBudget } from '../budget';
import { TtlCache } from '../cache';
import type { CursorPage, TrendList, TrendLocation, Tweet, UserProfile } from '../../shared/types';

export type GuestApi = Pick<
  XService,
  'getProfile' | 'getUserTweets' | 'getTweet' | 'getTrendingPosts' | 'searchTopic' | 'getTrends' | 'getTrendLocations'
>;

/** An answer and when X gave it; `cached`: it was not fetched for this call. */
export interface Fetched<T> {
  value: T;
  fetchedAt: number;
  cached: boolean;
}

type Stamped<T> = Omit<Fetched<T>, 'cached'>;

export const AGENT_TRENDS_BUDGET = { max: 4, windowMs: 15 * 60_000 };
/** Profiles, posts and topics: X allows a few hundred per 15 minutes per guest token. */
export const AGENT_CALLS_BUDGET = { max: 60, windowMs: 15 * 60_000 };
const POSTS_TTL_MS = 60_000;
const PROFILE_TTL_MS = 5 * 60_000;
const TRENDS_TTL_MS = 5 * 60_000;
const LOCATIONS_TTL_MS = 60 * 60_000;
const MAX_IN_FLIGHT = 2;

function invalid(message: string): ApiError {
  return new ApiError(0, message, ERROR_CODES.INVALID_INPUT, { retriable: false });
}

export class GuestGateway {
  private readonly calls: WindowBudget;
  private readonly trendCalls: WindowBudget;
  private readonly slots = new Semaphore(MAX_IN_FLIGHT);
  private readonly posts: TtlCache<string, Stamped<CursorPage<Tweet>>>;
  private readonly tweets: TtlCache<string, Stamped<Tweet | undefined>>;
  private readonly profiles: TtlCache<string, Stamped<UserProfile | undefined>>;
  private readonly trendLists: TtlCache<number, Stamped<TrendList>>;
  private readonly locations: TtlCache<'all', Stamped<TrendLocation[]>>;

  constructor(
    private readonly service: GuestApi,
    private readonly now: () => number = Date.now,
  ) {
    this.calls = new WindowBudget(AGENT_CALLS_BUDGET.max, AGENT_CALLS_BUDGET.windowMs, now);
    this.trendCalls = new WindowBudget(AGENT_TRENDS_BUDGET.max, AGENT_TRENDS_BUDGET.windowMs, now);
    this.posts = new TtlCache(POSTS_TTL_MS, now);
    this.tweets = new TtlCache(POSTS_TTL_MS, now);
    this.profiles = new TtlCache(PROFILE_TTL_MS, now);
    this.trendLists = new TtlCache(TRENDS_TTL_MS, now);
    this.locations = new TtlCache(LOCATIONS_TTL_MS, now);
  }

  userPosts(handle: string): Promise<Fetched<CursorPage<Tweet>>> {
    const screenName = normaliseScreenName(handle);
    return this.fetch(this.posts, `user:${screenName.toLowerCase()}`, this.calls, () => this.service.getUserTweets(screenName));
  }

  topicPosts(topic: string): Promise<Fetched<CursorPage<Tweet>>> {
    const key = topic.trim().replace(/^#/, '').trim().toLowerCase();
    return this.fetch(this.posts, `topic:${key}`, this.calls, () => this.service.searchTopic(topic));
  }

  trendingPosts(): Promise<Fetched<CursorPage<Tweet>>> {
    return this.fetch(this.posts, 'trending', this.calls, () => this.service.getTrendingPosts());
  }

  post(id: string): Promise<Fetched<Tweet | undefined>> {
    return this.fetch(this.tweets, id.trim(), this.calls, () => this.service.getTweet(id));
  }

  profile(handle: string): Promise<Fetched<UserProfile | undefined>> {
    const screenName = normaliseScreenName(handle);
    return this.fetch(this.profiles, screenName.toLowerCase(), this.calls, () => this.service.getProfile(screenName));
  }

  /** Only places X lists: an arbitrary number would cost a call against a 15 per 15 min quota. */
  async trends(woeid: number): Promise<Fetched<TrendList>> {
    if (!Number.isSafeInteger(woeid) || woeid <= 0) throw invalid(`"${woeid}" is not a WOEID.`);
    const places = await this.fetch(this.locations, 'all', this.calls, () => this.service.getTrendLocations());
    if (!places.value.some((place) => place.woeid === woeid)) throw invalid(`X lists no trends for WOEID ${woeid}.`);
    return this.fetch(this.trendLists, woeid, this.trendCalls, () => this.service.getTrends(woeid));
  }

  /** Cached answer, or one call that counts against `budget` (a failure is never cached). */
  private async fetch<K, V>(cache: TtlCache<K, Stamped<V>>, key: K, budget: WindowBudget, load: () => Promise<V>): Promise<Fetched<V>> {
    const asked = this.now();
    const stamped = await cache.get(key, async () => {
      const slot = budget.tryTake();
      if (!slot.ok) {
        const minutes = Math.ceil(slot.retryInMs / 60_000);
        throw new ApiError(429, `The agent's share of X requests is used up; try again in ${minutes} min.`, ERROR_CODES.RATE_LIMITED, {
          retriable: true,
        });
      }
      const value = await this.slots.run(load);
      return { value, fetchedAt: this.now() };
    });
    return { ...stamped, cached: stamped.fetchedAt < asked };
  }
}
