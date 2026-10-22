import { describe, expect, it } from 'vitest';
import { parseTimelineEntries, parseTimelineItems, parseTweet } from '../parsers';
import { realTimeline, realTweetNode, SEARCH_FIXTURE, SEARCH_ROOT, TRENDING_FIXTURE, TRENDING_ROOT } from './fixtures';

const search = realTimeline(SEARCH_FIXTURE, SEARCH_ROOT);
const trending = realTimeline(TRENDING_FIXTURE, TRENDING_ROOT);
const FIRST_TWEET = '2112089556615123114';
const realTweet = () => structuredClone(realTweetNode(search, FIRST_TWEET));

/**
 * The classic web client nests an entry's payload as `content.itemContent`.
 * Synthetic: no logged-in capture is published (the repository is public).
 */
const classicEntry = (itemContent: Record<string, unknown>, entryId = 'tweet-1') => ({
  entryId,
  content: { entryType: 'TimelineTimelineItem', __typename: 'TimelineTimelineItem', itemContent },
});
const classicTweet = (result: unknown, extra: Record<string, unknown> = {}) =>
  classicEntry({ itemType: 'TimelineTweet', __typename: 'TimelineTweet', tweet_results: { result }, ...extra });

describe('parseTimelineItems', () => {
  it('reads the same posts as parseTimelineEntries on real timelines, none promoted', () => {
    for (const timeline of [search, trending]) {
      const page = parseTimelineItems(timeline);

      expect(page.items.map((item) => item.tweet.id)).toEqual(parseTimelineEntries(timeline).tweets.map((t) => t.id));
      expect(page.items.every((item) => !item.promoted && !item.pinned)).toBe(true);
      expect(page).toMatchObject({ unreadable: 0, otherEntries: 0, malformed: 0 });
    }
  });

  it('flags a promoted post instead of passing it as organic', () => {
    const page = parseTimelineItems({
      instructions: [{ type: 'TimelineAddEntries', entries: [classicTweet(realTweet(), { promotedMetadata: { advertiser_results: {} } })] }],
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].promoted).toBe(true);
  });

  it('keeps the pinned flag of a TimelinePinEntry', () => {
    const page = parseTimelineItems({ instructions: [{ type: 'TimelinePinEntry', entry: classicTweet(realTweet()) }] });

    expect(page.items[0]).toMatchObject({ pinned: true, promoted: false });
  });

  it('counts a null entry as malformed instead of throwing', () => {
    const page = parseTimelineItems({ instructions: [{ type: 'TimelineAddEntries', entries: [null, classicTweet(realTweet())] }] });

    expect(page.items).toHaveLength(1);
    expect(page.malformed).toBe(1);
  });

  it('counts a non-post entry apart from a post that no longer parses', () => {
    const user = classicEntry({ itemType: 'TimelineUser', __typename: 'TimelineUser', user_results: {} }, 'user-1');
    const drifted = classicTweet({ ...realTweet(), __typename: 'TweetV2' }, {});

    const page = parseTimelineItems({ instructions: [{ type: 'TimelineAddEntries', entries: [user, drifted] }] });

    expect(page).toMatchObject({ items: [], otherEntries: 1, unreadable: 1 });
    // parseTimelineEntries keeps reporting both, as before.
    expect(parseTimelineEntries({ instructions: [{ type: 'TimelineAddEntries', entries: [user, drifted] }] }).unrecognised).toBe(2);
  });
});

describe('parseTweet: reposts and protected authors', () => {
  it('reads the reposted post in full from retweeted_status_result', () => {
    const original = realTweet();
    const repost = { ...realTweet(), rest_id: '10', legacy: { retweeted_status_result: { result: original } } };

    const tweet = parseTweet(repost);

    expect(tweet?.isRetweet).toBe(true);
    expect(tweet?.retweetedTweet?.id).toBe(FIRST_TWEET);
    expect(tweet?.retweetedTweet?.text).toBe(parseTweet(original)?.text);
  });

  it('marks a repost of an unavailable post without inventing it', () => {
    const repost = { ...realTweet(), rest_id: '10', legacy: { retweeted_status_result: { result: { __typename: 'TweetTombstone' } } } };

    const tweet = parseTweet(repost);

    expect(tweet?.isRetweet).toBe(true);
    expect(tweet?.retweetedTweet).toBeUndefined();
  });

  it('reads whether the author is protected, and leaves it unknown when absent', () => {
    const node = realTweet();
    expect(parseTweet(node)?.author.protected).toBe(false);

    node.core.user_results.result.privacy = { protected: true };
    expect(parseTweet(node)?.author.protected).toBe(true);

    delete node.core.user_results.result.privacy;
    expect(parseTweet(node)?.author.protected).toBeUndefined();
  });
});
