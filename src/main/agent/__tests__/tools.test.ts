import { describe, expect, it, vi } from 'vitest';
import { ApiError, ERROR_CODES } from '../../api/client';
import { parseTimelineItems } from '../../api/parsers';
import { realTimeline, SEARCH_FIXTURE, SEARCH_ROOT } from '../../api/__tests__/fixtures';
import { FeedStore } from '../feedStore';
import type { GuestGateway } from '../guest';
import type { CaptureStatus } from '../../../shared/agent';
import { AGENT_TOOLS, callTool, type ToolContext } from '../tools';

const ITEMS = parseTimelineItems(realTimeline(SEARCH_FIXTURE, SEARCH_ROOT)).items;
// The fixture's posts were written on 2026-10-19 between 04:10 and 14:21 UTC.
const NOW = Date.parse('2026-10-19T15:00:00Z');
const CAPTURE: CaptureStatus = { capturing: true, xView: 'open', xViewVisible: true, onHomeTimeline: true, unreadablePosts: 0, errors: 0 };

function context(guest: Partial<GuestGateway> = {}): ToolContext {
  const store = new FeedStore(100, () => 'e1');
  store.add({ items: ITEMS, source: 'home', operation: 'HomeTimeline' }, NOW - 60_000);
  return { store, guest: guest as GuestGateway, capture: () => CAPTURE, now: () => NOW };
}

describe('tool definitions', () => {
  it('declares a closed JSON schema and a read-only hint for every tool', () => {
    for (const tool of AGENT_TOOLS.values()) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.description.length).toBeGreaterThan(40);
    }
    expect([...AGENT_TOOLS.keys()]).toEqual(
      expect.arrayContaining(['feed_status', 'get_feed', 'cashtag_stats', 'get_user_posts', 'get_topic_posts', 'get_trends', 'get_post']),
    );
  });

  it('warns that post texts are untrusted', () => {
    expect(AGENT_TOOLS.get('get_feed')?.description).toMatch(/untrusted/i);
  });
});

describe('callTool', () => {
  it('refuses an unknown tool, including object built-ins', async () => {
    for (const name of ['nope', 'constructor', '__proto__', 'toString']) {
      expect(await callTool(name, {}, context())).toMatchObject({ ok: false, kind: 'unknown-tool' });
    }
  });

  it('refuses arguments the tool does not declare, or of the wrong type', async () => {
    const ctx = context();
    for (const args of [{ limit: 0 }, { limit: '5' }, { sources: ['inbox'] }, { cashtag: '$10' }, { extra: 1 }, [], 'x']) {
      expect(await callTool('get_feed', args, ctx)).toMatchObject({ ok: false, kind: 'invalid-args' });
    }
  });

  it('get_feed: posts, where to resume, and how fresh the capture is', async () => {
    const outcome = await callTool('get_feed', { limit: 5, cashtag: 'spcx' }, context());

    expect(outcome.ok).toBe(true);
    const result = (outcome as { result: Record<string, any> }).result;
    expect(result.posts).toHaveLength(2);
    expect(result.posts[0].cashtags).toContain('$SPCX');
    expect(result).toMatchObject({ epoch: 'e1', nextSeq: ITEMS.length, gap: false, reset: false, capture: CAPTURE });
  });

  it('get_feed polls with after_seq and epoch', async () => {
    const ctx = context();
    const outcome = await callTool('get_feed', { after_seq: ITEMS.length - 1, epoch: 'e1' }, ctx);

    expect((outcome as { result: Record<string, any> }).result.posts.map((post: { seq: number }) => post.seq)).toEqual([ITEMS.length]);
  });

  it('cashtag_stats counts over the window ending now', async () => {
    const outcome = await callTool('cashtag_stats', { window_minutes: 1440 }, context());

    expect((outcome as { result: Record<string, any> }).result.cashtags[0]).toMatchObject({ cashtag: '$SPCX', posts: 2 });
  });

  it('feed_status reports the capture and the buffer', async () => {
    const outcome = await callTool('feed_status', undefined, context());

    expect(outcome).toMatchObject({ ok: true, result: { capture: CAPTURE, buffer: { epoch: 'e1', posts: ITEMS.length, latestSeq: ITEMS.length } } });
  });

  it('guest tools say when X answered and whether it came from the cache', async () => {
    const guest = { userPosts: vi.fn(async () => ({ value: { items: ITEMS.slice(0, 2).map((i) => i.tweet), cursor: null }, fetchedAt: NOW, cached: true })) };

    const outcome = await callTool('get_user_posts', { handle: '@NASA' }, context(guest));

    expect(guest.userPosts).toHaveBeenCalledWith('@NASA');
    expect(outcome).toMatchObject({ ok: true, result: { fetchedAt: new Date(NOW).toISOString(), cached: true } });
    expect((outcome as { result: Record<string, any> }).result.posts[0].url).toMatch(/^https:\/\/x\.com\/.+\/status\/\d+$/);
  });

  it('reports a post X does not have as not found, not as an empty post', async () => {
    const guest = { post: vi.fn(async () => ({ value: undefined, fetchedAt: NOW, cached: false })) };

    expect(await callTool('get_post', { id: '20' }, context(guest))).toMatchObject({ ok: true, result: { found: false } });
  });

  it('passes an X failure on as a failed call, with whether to retry', async () => {
    const guest = { topicPosts: vi.fn(async () => Promise.reject(new ApiError(429, 'later', ERROR_CODES.RATE_LIMITED, { retriable: true }))) };

    expect(await callTool('get_topic_posts', { topic: 'Bitcoin' }, context(guest))).toEqual({
      ok: false,
      kind: 'failed',
      message: 'later',
      code: ERROR_CODES.RATE_LIMITED,
      retriable: true,
    });
  });

  it('turns an invalid handle into invalid arguments', async () => {
    const guest = { userPosts: vi.fn(async () => Promise.reject(new ApiError(0, 'bad handle', ERROR_CODES.INVALID_INPUT, { retriable: false }))) };

    expect(await callTool('get_user_posts', { handle: 'not a handle' }, context(guest))).toMatchObject({ ok: false, kind: 'invalid-args' });
  });
});
