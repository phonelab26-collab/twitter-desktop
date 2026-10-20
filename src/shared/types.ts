/**
 * Shared domain types between the Electron main process and the renderer.
 * These mirror the subset of the X GraphQL schema that the client actually uses.
 */

export interface UserRef {
  id: string;
  screenName: string;
  /** Undefined when the payload carried no display name (show the handle). */
  name?: string;
  /** Undefined when the payload carried no avatar (or one not served by X's CDN). */
  avatarUrl?: string;
  /** Undefined when the payload states nothing about it: unknown, not "not verified". */
  verified?: boolean;
  description?: string;
  /** Counts are undefined when the payload did not carry them, never 0. */
  followersCount?: number;
  friendsCount?: number;
  followersCountFormatted?: string;
  friendsCountFormatted?: string;
  statusCount?: number;
  isBlueVerified?: boolean;
  protected?: boolean;
}

export interface MediaRef {
  type: 'photo' | 'video' | 'gif';
  /** The image for a photo, the best mp4 for a video/gif; undefined when no mp4 was offered. */
  url?: string;
  thumbnailUrl: string;
  width?: number;
  height?: number;
  durationMs?: number;
  altText?: string;
}

export interface TweetAuthor {
  id: string;
  screenName: string;
  /** Undefined when the payload carried no display name (show the handle). */
  name?: string;
  /** Undefined when the payload carried no avatar (or one not served by X's CDN). */
  avatarUrl?: string;
  /** Undefined when the payload states nothing about it. */
  verified?: boolean;
}

export interface Tweet {
  id: string;
  /** Undefined when the payload carried no text field; '' is a real empty text. */
  text?: string;
  /** ISO 8601; undefined when the payload carried no readable timestamp. */
  createdAt?: string;
  author: TweetAuthor;
  /** Every count is undefined when the payload did not carry it, never 0. */
  replyCount?: number;
  retweetCount?: number;
  likeCount?: number;
  quoteCount?: number;
  bookmarkCount?: number;
  /** Undefined when the payload did not carry it (often the case for guests). */
  viewCount?: number;
  /** True when the payload marks a repost; undefined when it says nothing (not "false"). */
  isRetweet?: boolean;
  /** True when the payload marks a reply; undefined when it says nothing. */
  isReply?: boolean;
  isQuote: boolean;
  /** Undefined when the payload carries no edit information. */
  isEdited?: boolean;
  lang?: string;
  media: MediaRef[];
  /** Media items of the post that could not be shown (unknown type, URL off X's CDN). */
  unparsedMediaCount?: number;
  /** Undefined when the quoted tweet is unavailable, even if isQuote is true. */
  quotedTweet?: Tweet;
  inReplyToScreenName?: string;
  /** Real guest captures carry no conversation_id_str: usually undefined. */
  conversationId?: string;
  /** True for the post a profile pins above its timeline. */
  pinned?: boolean;
}

export interface CursorPage<T> {
  items: T[];
  cursor: string | null;
}

export interface UserProfile extends UserRef {
  location?: string;
  url?: string;
  joinedAt?: string;
  protected?: boolean;
  mediaCount?: number;
}

/** One trend of the legacy REST `1.1/trends/place.json` (the only guest source of trend names). */
export interface Trend {
  name: string;
  /** X's own search link for the trend (searching needs an account). */
  url: string;
  /** `tweet_volume`; undefined when X does not report it (always, in the captures). */
  postCount?: number;
  promoted: boolean;
}

export interface TrendList {
  /** ISO 8601 time X computed the list (`as_of`). */
  asOf: string;
  location: { name: string; woeid: number };
  trends: Trend[];
}

/** A place trends are available for (`1.1/trends/available.json`). */
export interface TrendLocation {
  woeid: number;
  name: string;
  /** 'Supername' (Worldwide), 'Country', 'Town' or 'Unknown', as X reports it. */
  kind: string;
  country?: string;
  countryCode?: string;
  parentWoeid?: number;
}

export interface SearchResult {
  tweets: Tweet[];
  users: UserRef[];
  cursor: string | null;
  query: string;
}

export interface ApiError {
  message: string;
  status: number;
  code?: string;
  retriable: boolean;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

export interface RateLimitState {
  limit: number;
  remaining: number;
  resetAt: number;
}

export interface SessionState {
  authenticated: boolean;
  screenName?: string;
  userId?: string;
}
