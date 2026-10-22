/**
 * Parsers translating the raw GraphQL payloads into the flat domain types
 * used by the renderer.
 *
 * The X schema is extremely verbose (`__typename` everywhere, nested
 * `result` wrappers, legacy vs unified entities), so every accessor here is
 * defensive: a missing optional field stays undefined (never a plausible 0
 * or ''), and a node missing what identifies it (id, author) is rejected.
 */
import type {
  MediaRef,
  Tweet,
  TweetAuthor,
  UserProfile,
  UserRef,
} from '../../shared/types';

type Json = Record<string, any>;

export function asRecord(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

export function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

/**
 * Unwraps a tweet result union into the concrete tweet: `tweet_results`,
 * `result` and `TweetWithVisibilityResults.tweet` wrappers are peeled off.
 *
 * Only a `__typename: "Tweet"` node is a tweet. A results wrapper without
 * `result` (what TweetResultByRestId returns for an unknown id, see
 * __fixtures__/TweetResultByRestId.not-found.real.json) still carries a
 * `rest_id`, and must not turn into an empty tweet. Unavailable and tombstone
 * variants are not tweets either.
 */
export function unwrapResult(node: unknown): Json | undefined {
  let record = asRecord(node);
  record = asRecord(record?.tweet_results) ?? record;
  record = asRecord(record?.result) ?? record;
  if (record?.__typename === 'TweetWithVisibilityResults') record = asRecord(record.tweet);
  return record?.__typename === 'Tweet' ? record : undefined;
}

/**
 * Unwraps a user result union (`result`, `user` wrappers) into the user
 * object. Only a `__typename: "User"` node is a user: a wrapper without
 * `result` carries just a relay id and must not become a blank profile.
 */
export function unwrapUser(node: unknown): Json | undefined {
  let record = asRecord(node);
  record = asRecord(record?.result) ?? record;
  record = asRecord(record?.user) ?? record;
  return record?.__typename === 'User' ? record : undefined;
}

/** Tweet results that X reports as gone: skipped, not a schema change. */
export const UNAVAILABLE_TWEET_TYPES: ReadonlySet<string> = new Set([
  'TweetUnavailable',
  'TweetTombstone',
]);

/** The `__typename` of the innermost result of a tweet node, if any. */
export function tweetResultType(node: unknown): string | undefined {
  let record = asRecord(node);
  record = asRecord(record?.tweet_results) ?? record;
  record = asRecord(record?.result) ?? record;
  return typeof record?.__typename === 'string' ? record.__typename : undefined;
}

/** Media served by X's CDNs over https; anything else from the payload is not shown. */
const MEDIA_HOSTS: ReadonlySet<string> = new Set(['pbs.twimg.com', 'video.twimg.com', 'abs.twimg.com']);
/** Quote of a quote of a quote: deeper nesting is not a real post, it is a hostile payload. */
const MAX_QUOTE_DEPTH = 3;

/** The https URL of an X media host, or undefined. */
export function mediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && MEDIA_HOSTS.has(url.hostname) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A yes/no the payload states, or undefined when none of the fields is a
 * boolean: an absent "verified" or "protected" is unknown, not false.
 */
function knownFlag(...values: unknown[]): boolean | undefined {
  const flags = values.filter((value): value is boolean => typeof value === 'boolean');
  return flags.length === 0 ? undefined : flags.some(Boolean);
}

/**
 * What identifies a user: `rest_id` (unified) or `id_str` (legacy), and the
 * handle. `id` is the relay id (base64), not the user id, so it is not used.
 */
function userIdentity(user: Json): { id: string; screenName: string } | undefined {
  const id = firstString(user.rest_id, user.id_str);
  const screenName = firstString(asRecord(user.core)?.screen_name, user.screen_name);
  return id && screenName ? { id, screenName } : undefined;
}

/**
 * The unified schema nests the display fields under `core`:
 *   { core: { name, screen_name }, avatar: { image_url }, verification: { is_blue_verified } }
 * The legacy schema kept them flat on the user object. Undefined when the
 * node is not a user or carries no id and handle.
 */
export function parseAuthor(node: unknown): TweetAuthor | undefined {
  const user = unwrapUser(node);
  const identity = user && userIdentity(user);
  if (!user || !identity) return undefined;
  const core = asRecord(user.core);
  const verification = asRecord(user.verification);
  const avatar = asRecord(user.avatar);
  const legacy = asRecord(user.legacy);

  return {
    ...identity,
    name: firstString(core?.name, user.name),
    avatarUrl: mediaUrl(firstString(avatar?.image_url, user.profile_image_url_https, user.avatar_image_url)),
    verified: knownFlag(verification?.is_blue_verified, user.is_blue_verified, user.verified, legacy?.verified),
    protected: knownFlag(asRecord(user.privacy)?.protected, user.is_protected, legacy?.protected),
  };
}

/**
 * The displayable media of a tweet, and how many items could not be shown
 * (unknown type, or no https URL on X's CDN) so the UI can say so.
 */
export function parseMedia(node: unknown): { media: MediaRef[]; skipped: number } {
  const media: MediaRef[] = [];
  let skipped = 0;
  const core = asRecord(node);
  if (!core) return { media, skipped };

  // The unified schema exposes media as `media_entities2`; the legacy schema
  // used `extended_entities.media` / `media`.
  const entities = [
    ...asArray(core.media_entities2),
    ...asArray(asRecord(core.extended_entities)?.media),
    ...asArray(core.media),
  ];

  const seen = new Set<string>();
  for (const item of entities) {
    const type = item?.type;
    if (type !== 'photo' && type !== 'video' && type !== 'animated_gif') {
      skipped += 1;
      continue;
    }

    const info = asRecord(item.video_info);
    const variants = asArray(info?.variants);
    const mp4 = variants
      .filter((variant) => variant?.content_type === 'video/mp4')
      .sort((a, b) => (b?.bitrate ?? 0) - (a?.bitrate ?? 0))[0];

    const thumbnailUrl = mediaUrl(item.media_url_https ?? item.media_url);
    if (!thumbnailUrl) {
      skipped += 1;
      continue;
    }
    // The legacy and unified lists can repeat one item: a duplicate is not a skipped media.
    if (seen.has(thumbnailUrl)) continue;
    seen.add(thumbnailUrl);

    const originalInfo = asRecord(item.original_info);
    media.push({
      type: type === 'animated_gif' ? 'gif' : type,
      // A video without an mp4 has no playable url: the thumbnail is not one.
      url: type === 'photo' ? thumbnailUrl : mediaUrl(mp4?.url),
      thumbnailUrl,
      width: typeof originalInfo?.width === 'number' ? originalInfo.width : undefined,
      height: typeof originalInfo?.height === 'number' ? originalInfo.height : undefined,
      durationMs:
        typeof info?.duration_millis === 'number' ? info.duration_millis : undefined,
      altText: typeof item.ext_alt_text === 'string' ? item.ext_alt_text : undefined,
    });
  }
  return { media, skipped };
}

/**
 * The unified schema stores the tweet body in `details.full_text`; the legacy
 * schema used `legacy.full_text`. A long post truncates `details.full_text`
 * and carries the whole text in `note_tweet.note_tweet_results.result.text`.
 * Undefined when no text field is present; an empty `full_text` is kept.
 */
function tweetText(core: Json): string | undefined {
  const note = asRecord(asRecord(asRecord(core.note_tweet)?.note_tweet_results)?.result);
  if (typeof note?.text === 'string') return note.text;
  const details = asRecord(core.details);
  if (typeof details?.full_text === 'string') return decodeEntities(details.full_text);
  const legacy = asRecord(core.legacy);
  if (typeof legacy?.full_text === 'string') return decodeEntities(legacy.full_text);
  if (typeof core.full_text === 'string') return decodeEntities(core.full_text);
  return undefined;
}

/**
 * X HTML-escapes `full_text` (real capture: "Michael &amp; Susan Dell") but
 * not `note_tweet` text ("&"). Only the entities X emits are decoded, `&amp;`
 * last so "&amp;lt;" stays "&lt;".
 */
export function decodeEntities(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** ISO 8601 for epoch milliseconds; undefined when out of Date's range. */
function isoFromMs(ms: number): string | undefined {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Always ISO 8601, whichever schema the timestamp came from. Undefined when unknown. */
function tweetTimestamp(core: Json): string | undefined {
  const details = asRecord(core.details);
  const createdAtMs = details?.created_at_ms;
  if (typeof createdAtMs === 'number') return isoFromMs(createdAtMs);
  const raw = asRecord(core.legacy)?.created_at ?? core.created_at;
  return typeof raw === 'string' ? isoFromMs(Date.parse(raw)) : undefined;
}

/**
 * A count the payload did not carry stays unknown rather than becoming 0.
 * Only a non-negative number or a digit string (views.count) is a count:
 * `Number(false)`, `Number([])` and `Number(' ')` would all invent a 0.
 */
function optionalCount(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Real captures carry `edit_control`: `EditControlEdit` for a later version,
 * or a list of version ids longer than one once the post has been edited.
 */
function isEdited(core: Json, legacy: Json | undefined, details: Json | undefined): boolean | undefined {
  const control = asRecord(core.edit_control);
  if (control) {
    const ids = asArray(control.edit_tweet_ids ?? asRecord(control.edit_control_initial)?.edit_tweet_ids);
    return control.__typename === 'EditControlEdit' || ids.length > 1;
  }
  return knownFlag(details?.is_edited, legacy?.edited_tweet === undefined ? undefined : Boolean(legacy.edited_tweet));
}

/** The engagement counts, each undefined when the payload did not carry it. */
function tweetCounts(counts: Json | undefined, legacy: Json | undefined) {
  return {
    replyCount: optionalCount(counts?.reply_count ?? legacy?.reply_count),
    retweetCount: optionalCount(counts?.retweet_count ?? legacy?.retweet_count),
    likeCount: optionalCount(counts?.favorite_count ?? legacy?.favorite_count),
    quoteCount: optionalCount(counts?.quote_count ?? legacy?.quote_count),
    bookmarkCount: optionalCount(counts?.bookmark_count ?? legacy?.bookmark_count),
  };
}

/**
 * The quote part of a tweet. A quote of an unavailable tweet is still a
 * quote, just without its tweet. A quoted result that does not parse for any
 * other reason makes the quoting tweet unreadable (null), so the quote is not
 * silently dropped.
 */
function quoteOf(
  core: Json,
  details: Json | undefined,
  depth: number,
): { isQuote: boolean; quotedTweet?: Tweet } | null {
  // A quoted tweet that itself quotes carries a stub (ids only) in
  // `quoted_tweet_results` and the full tweet in `nested_quoted_tweet_results`
  // (real capture: profile-page.elonmusk.real.html, tweet 2112080134778069414).
  const quoted =
    core.nested_quoted_tweet_results ??
    core.quoted_tweet_results ??
    core.quoted_status_result ??
    core.quoted_status ??
    details?.quoted_status_result;
  if (!quoted) return { isQuote: false };
  if (depth >= MAX_QUOTE_DEPTH) return null;
  const quotedTweet = parseTweet(quoted, depth + 1);
  if (quotedTweet) return { isQuote: true, quotedTweet };
  const type = tweetResultType(quoted);
  return type && UNAVAILABLE_TWEET_TYPES.has(type) ? { isQuote: true } : null;
}

/**
 * Undefined when the node is not a tweet, or lacks its id, its author or a
 * readable quoted tweet: such a tweet is unreadable, not blank.
 */
export function parseTweet(node: unknown, depth = 0): Tweet | undefined {
  const core = unwrapResult(node);
  if (!core) return undefined;
  const legacy = asRecord(core.legacy);
  const details = asRecord(core.details);
  const restId = firstString(core.rest_id, legacy?.id_str);
  const author = parseAuthor(asRecord(core.core)?.user_results ?? core.author);
  const quote = quoteOf(core, details, depth);
  if (!restId || !author || !quote) return undefined;

  // A mention is not a reply: only the in_reply_to fields say so. Without
  // them the reply status is unknown (no real guest capture shows a reply yet).
  const inReplyTo = firstString(legacy?.in_reply_to_screen_name, core.in_reply_to_screen_name);
  const replySignal = legacy?.in_reply_to_status_id_str ?? core.in_reply_to_status_id_str ?? inReplyTo;
  const retweetSignal = legacy?.retweeted_status_result ?? core.retweeted_status_result ?? details?.retweeted_status_result;

  const views = asRecord(core.views);
  const { media, skipped } = parseMedia(core);

  return {
    id: restId,
    text: tweetText(core),
    createdAt: tweetTimestamp(core),
    author,
    ...tweetCounts(asRecord(core.counts), legacy),
    viewCount: optionalCount(views?.count ?? core.view_count ?? legacy?.view_count),
    isRetweet: retweetSignal ? true : undefined,
    isReply: replySignal ? true : undefined,
    isQuote: quote.isQuote,
    isEdited: isEdited(core, legacy, details),
    lang: typeof legacy?.lang === 'string' ? legacy.lang : undefined,
    media,
    unparsedMediaCount: skipped > 0 ? skipped : undefined,
    quotedTweet: quote.quotedTweet,
    retweetedTweet: retweetSignal && depth < MAX_QUOTE_DEPTH ? parseTweet(retweetSignal, depth + 1) : undefined,
    inReplyToScreenName: inReplyTo,
    conversationId: firstString(core.conversation_id_str, legacy?.conversation_id_str),
  };
}

export function parseUser(node: unknown): UserRef | undefined {
  const user = unwrapUser(node);
  // A user without an id and a handle is a schema mismatch, not a profile.
  const identity = user && userIdentity(user);
  if (!user || !identity) return undefined;

  const core = asRecord(user.core);
  const verification = asRecord(user.verification);
  const avatar = asRecord(user.avatar);
  const legacy = asRecord(user.legacy);
  const relationshipCounts = asRecord(user.relationship_counts);
  const userTweetCounts = asRecord(user.tweet_counts);
  const privacy = asRecord(user.privacy);
  const bio = asRecord(user.profile_bio);

  const followers = optionalCount(
    relationshipCounts?.followers ?? user.followers_count ?? legacy?.followers_count,
  );
  const friends = optionalCount(
    relationshipCounts?.following ?? user.friends_count ?? legacy?.friends_count,
  );
  const statuses = optionalCount(
    userTweetCounts?.tweets ?? user.statuses_count ?? legacy?.statuses_count,
  );

  return {
    ...identity,
    name: firstString(core?.name, user.name),
    avatarUrl: mediaUrl(firstString(avatar?.image_url, user.profile_image_url_https, user.avatar_image_url)),
    verified: knownFlag(verification?.is_blue_verified, user.is_blue_verified, user.verified, legacy?.verified),
    isBlueVerified: knownFlag(verification?.is_blue_verified, user.is_blue_verified),
    description: firstString(bio?.description, core?.description, user.description),
    followersCount: followers,
    friendsCount: friends,
    followersCountFormatted: formatCount(followers),
    friendsCountFormatted: formatCount(friends),
    statusCount: statuses,
    protected: knownFlag(privacy?.protected, user.is_protected),
  };
}

/** An http(s) link from the payload, or undefined (never javascript:, file:...). */
function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The first non-empty string, or undefined: an empty field is not a value. */
function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value !== '');
}

/** `core.created_at_ms` (unified schema) or a legacy date string, as ISO 8601. */
function joinedAt(core: Json | undefined, legacy: Json | undefined): string | undefined {
  if (typeof core?.created_at_ms === 'number') return isoFromMs(core.created_at_ms);
  const raw = firstString(core?.created_at, legacy?.created_at);
  return raw === undefined ? undefined : isoFromMs(Date.parse(raw));
}

export function parseProfile(node: unknown): UserProfile | undefined {
  const profile = parseUser(node);
  if (!profile) return undefined;
  const user = unwrapUser(node);
  const core = asRecord(user?.core);
  const legacy = asRecord(user?.legacy);

  // UserByScreenName (real capture) nests the location as `location.location`.
  const location = asRecord(user?.location)?.location ?? core?.location;

  return {
    ...profile,
    location: firstString(location),
    url: webUrl(core?.url),
    joinedAt: joinedAt(core, legacy),
    mediaCount: optionalCount(core?.media_count ?? legacy?.media_count),
  };
}

/**
 * Every entry of a timeline: the `entries` of TimelineAddEntries-style
 * instructions plus the single `entry` of a TimelineReplaceEntry.
 */
/** Instructions that must carry an `entries` array / a single `entry` (real captures). */
const ENTRIES_INSTRUCTIONS: ReadonlySet<string> = new Set(['TimelineAddEntries']);
const ENTRY_INSTRUCTIONS: ReadonlySet<string> = new Set(['TimelineReplaceEntry', 'TimelinePinEntry']);
/** Entry payloads that are legitimately not posts: the guest "Log in" prompt, cursors. */
const KNOWN_NON_TWEET_PAYLOADS: ReadonlySet<string> = new Set(['TimelineMessagePrompt', 'TimelineTimelineCursor']);

/**
 * Every entry of a timeline, plus the number of instructions that should
 * carry entries but do not (a renamed `entries` would otherwise read as an
 * empty timeline).
 */
function timelineEntries(node: unknown): { entries: Array<{ entry: Json; pinned: boolean }>; malformed: number } {
  const instructions = Array.isArray(node) ? asArray(node) : asArray(asRecord(node)?.instructions);
  let malformed = 0;
  const entries = instructions.flatMap((instruction) => {
    const type = String(instruction?.__typename ?? instruction?.type ?? '');
    const single = asRecord(instruction?.entry);
    if (ENTRIES_INSTRUCTIONS.has(type) && !Array.isArray(instruction?.entries)) malformed += 1;
    if (ENTRY_INSTRUCTIONS.has(type) && !single) malformed += 1;
    // A null or non-object entry is a broken payload, not an empty one.
    const listed = asArray(instruction?.entries);
    const records = listed.filter((entry) => asRecord(entry) !== undefined);
    malformed += listed.length - records.length;
    // A profile's pinned post comes as its own TimelinePinEntry instruction (real capture).
    const pinned = type === 'TimelinePinEntry';
    return [...records, ...(single ? [single] : [])].map((entry) => ({ entry, pinned }));
  });
  return { entries, malformed };
}

/**
 * The payload of an entry. Real guest timelines nest it as `content.content`
 * (TimelineTimelineItem → TimelineTweet); `content.item.content` (HANDOFF §6,
 * module items) and `content.itemContent` (older schema) are not observed in
 * a real capture yet.
 */
function itemPayload(content: Json): Json {
  const item = asRecord(content.item);
  return (
    asRecord(content.content) ??
    asRecord(item?.content) ??
    asRecord(item?.itemContent) ??
    asRecord(content.itemContent) ??
    item ??
    content
  );
}

/**
 * The payloads of an entry: one for a plain item, several for a module
 * (`content.items[]`, e.g. a conversation thread on a profile timeline),
 * and how many module items were not objects.
 */
function entryPayloads(entry: Json): { payloads: Json[]; malformed: number } {
  const content = asRecord(entry.content);
  if (!content) return { payloads: [], malformed: 0 };
  const moduleItems = asArray(content.items);
  if (moduleItems.length === 0) return { payloads: [itemPayload(content)], malformed: 0 };
  const records = moduleItems.filter((moduleItem) => asRecord(moduleItem) !== undefined);
  return { payloads: records.map((moduleItem) => itemPayload(moduleItem)), malformed: moduleItems.length - records.length };
}

/** Real URT responses spell it `entry_id`; older captures used `entryId`. */
function entryId(entry: Json): string {
  return String(entry.entry_id ?? entry.entryId ?? '');
}

function isCursor(entry: Json, payload: Json): boolean {
  return (
    entryId(entry).startsWith('cursor-') ||
    entry.entryType === 'TimelineTimelineCursor' ||
    payload.__typename === 'TimelineTimelineCursor'
  );
}

function isBottomCursor(entry: Json, payload: Json): boolean {
  return payload.cursorType === 'Bottom' || entryId(entry).startsWith('cursor-bottom');
}

export interface TimelineItem {
  tweet: Tweet;
  /** Came as a TimelinePinEntry: the post a profile pins above its timeline. */
  pinned: boolean;
  /** Marked as an ad by its entry (`promotedMetadata`, classic schema): not an organic post. */
  promoted: boolean;
}

export interface TimelineItems {
  items: TimelineItem[];
  /** The Bottom cursor (next, older page); null when the timeline gave none. */
  cursor: string | null;
  /** Post entries (TimelineTweet) whose post no longer parses: schema drift. */
  unreadable: number;
  /** Entries that are not posts nor known non-posts (suggested users, trends...). */
  otherEntries: number;
  /** Instructions missing the entries they should carry. */
  malformed: number;
}

/** An entry payload that announces a post, whether or not the post still parses. */
function isPostPayload(payload: Json): boolean {
  return payload.__typename === 'TimelineTweet' || payload.itemType === 'TimelineTweet' || payload.tweet_results !== undefined;
}

function isPromoted(payload: Json): boolean {
  return asRecord(payload.promotedMetadata) !== undefined || asRecord(payload.promoted_metadata) !== undefined;
}

/**
 * Walks a Relay timeline response: its posts (with what their entry says
 * about them), the cursor of the next (older) page, and what was not read.
 * Only the Bottom cursor paginates forward; the Top cursor would loop back to
 * newer content. Known non-posts (the guest "Log in" prompt, cursors) and
 * unavailable tweets are skipped; everything else is counted, so callers can
 * tell schema drift from an empty page.
 */
export function parseTimelineItems(node: unknown): TimelineItems {
  const items: TimelineItem[] = [];
  const timeline = timelineEntries(node);
  let malformed = timeline.malformed;
  let unreadable = 0;
  let otherEntries = 0;
  let cursor: string | null = null;

  for (const { entry, pinned } of timeline.entries) {
    const { payloads, malformed: brokenItems } = entryPayloads(entry);
    malformed += brokenItems;
    for (const payload of payloads) {
      if (isCursor(entry, payload)) {
        if (isBottomCursor(entry, payload) && typeof payload.value === 'string' && payload.value) {
          cursor = payload.value;
        }
        continue;
      }

      const tweet = parseTweet(payload);
      if (tweet) {
        items.push({ tweet, pinned, promoted: isPromoted(payload) });
        continue;
      }
      if (KNOWN_NON_TWEET_PAYLOADS.has(String(payload.__typename))) continue;
      const type = tweetResultType(payload);
      if (type && UNAVAILABLE_TWEET_TYPES.has(type)) continue;
      if (isPostPayload(payload)) unreadable += 1;
      else otherEntries += 1;
    }
  }

  return { items, cursor, unreadable, otherEntries, malformed };
}

/**
 * The tweets of a timeline (pinned ones flagged) and its next cursor. Every
 * entry that was not read, and any instruction missing its entries, is
 * counted in `unrecognised`.
 */
export function parseTimelineEntries(node: unknown): {
  tweets: Tweet[];
  cursor: string | null;
  unrecognised: number;
} {
  const { items, cursor, unreadable, otherEntries, malformed } = parseTimelineItems(node);
  return {
    tweets: items.map(({ tweet, pinned }) => (pinned ? { ...tweet, pinned: true } : tweet)),
    cursor,
    unrecognised: malformed + unreadable + otherEntries,
  };
}

const COUNT_UNITS: ReadonlyArray<readonly [number, string]> = [
  [1_000_000_000, 'B'],
  [1_000_000, 'M'],
  [1_000, 'K'],
];

/** "241.5M"-style display of a count; undefined for an unknown count. */
export function formatCount(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  for (const [index, [size, suffix]] of COUNT_UNITS.entries()) {
    if (value < size) continue;
    const rounded = Math.round((value / size) * 10) / 10;
    // 999 999 rounds to 1000K: show it with the next unit up, as 1M.
    if (rounded >= 1000 && index > 0) return `${Math.round((value / COUNT_UNITS[index - 1][0]) * 10) / 10}${COUNT_UNITS[index - 1][1]}`;
    return `${rounded}${suffix}`;
  }
  return String(value);
}
