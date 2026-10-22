/**
 * The tools an agent can call, over the MCP endpoint or the plain JSON one
 * (server.ts). All read-only: nothing here posts, likes, follows or trades.
 * Feed tools read the posts captured from the "Mon X" tab (feedStore.ts);
 * guest tools ask X as a logged-out visitor (guestTools.ts).
 */
import { ApiError, ERROR_CODES } from '../api/client';
import type { CaptureStatus } from '../../shared/agent';
import { boolArg, cashtagArg, handleArg, intArg, InvalidArgs, listArg, readArgs, stringArg, type Args } from './args';
import { FEED_SOURCES } from './capture';
import type { FeedStore } from './feedStore';
import type { GuestGateway } from './guest';
import { GUEST_TOOLS } from './guestTools';
import { UNKNOWN_FIELDS, UNTRUSTED_TEXT } from './post';

export interface ToolContext {
  store: FeedStore;
  guest: GuestGateway;
  capture(): CaptureStatus;
  now(): number;
}

export interface AgentTool {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
    additionalProperties: false;
  };
  annotations: { readOnlyHint: true; openWorldHint: boolean };
  run(args: Args, ctx: ToolContext): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export type ToolOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; kind: 'unknown-tool' | 'invalid-args' | 'failed'; message: string; code?: string; retriable?: boolean };

const DEFAULT_LIMIT = 50;
const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_TOP = 20;

const feedStatus: AgentTool = {
  name: 'feed_status',
  title: 'Feed capture status',
  description:
    "State of the feed capture: whether Twitter Desktop is reading the user's X feed right now, when it last captured posts, " +
    'and how many are in memory. Check it before trusting an empty feed: it can mean the capture is stopped or x.com is hidden, not that nobody posted.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: (_args, ctx) => ({
    capture: ctx.capture(),
    buffer: { epoch: ctx.store.epoch, posts: ctx.store.size, latestSeq: ctx.store.latestSeq },
  }),
};

const getFeed: AgentTool = {
  name: 'get_feed',
  title: "Posts of the user's X feed",
  description:
    'Posts from the user\'s X feed as x.com loaded them in the Twitter Desktop app ("Mon X" tab): home timeline, searches, lists and profiles the user opened. ' +
    'Nothing is requested from X. Poll with after_seq = nextSeq and the same epoch to get only new captures, oldest first; without after_seq the latest captures come first. ' +
    `Ads are left out unless include_promoted; posts of protected accounts are never returned. ${UNKNOWN_FIELDS} ${UNTRUSTED_TEXT}`,
  inputSchema: {
    type: 'object',
    properties: {
      after_seq: { type: 'integer', minimum: 0, description: 'Only posts captured after this sequence number (nextSeq of the previous call).' },
      epoch: { type: 'string', description: 'The epoch of after_seq; when the buffer was emptied since, the answer says reset: true.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: DEFAULT_LIMIT },
      sources: {
        type: 'array',
        items: { type: 'string', enum: [...FEED_SOURCES] },
        description: 'Where x.com showed the post: home (the user\'s timeline), search, list, profile, post (a thread), community, trending.',
      },
      cashtag: { type: 'string', description: 'Only posts mentioning this cashtag, e.g. "$TSLA" or "TSLA".' },
      contains: { type: 'string', maxLength: 100, description: 'Only posts whose text (or reposted/quoted text) contains this, ignoring case.' },
      author: { type: 'string', description: 'Only posts by this handle.' },
      include_promoted: { type: 'boolean', default: false, description: 'Include ads.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: (args, ctx) => ({
    notice: UNTRUSTED_TEXT,
    ...ctx.store.query({
      afterSeq: intArg(args, 'after_seq', 0, Number.MAX_SAFE_INTEGER),
      epoch: stringArg(args, 'epoch', 32),
      limit: intArg(args, 'limit', 1, 200) ?? DEFAULT_LIMIT,
      sources: listArg(args, 'sources', FEED_SOURCES),
      cashtag: cashtagArg(args, 'cashtag'),
      contains: stringArg(args, 'contains', 100),
      author: handleArg(args, 'author'),
      includePromoted: boolArg(args, 'include_promoted') ?? false,
    }),
    capture: ctx.capture(),
  }),
};

const cashtagStats: AgentTool = {
  name: 'cashtag_stats',
  title: 'Cashtags in the captured feed',
  description:
    'Cashtag mentions ($TSLA) in captured posts written during the last window_minutes: posts, distinct authors, and the sums of likes, reposts and views ' +
    'over the posts where X sent them ("known" says how many). Covers only what the app captured from the user\'s feed, not all of X; ads are left out unless include_promoted. ' +
    UNTRUSTED_TEXT,
  inputSchema: {
    type: 'object',
    properties: {
      window_minutes: { type: 'integer', minimum: 1, maximum: 1440, default: DEFAULT_WINDOW_MINUTES },
      top: { type: 'integer', minimum: 1, maximum: 50, default: DEFAULT_TOP },
      include_promoted: { type: 'boolean', default: false },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: (args, ctx) => {
    const windowMinutes = intArg(args, 'window_minutes', 1, 1440) ?? DEFAULT_WINDOW_MINUTES;
    const stats = ctx.store.cashtagStats({
      windowMs: windowMinutes * 60_000,
      top: intArg(args, 'top', 1, 50) ?? DEFAULT_TOP,
      now: ctx.now(),
      includePromoted: boolArg(args, 'include_promoted') ?? false,
    });
    return { windowMinutes, ...stats, capture: ctx.capture() };
  },
};

export const AGENT_TOOLS: ReadonlyMap<string, AgentTool> = new Map(
  [feedStatus, getFeed, cashtagStats, ...GUEST_TOOLS].map((tool) => [tool.name, tool]),
);

/** Runs a tool; every failure comes back as an outcome, never as a thrown error. */
export async function callTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const tool = AGENT_TOOLS.get(name);
  if (!tool) return { ok: false, kind: 'unknown-tool', message: `Unknown tool "${String(name).slice(0, 60)}".` };
  try {
    const args = readArgs(rawArgs, Object.keys(tool.inputSchema.properties), tool.inputSchema.required);
    return { ok: true, result: await tool.run(args, ctx) };
  } catch (error) {
    if (error instanceof InvalidArgs) return { ok: false, kind: 'invalid-args', message: error.message };
    if (error instanceof ApiError) {
      if (error.code === ERROR_CODES.INVALID_INPUT) return { ok: false, kind: 'invalid-args', message: error.message };
      return { ok: false, kind: 'failed', message: error.message, code: error.code, retriable: error.retriable };
    }
    console.error(`[agent] tool ${name} failed unexpectedly:`, error);
    return { ok: false, kind: 'failed', message: 'The tool failed unexpectedly; see the app log.', retriable: false };
  }
}
