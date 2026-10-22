import { describe, expect, it, vi } from 'vitest';
import { ApiError, ERROR_CODES } from '../../api/client';
import type { TrendLocation } from '../../../shared/types';
import { AGENT_TRENDS_BUDGET, GuestGateway, type GuestApi } from '../guest';

const place = (woeid: number): TrendLocation => ({ woeid, name: `P${woeid}`, kind: 'Country' });

function fakeService(): GuestApi {
  return {
    getProfile: vi.fn(async (handle: string) => ({ id: '1', screenName: handle })),
    getUserTweets: vi.fn(async () => ({ items: [], cursor: null })),
    getTweet: vi.fn(async () => undefined),
    getTrendingPosts: vi.fn(async () => ({ items: [], cursor: null })),
    searchTopic: vi.fn(async () => ({ items: [], cursor: null })),
    getTrends: vi.fn(async (woeid: number) => ({ asOf: 'now', location: { name: 'x', woeid }, trends: [] })),
    getTrendLocations: vi.fn(async () => Array.from({ length: 8 }, (_, i) => place(i + 1))),
  };
}

describe('GuestGateway', () => {
  it('answers a repeated question from its cache, and says when', async () => {
    let now = 1_000;
    const service = fakeService();
    const gateway = new GuestGateway(service, () => now);

    const first = await gateway.userPosts('NASA');
    now += 1_000;
    const second = await gateway.userPosts('nasa');

    expect(service.getUserTweets).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ cached: false, fetchedAt: 1_000 });
    expect(second).toMatchObject({ cached: true, fetchedAt: 1_000 });
  });

  it('stops at its own budget instead of using up X\'s quota for the app', async () => {
    const service = fakeService();
    const gateway = new GuestGateway(service);

    // Different places: each one is a real call, none comes from the cache.
    for (let woeid = 1; woeid <= AGENT_TRENDS_BUDGET.max; woeid++) await gateway.trends(woeid);

    await expect(gateway.trends(AGENT_TRENDS_BUDGET.max + 1)).rejects.toMatchObject({ code: ERROR_CODES.RATE_LIMITED, retriable: true });
    expect(service.getTrends).toHaveBeenCalledTimes(AGENT_TRENDS_BUDGET.max);
  });

  it('only asks X for the trends of a place X lists', async () => {
    const service = fakeService();
    const gateway = new GuestGateway(service);

    await expect(gateway.trends(999)).rejects.toMatchObject({ code: ERROR_CODES.INVALID_INPUT });
    expect(service.getTrends).not.toHaveBeenCalled();
  });

  it('never caches a failure', async () => {
    const service = fakeService();
    vi.mocked(service.searchTopic).mockRejectedValueOnce(new ApiError(503, 'down', ERROR_CODES.HTTP_ERROR));
    const gateway = new GuestGateway(service);

    await expect(gateway.topicPosts('Bitcoin')).rejects.toBeInstanceOf(ApiError);
    await expect(gateway.topicPosts('Bitcoin')).resolves.toMatchObject({ cached: false });
    expect(service.searchTopic).toHaveBeenCalledTimes(2);
  });
});
