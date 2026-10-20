import { describe, expect, it } from 'vitest';
import { decodeEntities, formatCount, parseProfile, parseTimelineEntries, parseTweet } from '../parsers';
import {
  realData,
  realTimeline,
  realTweetNode,
  SEARCH_FIXTURE,
  SEARCH_ROOT,
  TRENDING_FIXTURE,
  TRENDING_ROOT,
} from './fixtures';

const search = realTimeline(SEARCH_FIXTURE, SEARCH_ROOT);
const trending = realTimeline(TRENDING_FIXTURE, TRENDING_ROOT);

// Entries of the real search fixture, picked for the feature they exercise.
const FIRST_TWEET = '2112089556615123114';
const NOTE_AND_VIDEO_TWEET = '2112139211008577754';
const QUOTING_TWEET = '2112174693344276838';
const MENTION_TWEET = '2112143476934512696';
const EDITED_TWEET = '2112149584860344797';

describe('parseTimelineEntries (real timelines)', () => {
  it('reads every TimelineTweet entry of a topic timeline, in order', () => {
    const page = parseTimelineEntries(search);

    expect(page.tweets).toHaveLength(20);
    expect(page.tweets[0].id).toBe(FIRST_TWEET);
    expect(page.tweets.every((tweet) => tweet.author.screenName !== '')).toBe(true);
  });

  it('reads the trending timeline with the same envelope', () => {
    expect(parseTimelineEntries(trending).tweets).toHaveLength(20);
  });

  it('skips the guest log-in prompt and reports no cursor', () => {
    const page = parseTimelineEntries(realTimeline(`${SEARCH_FIXTURE}.unknown-tag`, SEARCH_ROOT));

    expect(page).toEqual({ tweets: [], cursor: null, unrecognised: 0 });
  });

  it('reports no unrecognised entry on real timelines', () => {
    expect(parseTimelineEntries(search).unrecognised).toBe(0);
    expect(parseTimelineEntries(trending).unrecognised).toBe(0);
  });
});

describe('parseTweet (real tweet nodes)', () => {
  it('reads text, ISO date, counts and views of the unified schema', () => {
    const tweet = parseTweet(realTweetNode(search, FIRST_TWEET));

    expect(tweet).toMatchObject({
      id: FIRST_TWEET,
      createdAt: '2026-10-19T07:52:45.000Z',
      author: { id: '44196397', screenName: 'elonmusk', name: 'Elon Musk', verified: true },
      lang: 'en',
      isQuote: false,
      media: [],
    });
    // The real node carries no reply/repost signal: unknown, not "false".
    expect(tweet?.isReply).toBeUndefined();
    expect(tweet?.isRetweet).toBeUndefined();
    expect(tweet?.text?.startsWith('Next year, I will give one of my SpaceX shares')).toBe(true);
    expect(tweet?.viewCount).toBeGreaterThan(0);
  });

  it('prefers the full note_tweet text over the truncated details.full_text', () => {
    const node = realTweetNode(search, NOTE_AND_VIDEO_TWEET);

    const tweet = parseTweet(node);

    expect(tweet?.text).toBe(node.note_tweet.note_tweet_results.result.text);
    expect(tweet?.text?.length).toBeGreaterThan(node.details.full_text.length);
  });

  it('reads video media from media_entities2, keeping the best mp4', () => {
    const [video] = parseTweet(realTweetNode(search, NOTE_AND_VIDEO_TWEET))?.media ?? [];

    expect(video).toEqual({
      type: 'video',
      url: 'https://video.twimg.com/amplify_video/2112139165173264384/vid/avc1/1080x1080/NmwgmPq7z5NZ_OjP.mp4?tag=29',
      thumbnailUrl:
        'https://pbs.twimg.com/amplify_video_thumb/2112139165173264384/img/l3uL2i4_URmAszfl.jpg',
      width: 1080,
      height: 1080,
      durationMs: 34366,
      altText: undefined,
    });
  });

  it('reads the quoted tweet from quoted_tweet_results', () => {
    const tweet = parseTweet(realTweetNode(search, QUOTING_TWEET));

    expect(tweet?.isQuote).toBe(true);
    expect(tweet?.quotedTweet).toMatchObject({
      id: '2111278019096809664',
      author: { screenName: 'pramodDagal' },
    });
  });

  it('reads isEdited from edit_control (EditControlEdit vs EditControlInitial)', () => {
    expect(parseTweet(realTweetNode(search, EDITED_TWEET))?.isEdited).toBe(true);
    expect(parseTweet(realTweetNode(search, FIRST_TWEET))?.isEdited).toBe(false);
  });

  it('does not flag a tweet as a reply just because it mentions someone', () => {
    const tweet = parseTweet(realTweetNode(search, MENTION_TWEET));

    expect(tweet?.isReply).not.toBe(true);
    expect(tweet?.inReplyToScreenName).toBeUndefined();
  });

  it('leaves the view count unknown when views is empty instead of inventing 0', () => {
    const tweet = parseTweet(realData('TweetResultByRestId').tweet_result_by_rest_id);

    expect(tweet?.viewCount).toBeUndefined();
  });

  it('returns undefined for a results wrapper without result (unknown id)', () => {
    const root = realData('TweetResultByRestId.not-found').tweet_result_by_rest_id;

    expect(root.rest_id).toBe('1');
    expect(parseTweet(root)).toBeUndefined();
  });
});

describe('parseProfile (real UserByScreenName node)', () => {
  it('reads the bio from profile_bio and the join date from created_at_ms', () => {
    const profile = parseProfile(realData('UserByScreenName').user_result_by_screen_name);

    expect(profile?.description).toBe('https://t.co/ZdBx5WABYx');
    expect(profile?.joinedAt).toBe('2009-06-02T20:12:29.000Z');
    expect(profile?.followersCountFormatted).toBe('241.5M');
  });

  it('returns undefined for a user wrapper without result instead of a blank profile', () => {
    const { id } = realData('UserByScreenName').user_result_by_screen_name;

    expect(parseProfile({ id })).toBeUndefined();
  });
});

/*
 * Shapes no real guest response has shown yet: cursors (guest timelines end
 * with a log-in prompt), visibility wrappers, conversation modules, replies
 * and legacy-schema dates. Each wraps or edits a real tweet node; the wrapper
 * itself is synthetic, modelled on docs/HANDOFF.md §6. Replace them with real
 * captures as soon as a response carries the shape.
 */
describe('parser paths without a real capture yet (synthetic wrappers)', () => {
  const realTweet = () => structuredClone(realTweetNode(search, FIRST_TWEET));
  const tweetEntry = (result: unknown, id = 'tweet-x') => ({
    entry_id: id,
    content: { content: { __typename: 'TimelineTweet', tweet_results: { result } } },
  });
  const cursorEntry = (type: 'Top' | 'Bottom', value: string) => ({
    entry_id: `cursor-${type.toLowerCase()}-1`,
    content: { __typename: 'TimelineTimelineCursor', cursorType: type, value },
  });

  it('unwraps TweetWithVisibilityResults', () => {
    const page = parseTimelineEntries({
      instructions: [{ entries: [tweetEntry({ __typename: 'TweetWithVisibilityResults', tweet: realTweet() })] }],
    });

    expect(page.tweets.map((t) => t.id)).toEqual([FIRST_TWEET]);
  });

  it('returns the bottom cursor, never the top one', () => {
    const page = parseTimelineEntries({
      instructions: [{ entries: [cursorEntry('Bottom', 'BOTTOM-VALUE'), cursorEntry('Top', 'TOP-VALUE')] }],
    });

    expect(page.cursor).toBe('BOTTOM-VALUE');
  });

  it('reads the cursor of a TimelineReplaceEntry instruction', () => {
    const page = parseTimelineEntries({
      instructions: [{ type: 'TimelineReplaceEntry', entry: cursorEntry('Bottom', 'NEXT') }],
    });

    expect(page.cursor).toBe('NEXT');
  });

  it('reads tweets inside a module entry (conversation thread)', () => {
    const second = { ...realTweet(), rest_id: '2' };
    const page = parseTimelineEntries({
      instructions: [
        {
          entries: [
            {
              entry_id: 'profile-conversation-1',
              content: {
                __typename: 'TimelineTimelineModule',
                items: [
                  { item: { content: { tweet_results: { result: realTweet() } } } },
                  { item: { content: { tweet_results: { result: second } } } },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(page.tweets.map((t) => t.id)).toEqual([FIRST_TWEET, '2']);
  });

  it('flags a reply from legacy in_reply_to fields', () => {
    const node = realTweet();
    node.legacy = { ...node.legacy, in_reply_to_status_id_str: '9', in_reply_to_screen_name: 'alice' };

    const tweet = parseTweet(node);

    expect(tweet?.isReply).toBe(true);
    expect(tweet?.inReplyToScreenName).toBe('alice');
  });

  it('counts a TimelineTweet whose result is no longer a Tweet as unrecognised', () => {
    const drifted = { ...realTweet(), __typename: 'TweetV2' };
    const gone = { __typename: 'TweetTombstone' };

    const page = parseTimelineEntries({ instructions: [{ entries: [tweetEntry(drifted), tweetEntry(gone)] }] });

    expect(page).toEqual({ tweets: [], cursor: null, unrecognised: 1 });
  });

  it('reads a module item shaped item.itemContent (older schema)', () => {
    const page = parseTimelineEntries({
      instructions: [
        {
          entries: [
            {
              entry_id: 'profile-conversation-2',
              content: { items: [{ item: { itemContent: { tweet_results: { result: realTweet() } } } }] },
            },
          ],
        },
      ],
    });

    expect(page.tweets.map((t) => t.id)).toEqual([FIRST_TWEET]);
  });

  it('normalises a legacy date string to ISO 8601, or leaves it unknown', () => {
    const node = realTweet();
    delete node.details.created_at_ms;
    node.legacy = { ...node.legacy, created_at: 'Wed Oct 10 20:19:24 +0000 2018' };
    const invalid = realTweet();
    delete invalid.details.created_at_ms;
    invalid.legacy = { ...invalid.legacy, created_at: 'not a date' };

    expect(parseTweet(node)?.createdAt).toBe('2018-10-10T20:19:24.000Z');
    expect(parseTweet(invalid)).toBeDefined();
    expect(parseTweet(invalid)?.createdAt).toBeUndefined();
  });

  it('keeps a quote whose quoted tweet is unavailable, without inventing the quoted tweet', () => {
    const node = structuredClone(realTweetNode(search, QUOTING_TWEET));
    node.quoted_tweet_results = { result: { __typename: 'TweetTombstone' } };

    const tweet = parseTweet(node);

    expect(tweet?.isQuote).toBe(true);
    expect(tweet?.quotedTweet).toBeUndefined();
  });
});

/*
 * Real nodes with one field removed: a value the payload does not carry stays
 * undefined, and a tweet that cannot be read is rejected, never filled in.
 */
describe('unknown values stay unknown (real nodes, one field removed)', () => {
  const realTweet = () => structuredClone(realTweetNode(search, FIRST_TWEET));
  const realUser = () => structuredClone(realData('UserByScreenName').user_result_by_screen_name);
  const entryOf = (result: unknown) => ({
    entry_id: 'tweet-x',
    content: { content: { __typename: 'TimelineTweet', tweet_results: { result } } },
  });

  it('reads the five engagement counts of a real tweet', () => {
    const tweet = parseTweet(realData('TweetResultByRestId').tweet_result_by_rest_id);

    expect(tweet).toMatchObject({
      replyCount: 18100,
      retweetCount: 124598,
      likeCount: 309189,
      quoteCount: 7323,
      bookmarkCount: 21980,
    });
  });

  it('leaves tweet counts undefined when counts is absent, instead of 0', () => {
    const node = realTweet();
    delete node.counts;

    const tweet = parseTweet(node);

    expect(tweet).toBeDefined();
    expect(tweet?.replyCount).toBeUndefined();
    expect(tweet?.retweetCount).toBeUndefined();
    expect(tweet?.likeCount).toBeUndefined();
    expect(tweet?.quoteCount).toBeUndefined();
    expect(tweet?.bookmarkCount).toBeUndefined();
  });

  it('does not turn a non-numeric count (false, [], blank) into 0', () => {
    const node = realTweet();
    node.counts = { reply_count: false, retweet_count: [], favorite_count: ' ', quote_count: -1 };

    const tweet = parseTweet(node);

    expect(tweet?.replyCount).toBeUndefined();
    expect(tweet?.retweetCount).toBeUndefined();
    expect(tweet?.likeCount).toBeUndefined();
    expect(tweet?.quoteCount).toBeUndefined();
  });

  it('leaves user counts and their formatted form undefined when the payload lacks them', () => {
    const node = realUser();
    delete node.result.relationship_counts;
    delete node.result.tweet_counts;

    const profile = parseProfile(node);

    expect(profile?.screenName).toBe('elonmusk');
    expect(profile?.followersCount).toBeUndefined();
    expect(profile?.friendsCount).toBeUndefined();
    expect(profile?.statusCount).toBeUndefined();
    expect(profile?.followersCountFormatted).toBeUndefined();
    expect(profile?.friendsCountFormatted).toBeUndefined();
  });

  it('rejects a tweet without core.user_results instead of giving it a blank author', () => {
    const node = realTweet();
    delete node.core.user_results;

    expect(parseTweet(node)).toBeUndefined();
    expect(parseTimelineEntries({ instructions: [{ entries: [entryOf(node)] }] })).toEqual({
      tweets: [],
      cursor: null,
      unrecognised: 1,
    });
  });

  it('rejects a tweet whose author has no id', () => {
    const node = realTweet();
    delete node.core.user_results.result.rest_id;
    delete node.core.user_results.rest_id;

    expect(parseTweet(node)).toBeUndefined();
  });

  it('rejects a quoting tweet whose quoted tweet no longer parses, rather than dropping the quote', () => {
    const node = structuredClone(realTweetNode(search, QUOTING_TWEET));
    delete node.quoted_tweet_results.result.core.user_results;

    expect(parseTweet(node)).toBeUndefined();
  });

  it('has no conversation id on real captures (they carry no conversation_id_str)', () => {
    expect(parseTweet(realTweet())?.conversationId).toBeUndefined();
  });

  it('leaves createdAt undefined when no timestamp is present', () => {
    const node = realTweet();
    delete node.details.created_at_ms;

    const tweet = parseTweet(node);

    expect(tweet).toBeDefined();
    expect(tweet?.createdAt).toBeUndefined();
  });

  it('leaves text undefined when no text field is present, but keeps a real empty text', () => {
    const missing = realTweet();
    delete missing.details.full_text;
    delete missing.note_tweet;
    const empty = realTweet();
    empty.details.full_text = '';
    delete empty.note_tweet;

    expect(parseTweet(missing)?.text).toBeUndefined();
    expect(parseTweet(empty)?.text).toBe('');
  });

  it('leaves a video url undefined when no mp4 variant exists, instead of the jpg thumbnail', () => {
    const node = structuredClone(realTweetNode(search, NOTE_AND_VIDEO_TWEET));
    const info = node.media_entities2[0].video_info;
    info.variants = info.variants.filter((v: { content_type: string }) => v.content_type !== 'video/mp4');

    const [video] = parseTweet(node)?.media ?? [];

    expect(video.type).toBe('video');
    expect(video.url).toBeUndefined();
    expect(video.thumbnailUrl).toMatch(/\.jpg$/);
  });
});

describe('missing display fields stay unknown (real node, field removed)', () => {
  it('leaves the author name and avatar undefined instead of empty strings', () => {
    const node = structuredClone(realTweetNode(search, FIRST_TWEET));
    delete node.core.user_results.result.core.name;
    delete node.core.user_results.result.avatar;

    const author = parseTweet(node)?.author;

    expect(author?.screenName).toBe('elonmusk');
    expect(author?.name).toBeUndefined();
    expect(author?.avatarUrl).toBeUndefined();
  });
});

describe('text and dates as X sends them', () => {
  it('decodes the HTML entities X puts in full_text (real tweet) but not in note_tweet text', () => {
    const tweets = parseTimelineEntries(search).tweets;
    const decoded = tweets.find((tweet) => tweet.text?.includes('Michael & Susan Dell'));

    expect(decoded).toBeDefined();
    expect(tweets.some((tweet) => tweet.text?.includes('&amp;'))).toBe(false);
    expect(decodeEntities('&amp;lt; &lt;b&gt; &quot;x&quot; &#39;y&#39;')).toBe('&lt; <b> "x" \'y\'');
  });

  it('leaves an out-of-range timestamp unknown instead of failing the whole timeline', () => {
    const node = structuredClone(realTweetNode(search, FIRST_TWEET));
    node.details.created_at_ms = 1e20;

    const tweet = parseTweet(node);

    expect(tweet?.id).toBe(FIRST_TWEET);
    expect(tweet?.createdAt).toBeUndefined();
  });
});

describe('audit hardening (real nodes, one field changed)', () => {
  it('keeps media off X\'s CDN out of the post and counts it', () => {
    const node = structuredClone(realTweetNode(search, NOTE_AND_VIDEO_TWEET));
    node.media_entities2[0].media_url_https = 'https://tracker.example/pixel.jpg';

    const tweet = parseTweet(node);

    expect(tweet?.media).toEqual([]);
    expect(tweet?.unparsedMediaCount).toBe(1);
  });

  it('counts a media type it does not know instead of hiding it', () => {
    const node = structuredClone(realTweetNode(search, NOTE_AND_VIDEO_TWEET));
    node.media_entities2[0].type = 'hologram';

    expect(parseTweet(node)?.unparsedMediaCount).toBe(1);
  });

  it('drops an avatar that is not on X\'s CDN', () => {
    const node = structuredClone(realTweetNode(search, FIRST_TWEET));
    node.core.user_results.result.avatar.image_url = 'javascript:alert(1)';

    expect(parseTweet(node)?.author.avatarUrl).toBeUndefined();
  });

  it('reports unknown verification as unknown, and legacy verification as verified', () => {
    const node = structuredClone(realTweetNode(search, FIRST_TWEET));
    delete node.core.user_results.result.verification;
    expect(parseTweet(node)?.author.verified).toBeUndefined();

    node.core.user_results.result.verification = { is_blue_verified: false };
    node.core.user_results.result.legacy = { verified: true };
    expect(parseTweet(node)?.author.verified).toBe(true);
  });

  it('refuses a quote chain deeper than real posts go', () => {
    let node: Record<string, any> = structuredClone(realTweetNode(search, FIRST_TWEET));
    for (let level = 0; level < 5; level++) {
      node = { ...structuredClone(realTweetNode(search, FIRST_TWEET)), quoted_tweet_results: { result: node } };
    }

    expect(parseTweet(node)).toBeUndefined();
  });

  it('turns a renamed "entries" into an unrecognised instruction, not an empty page', () => {
    const timeline = structuredClone(trending);
    const add = timeline.instructions.find((i: Record<string, unknown>) => i.__typename === 'TimelineAddEntries');
    add.entries2 = add.entries;
    delete add.entries;

    const page = parseTimelineEntries(timeline);

    expect(page.tweets).toEqual([]);
    expect(page.unrecognised).toBe(1);
  });

  it('formats counts without the "1000K" rounding artefact', () => {
    expect(formatCount(999_999)).toBe('1M');
    expect(formatCount(241_523_037)).toBe('241.5M');
    expect(formatCount(999)).toBe('999');
  });
});
