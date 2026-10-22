import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureTarget, classifyTimelinePath, graphqlOperation, readCapture } from '../capture';

const FIXTURES = join(__dirname, '..', '..', 'api', '__fixtures__');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

const response = (url: string, extra: Partial<{ type: string; status: number; mimeType: string }> = {}) => ({
  url,
  type: 'Fetch',
  status: 200,
  mimeType: 'application/json',
  ...extra,
});

describe('graphqlOperation', () => {
  it('reads the operation name of an X GraphQL url', () => {
    expect(graphqlOperation('https://x.com/i/api/graphql/abc_-123/HomeTimeline?variables=%7B%7D')).toBe('HomeTimeline');
    expect(graphqlOperation('https://api.x.com/graphql/65vLZc4n6GXaOs_GVYqU1g/GlobalTrendingTimelineLoggedOut')).toBe(
      'GlobalTrendingTimelineLoggedOut',
    );
  });

  it('ignores other hosts, http and non-GraphQL paths', () => {
    for (const url of [
      'https://evil.example/i/api/graphql/abc/HomeTimeline',
      'https://x.com.evil.example/i/api/graphql/abc/HomeTimeline',
      'http://x.com/i/api/graphql/abc/HomeTimeline',
      'https://x.com/home',
      'not a url',
    ]) {
      expect(graphqlOperation(url)).toBeUndefined();
    }
  });
});

describe('captureTarget', () => {
  it('captures the timelines of the feed, searches, lists and profiles', () => {
    expect(captureTarget(response('https://x.com/i/api/graphql/a/HomeLatestTimeline'))).toEqual({
      kind: 'json',
      operation: 'HomeLatestTimeline',
      source: 'home',
    });
    expect(captureTarget(response('https://x.com/i/api/graphql/a/SearchTimeline'))).toMatchObject({ source: 'search' });
    expect(captureTarget(response('https://api.x.com/graphql/a/listTweetsQuery'))).toMatchObject({ source: 'list' });
  });

  it('leaves personal timelines out and says so', () => {
    for (const operation of ['Bookmarks', 'bookmarksQuery', 'Likes', 'likesQuery', 'notificationsQuery']) {
      expect(captureTarget(response(`https://x.com/i/api/graphql/a/${operation}`))).toEqual({ kind: 'personal', operation });
    }
  });

  it('reports a feed it does not know (a renamed one) instead of reading or hiding it', () => {
    // genericTimelineQuery pages any timeline by an opaque id, likes and bookmarks included: never read.
    for (const operation of ['HomeTimelineV2', 'genericTimelineQuery']) {
      expect(captureTarget(response(`https://x.com/i/api/graphql/a/${operation}`))).toEqual({ kind: 'unrecognised', operation });
    }
    expect(captureTarget(response('https://x.com/i/api/graphql/a/Viewer'))).toBeUndefined();
  });

  it('reports a captured operation in a format it cannot read', () => {
    const multipart = response('https://x.com/i/api/graphql/a/HomeTimeline', { mimeType: 'multipart/mixed' });
    expect(captureTarget(multipart)).toEqual({ kind: 'unsupported', operation: 'HomeTimeline' });
  });

  it('reads x.com pages (server-rendered results), nothing else', () => {
    expect(captureTarget(response('https://x.com/NASA', { type: 'Document', mimeType: 'text/html' }))).toEqual({ kind: 'page' });
    for (const page of ['https://x.com/home', 'https://x.com/search?q=%24TSLA', 'https://x.com/NASA/status/2112553116390269175']) {
      expect(captureTarget(response(page, { type: 'Document', mimeType: 'text/html' }))).toEqual({ kind: 'page' });
    }
    // Only feed pages: never notifications, messages, settings, likes, internal pages...
    for (const page of [
      'https://x.com/notifications',
      'https://x.com/messages',
      'https://x.com/settings/account',
      'https://x.com/NASA/likes',
      'https://x.com/i/bookmarks',
      'https://x.com/i/jf/onboarding/web',
    ]) {
      expect(captureTarget(response(page, { type: 'Document', mimeType: 'text/html' }))).toBeUndefined();
    }
    expect(captureTarget(response('https://evil.example/NASA', { type: 'Document', mimeType: 'text/html' }))).toBeUndefined();
    expect(captureTarget(response('https://pbs.twimg.com/media/a.jpg', { type: 'Image', mimeType: 'image/jpeg' }))).toBeUndefined();
    expect(captureTarget(response('https://x.com/i/api/graphql/a/HomeTimeline', { status: 429 }))).toBeUndefined();
  });
});

describe('readCapture', () => {
  it('reads the posts of a real GraphQL timeline response', () => {
    const target = { kind: 'json', operation: 'GlobalTrendingTimelineLoggedOut', source: 'trending' } as const;

    const reading = readCapture(target, fixture('GlobalTrendingTimelineLoggedOut.real.json'));

    expect(reading.error).toBeUndefined();
    expect(reading.batches).toHaveLength(1);
    expect(reading.batches[0]).toMatchObject({ operation: 'GlobalTrendingTimelineLoggedOut', source: 'trending', unreadable: 0 });
    expect(reading.batches[0].items).toHaveLength(20);
  });

  it('reads the timeline x.com server-renders into a real profile page', () => {
    const reading = readCapture({ kind: 'page' }, fixture('profile-page.elonmusk.real.html'));

    expect(reading.error).toBeUndefined();
    const profile = reading.batches.find((batch) => batch.operation === 'UserOriginalsTimeline');
    expect(profile?.source).toBe('profile');
    expect(profile?.items.length).toBeGreaterThan(0);
    expect(profile?.items.some((item) => item.pinned)).toBe(true);
  });

  it('still reads a real profile page after X rotated its relay ids', () => {
    // Live pages carry ids the bundled snapshot does not know (seen 2026-10-22: QEZVpYuKRU9V5jj86lkkNw...).
    const rotated = fixture('profile-page.elonmusk.real.html').replaceAll('dm5QEQ6Zg_QrdzrCDhMN6w', 'QEZVpYuKRU9V5jj86lkkNw');

    const reading = readCapture({ kind: 'page' }, rotated);

    expect(reading.error).toBeUndefined();
    const profile = reading.batches.find((batch) => batch.source === 'profile');
    expect(profile?.operation).toBe('page:profile_user_originals_timeline');
    expect(profile?.items.length).toBeGreaterThan(0);
  });

  it('finds nothing, and no error, on a real page without posts', () => {
    expect(readCapture({ kind: 'page' }, fixture('profile-page.not-found.real.html'))).toEqual({ batches: [], personal: [], unrecognised: [] });
  });

  it('reports a server-rendered timeline under a key it does not know', () => {
    const value = JSON.stringify(JSON.stringify({ data: { weird_feed: { instructions: [] } } }));
    const html = `<script>{kind:"GraphQLRequestStream.Completed",requestId:1,key:"AAAAAAAAAAAAAAAAAAAAAA{}",result:$R[1]={kind:"Result.Ok",value:${value}}}</script>`;

    expect(readCapture({ kind: 'page' }, html)).toEqual({ batches: [], personal: [], unrecognised: ['page:weird_feed'] });
  });

  it('reports a body that is not JSON instead of skipping it', () => {
    const reading = readCapture({ kind: 'json', operation: 'HomeTimeline', source: 'home' }, '<html>');

    expect(reading.batches).toEqual([]);
    expect(reading.error).toMatch(/not JSON/);
  });

  it('reports a captured response that carries no timeline', () => {
    const reading = readCapture({ kind: 'json', operation: 'HomeTimeline', source: 'home' }, '{"data":{"home":{}}}');

    expect(reading.error).toMatch(/no timeline/);
  });

  it('stops walking a hostile, deeply nested body', () => {
    let deep: Record<string, unknown> = { instructions: [] };
    for (let i = 0; i < 200; i++) deep = { next: deep };

    const reading = readCapture({ kind: 'json', operation: 'HomeTimeline', source: 'home' }, JSON.stringify(deep));

    expect(reading.error).toMatch(/too deep|no timeline/);
  });
});

describe('classifyTimelinePath', () => {
  it('names the feed from the response keys that lead to it', () => {
    expect(classifyTimelinePath(['data', 'home', 'home_timeline_urt'])).toEqual({ source: 'home', label: 'home_timeline_urt', personal: false });
    expect(classifyTimelinePath(['data', 'search_by_raw_query', 'search_timeline', 'timeline'])).toMatchObject({ source: 'search' });
    expect(classifyTimelinePath(['data', 'threaded_conversation_with_injections_v2'])).toMatchObject({ source: 'post' });
    expect(classifyTimelinePath(['data', 'user_result_by_screen_name', 'result', 'profile_user_originals_timeline', 'timeline'])).toMatchObject({
      source: 'profile',
    });
  });

  it('reads only the server-rendered feeds it knows, never one it would have to guess', () => {
    for (const path of [
      ['data', 'list', 'tweets_timeline', 'timeline'],
      ['data', 'user', 'result', 'profile_user_media_timeline', 'timeline'],
    ]) {
      expect(classifyTimelinePath(path)).toMatchObject({ source: undefined, personal: false });
    }
    expect(classifyTimelinePath(['data', 'user', 'result', 'profile_user_liked_timeline', 'timeline'])).toMatchObject({ source: undefined, personal: true });
  });

  it('leaves personal timelines out, wherever their key is', () => {
    for (const path of [
      ['data', 'bookmark_timeline_v2', 'timeline'],
      ['data', 'user', 'result', 'profile_likes_timeline', 'timeline'],
      ['data', 'viewer', 'notifications_timeline'],
      ['data', 'home', 'favorites_timeline'],
    ]) {
      expect(classifyTimelinePath(path)).toMatchObject({ source: undefined, personal: true });
    }
  });

  it('leaves a timeline it cannot name out, instead of guessing', () => {
    expect(classifyTimelinePath(['data', 'foo', 'bar'])).toEqual({ source: undefined, label: 'foo.bar', personal: false });
  });
});
