/**
 * Tools that ask X as a logged-out visitor, through the agent's own caches
 * and budgets (guest.ts). They see what anyone sees without an account: a
 * few posts per profile, popular posts, trends. Never the user's own feed.
 */
import type { CursorPage, Tweet } from '../../shared/types';
import { handleArg, intArg, InvalidArgs, stringArg } from './args';
import type { Fetched } from './guest';
import { toAgentPost, UNTRUSTED_TEXT } from './post';
import type { AgentTool } from './tools';

const WORLDWIDE_WOEID = 1;
const TWEET_ID = /^[0-9]{1,20}$/;

const meta = <T>(fetched: Fetched<T>) => ({ fetchedAt: new Date(fetched.fetchedAt).toISOString(), cached: fetched.cached });

/** Guest answers do not say which posts are ads: `promoted` stays unknown. */
const posts = (page: CursorPage<Tweet>) => ({
  notice: UNTRUSTED_TEXT,
  posts: page.items.map((tweet) => toAgentPost(tweet, { pinned: tweet.pinned === true })),
});

const guest = (properties: AgentTool['inputSchema']['properties'], required: string[] = []): AgentTool['inputSchema'] => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const READ_ONLY_WEB = { readOnlyHint: true, openWorldHint: true } as const;

export const GUEST_TOOLS: readonly AgentTool[] = [
  {
    name: 'get_user_posts',
    title: "An account's latest posts (logged-out view)",
    description:
      'The latest original posts of an X account as a logged-out visitor sees them (about 5, the pinned one flagged), from X or a 60 s cache. ' +
      `The agent has its own limited share of requests. ${UNTRUSTED_TEXT}`,
    inputSchema: guest({ handle: { type: 'string', description: 'The X handle, e.g. "elonmusk".' } }, ['handle']),
    annotations: READ_ONLY_WEB,
    run: async (args, ctx) => {
      const fetched = await ctx.guest.userPosts(String(stringArg(args, 'handle', 16)));
      return { ...meta(fetched), ...posts(fetched.value) };
    },
  },
  {
    name: 'get_topic_posts',
    title: 'Popular posts about a topic (logged-out view)',
    description:
      'Popular posts X shows logged-out visitors for a topic tag: one word such as "Bitcoin" or "Tesla" (a hashtag gives nothing). ' +
      `An unknown tag gives no post. ${UNTRUSTED_TEXT}`,
    inputSchema: guest({ topic: { type: 'string', maxLength: 100, description: 'One word, e.g. "Bitcoin".' } }, ['topic']),
    annotations: READ_ONLY_WEB,
    run: async (args, ctx) => {
      const fetched = await ctx.guest.topicPosts(String(stringArg(args, 'topic', 100)));
      return { ...meta(fetched), ...posts(fetched.value) };
    },
  },
  {
    name: 'get_trending_posts',
    title: 'Popular posts of the day (logged-out view)',
    description: `The popular posts of the day X shows logged-out visitors (about 20). ${UNTRUSTED_TEXT}`,
    inputSchema: guest({}),
    annotations: READ_ONLY_WEB,
    run: async (_args, ctx) => {
      const fetched = await ctx.guest.trendingPosts();
      return { ...meta(fetched), ...posts(fetched.value) };
    },
  },
  {
    name: 'get_trends',
    title: 'Trends of a place',
    description:
      'Trend names X computes for a place, by WOEID (1 Worldwide, 23424977 United States, 23424819 France). X gives no post volumes. ' +
      'X limits this endpoint hard: the agent gets 4 calls per 15 minutes, and answers are cached 5 minutes.',
    inputSchema: guest({ woeid: { type: 'integer', minimum: 1, default: WORLDWIDE_WOEID } }),
    annotations: READ_ONLY_WEB,
    run: async (args, ctx) => {
      const fetched = await ctx.guest.trends(intArg(args, 'woeid', 1, Number.MAX_SAFE_INTEGER) ?? WORLDWIDE_WOEID);
      return { ...meta(fetched), ...fetched.value };
    },
  },
  {
    name: 'get_post',
    title: 'One post by id (logged-out view)',
    description: `One post by its numeric id; found: false when X does not show it to a logged-out visitor (deleted, protected or unknown). ${UNTRUSTED_TEXT}`,
    inputSchema: guest({ id: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'The numeric post id.' } }, ['id']),
    annotations: READ_ONLY_WEB,
    run: async (args, ctx) => {
      const id = String(stringArg(args, 'id', 20));
      if (!TWEET_ID.test(id)) throw new InvalidArgs('id must be a numeric post id');
      const fetched = await ctx.guest.post(id);
      const tweet = fetched.value;
      if (!tweet) return { ...meta(fetched), found: false };
      return { ...meta(fetched), found: true, notice: UNTRUSTED_TEXT, post: toAgentPost(tweet, { pinned: tweet.pinned === true }) };
    },
  },
  {
    name: 'get_profile',
    title: "An account's public profile",
    description: "An X account's public profile: name, bio, follower and post counts when X sends them; found: false when the account does not exist. " + UNTRUSTED_TEXT,
    inputSchema: guest({ handle: { type: 'string', description: 'The X handle.' } }, ['handle']),
    annotations: READ_ONLY_WEB,
    run: async (args, ctx) => {
      const fetched = await ctx.guest.profile(String(handleArg(args, 'handle')));
      return fetched.value ? { ...meta(fetched), found: true, profile: fetched.value } : { ...meta(fetched), found: false };
    },
  },
];
