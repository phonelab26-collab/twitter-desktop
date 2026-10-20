import { describe, expect, it, vi } from 'vitest';
import { ApiError, ERROR_CODES, GraphQLClient, type RequestOptions } from '../client';
import { GUEST_PROVIDER_VARIABLES } from '../operations';
import { XService } from '../service';
import type { WebPage, WebSource } from '../web';
import { realBody, realData, realPage, SEARCH_FIXTURE, TRENDING_FIXTURE } from './fixtures';

function serviceReturning(data: unknown) {
  const request = vi.fn(async (_options: RequestOptions) => data);
  const client = { request, rateLimit: {} } as unknown as GraphQLClient;
  return { service: new XService(client), request };
}

/** Awaits a promise that must reject with an ApiError. */
async function apiRejection(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

const lastVariables = (request: ReturnType<typeof vi.fn>) =>
  (request.mock.calls.at(-1)?.[0] as RequestOptions).variables ?? {};

/** An XService whose web source serves one page or REST body; GraphQL is unused. */
function serviceWithWeb(source: { page?: WebPage; rest?: unknown }) {
  const web = {
    page: vi.fn(async (_path: string) => {
      if (!source.page) throw new Error('unexpected page request');
      return source.page;
    }),
    rest: vi.fn(async (_path: string) => source.rest),
  };
  const client = { request: vi.fn(), rateLimit: {} } as unknown as GraphQLClient;
  return { service: new XService(client, web as unknown as WebSource), web };
}

describe('XService.getUserTweets (real x.com profile pages)', () => {
  const elonPage = { status: 200, html: realPage('profile-page.elonmusk') };

  it('fetches the profile page of the normalised handle', async () => {
    const { service, web } = serviceWithWeb({ page: elonPage });

    await service.getUserTweets(' @elonmusk ');

    expect(web.page).toHaveBeenCalledWith('/elonmusk', undefined);
  });

  it('returns the server-rendered posts, pinned first, and no cursor', async () => {
    const { service } = serviceWithWeb({ page: elonPage });

    const page = await service.getUserTweets('elonmusk');

    expect(page.cursor).toBeNull();
    expect(page.items.map((tweet) => [tweet.id, tweet.pinned ?? false])).toEqual([
      ['2112089556615123114', true],
      ['2112219181500281276', false],
      ['2112217914673959115', false],
      ['2112083685872644421', false],
      ['2112080134778069414', false],
    ]);
    expect(page.items.every((tweet) => tweet.author.screenName === 'elonmusk')).toBe(true);
  });

  it('reads a quote of a quote from nested_quoted_tweet_results', async () => {
    const { service } = serviceWithWeb({ page: elonPage });

    const tweet = (await service.getUserTweets('elonmusk')).items.at(-1);

    expect(tweet?.quotedTweet?.author.screenName).toBe('america');
    expect(tweet?.quotedTweet?.quotedTweet?.author.screenName).toBe('ScottPresler');
  });

  it('throws USER_NOT_FOUND on the real 404 page of an unknown handle', async () => {
    const { service } = serviceWithWeb({
      page: { status: 404, html: realPage('profile-page.not-found') },
    });

    const error = await apiRejection(service.getUserTweets('zzqq_nouser_x9'));

    expect(error.code).toBe(ERROR_CODES.USER_NOT_FOUND);
  });

  it('throws UNEXPECTED_SHAPE when a page with data carries no timeline (synthetic)', async () => {
    const withoutTimeline = realPage('profile-page.elonmusk').replace('profile_user_originals_timeline', 'renamed_timeline');
    const { service } = serviceWithWeb({ page: { status: 200, html: withoutTimeline } });

    expect((await apiRejection(service.getUserTweets('jack'))).code).toBe(ERROR_CODES.UNEXPECTED_SHAPE);
  });

  it('throws UNEXPECTED_SHAPE when the page lacks even the streaming framework (format changed)', async () => {
    const { service } = serviceWithWeb({ page: { status: 200, html: '<html>log in</html>' } });

    expect((await apiRejection(service.getUserTweets('jack'))).code).toBe(ERROR_CODES.UNEXPECTED_SHAPE);
  });

  it('throws a retriable PAGE_UNAVAILABLE when the usual page comes without its data', async () => {
    const html = '<html><script data-tsr-stream-part="">self.$_TSR={}</script></html>';
    const { service } = serviceWithWeb({ page: { status: 200, html } });

    const error = await apiRejection(service.getUserTweets('jack'));

    expect(error.code).toBe(ERROR_CODES.PAGE_UNAVAILABLE);
    expect(error.retriable).toBe(true);
  });

  it('rejects an invalid handle before any request', async () => {
    const { service, web } = serviceWithWeb({ page: elonPage });

    expect((await apiRejection(service.getUserTweets('../explore'))).code).toBe(ERROR_CODES.INVALID_INPUT);
    expect((await apiRejection(service.getUserTweets('sixteen_chars_xx'))).code).toBe(ERROR_CODES.INVALID_INPUT);
    expect(web.page).not.toHaveBeenCalled();
  });
});

describe('XService.getTrends / getTrendLocations (real REST bodies)', () => {
  it('asks for the given woeid and returns the parsed list', async () => {
    const { service, web } = serviceWithWeb({ rest: realBody('trends-place.worldwide') });

    const list = await service.getTrends();

    expect(web.rest).toHaveBeenCalledWith('/1.1/trends/place.json?id=1', undefined);
    expect(list.trends).toHaveLength(50);
  });

  it('rejects a woeid that is not a positive integer', async () => {
    const { service, web } = serviceWithWeb({ rest: [] });

    expect((await apiRejection(service.getTrends(1.5))).code).toBe(ERROR_CODES.INVALID_INPUT);
    expect((await apiRejection(service.getTrends(-1))).code).toBe(ERROR_CODES.INVALID_INPUT);
    expect(web.rest).not.toHaveBeenCalled();
  });

  it('returns the places trends exist for', async () => {
    const { service } = serviceWithWeb({ rest: realBody('trends-available') });

    expect(await service.getTrendLocations()).toHaveLength(467);
  });
});

describe('XService.getProfile (real UserByScreenName responses)', () => {
  it('sends exactly the validated variables', async () => {
    const { service, request } = serviceReturning(realData('UserByScreenName'));

    await service.getProfile('elonmusk');

    expect(lastVariables(request)).toEqual({ ...GUEST_PROVIDER_VARIABLES, screenName: 'elonmusk' });
  });

  it('reads the profile under user_result_by_screen_name.result', async () => {
    const { service } = serviceReturning(realData('UserByScreenName'));

    const profile = await service.getProfile('elonmusk');

    expect(profile).toMatchObject({
      id: '44196397',
      screenName: 'elonmusk',
      name: 'Elon Musk',
      description: 'https://t.co/ZdBx5WABYx',
      followersCount: 241523037,
      friendsCount: 1419,
      statusCount: 110524,
      isBlueVerified: true,
      protected: false,
      joinedAt: '2009-06-02T20:12:29.000Z',
    });
  });

  it('leaves absent fields unknown: empty location, no url, no media count', async () => {
    const { service } = serviceReturning(realData('UserByScreenName'));

    const profile = await service.getProfile('elonmusk');

    expect(profile?.location).toBeUndefined();
    expect(profile?.url).toBeUndefined();
    expect(profile?.mediaCount).toBeUndefined();
  });

  it('resolves to undefined for an unknown handle ({"data":{}})', async () => {
    const { service } = serviceReturning(realData('UserByScreenName.not-found'));

    await expect(service.getProfile('zzqq_nouser_x9')).resolves.toBeUndefined();
  });
});

describe('XService.getTweet (real TweetResultByRestId responses)', () => {
  it('sends restId and the required withFocalTweet', async () => {
    const { service, request } = serviceReturning(realData('TweetResultByRestId'));

    await service.getTweet('20');

    expect(lastVariables(request)).toEqual({
      ...GUEST_PROVIDER_VARIABLES,
      restId: '20',
      withFocalTweet: true,
    });
  });

  it('reads the tweet under tweet_result_by_rest_id.result', async () => {
    const { service } = serviceReturning(realData('TweetResultByRestId'));

    const tweet = await service.getTweet('20');

    expect(tweet).toMatchObject({
      id: '20',
      text: 'just setting up my twttr',
      createdAt: '2006-03-21T20:50:14.000Z',
      author: { id: '12', screenName: 'jack', name: 'jack', verified: true },
      replyCount: 18100,
      retweetCount: 124598,
      likeCount: 309189,
      quoteCount: 7323,
      bookmarkCount: 21980,
      lang: 'en',
      isQuote: false,
    });
    expect(tweet?.viewCount).toBeUndefined();
  });

  it('resolves to undefined for an unknown id instead of an empty tweet', async () => {
    const { service } = serviceReturning(realData('TweetResultByRestId.not-found'));

    await expect(service.getTweet('1')).resolves.toBeUndefined();
  });
});

describe('XService.getTrendingPosts (real GlobalTrendingTimelineLoggedOut response)', () => {
  it('sends the required count and timeFilter', async () => {
    const { service, request } = serviceReturning(realData(TRENDING_FIXTURE));

    await service.getTrendingPosts();

    expect(lastVariables(request)).toEqual({
      ...GUEST_PROVIDER_VARIABLES,
      timeFilter: 'Day',
      count: 20,
      cursor: null,
    });
  });

  it('returns the trending posts and no cursor (the guest page ends with a log-in prompt)', async () => {
    const { service } = serviceReturning(realData(TRENDING_FIXTURE));

    const page = await service.getTrendingPosts();

    expect(page.items).toHaveLength(20);
    expect(page.items[0]).toMatchObject({ id: '2112089556615123114', author: { screenName: 'elonmusk' } });
    expect(page.cursor).toBeNull();
  });
});

describe('XService.searchTopic (real GlobalTrendingSearchTimelineLoggedOut responses)', () => {
  it('sends the tag without "#", the required timeFilter and count', async () => {
    const { service, request } = serviceReturning(realData(SEARCH_FIXTURE));

    await service.searchTopic('#SpaceX');

    expect(lastVariables(request)).toEqual({
      ...GUEST_PROVIDER_VARIABLES,
      tag: 'SpaceX',
      timeFilter: 'Day',
      count: 20,
      cursor: null,
    });
  });

  it('returns the tweets of the topic timeline', async () => {
    const { service } = serviceReturning(realData(SEARCH_FIXTURE));

    const page = await service.searchTopic('SpaceX');

    expect(page.items).toHaveLength(20);
    expect(page.cursor).toBeNull();
  });

  it('returns an empty page when X only answers the log-in prompt (unknown tag)', async () => {
    const { service } = serviceReturning(realData(`${SEARCH_FIXTURE}.unknown-tag`));

    await expect(service.searchTopic('zzqqxxnotatag')).resolves.toEqual({ items: [], cursor: null });
  });
});

/*
 * Schema-change guards. These inputs are deliberately malformed: they model no
 * real response, they check that a changed shape throws instead of turning
 * into an empty result.
 */
describe('XService schema-change guards', () => {
  const service = (data: unknown) => serviceReturning(data).service;

  it('getProfile throws when data is non-empty but lacks the root', async () => {
    const { service } = serviceReturning({ renamed_root: {} });

    await expect(service.getProfile('jack')).rejects.toMatchObject({
      code: ERROR_CODES.UNEXPECTED_SHAPE,
    });
  });

  it('getProfile returns undefined rather than a blank profile', async () => {
    const { service } = serviceReturning({ user_result_by_screen_name: {} });

    await expect(service.getProfile('blank')).resolves.toBeUndefined();
  });

  it('getProfile throws on a User it cannot read instead of reporting an unknown handle', async () => {
    const user = structuredClone(realData('UserByScreenName').user_result_by_screen_name);
    delete user.result.core.screen_name;

    await expect(service({ user_result_by_screen_name: user }).getProfile('elonmusk')).rejects.toMatchObject({
      code: ERROR_CODES.UNEXPECTED_SHAPE,
    });
  });

  it('getProfile resolves to undefined for an unavailable user', async () => {
    const data = { user_result_by_screen_name: { result: { __typename: 'UserUnavailable' } } };

    await expect(service(data).getProfile('gone')).resolves.toBeUndefined();
  });

  it('getTweet throws when the root is missing', async () => {
    const { service } = serviceReturning({ renamed_root: {} });

    await expect(service.getTweet('20')).rejects.toMatchObject({ code: ERROR_CODES.UNEXPECTED_SHAPE });
  });

  it('getTrendingPosts throws when the response shape changed', async () => {
    const { service } = serviceReturning({ something_else: {} });

    await expect(service.getTrendingPosts()).rejects.toMatchObject({
      code: ERROR_CODES.UNEXPECTED_SHAPE,
    });
  });

  it('getTrendingPosts throws when the timeline has no instructions', async () => {
    const { service } = serviceReturning({ global_trending_timeline_logged_out: { timeline: {} } });

    await expect(service.getTrendingPosts()).rejects.toMatchObject({
      code: ERROR_CODES.UNEXPECTED_SHAPE,
    });
  });

  it('searchTopic throws when a tweet entry no longer parses, instead of an empty page', async () => {
    const data = structuredClone(realData(SEARCH_FIXTURE));
    const entries = data.global_trending_search_timeline_logged_out.timeline.instructions[1].entries;
    entries[0].content.content.tweet_results.result.__typename = 'TweetV2';

    await expect(service(data).searchTopic('SpaceX')).rejects.toMatchObject({
      code: ERROR_CODES.UNEXPECTED_SHAPE,
    });
  });

  it('getTweet resolves to undefined for an unavailable tweet but throws on an unknown result', async () => {
    const root = (result: unknown) => ({ tweet_result_by_rest_id: { rest_id: '1', result } });

    await expect(service(root({ __typename: 'TweetUnavailable' })).getTweet('1')).resolves.toBeUndefined();
    await expect(service(root({ __typename: 'TweetV2' })).getTweet('1')).rejects.toMatchObject({
      code: ERROR_CODES.UNEXPECTED_SHAPE,
    });
  });

  it('searchTopic throws when the timeline has no instructions', async () => {
    const { service } = serviceReturning({ global_trending_search_timeline_logged_out: { timeline: {} } });

    await expect(service.searchTopic('x')).rejects.toMatchObject({ code: ERROR_CODES.UNEXPECTED_SHAPE });
  });
});

describe('XService over a real GraphQLClient: partial GraphQL errors', () => {
  const PARTIAL = { data: {}, errors: [{ message: 'Internal error', code: 0, path: ['user_result_by_screen_name'] }] };

  function serviceOverHttp(body: unknown): XService {
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).includes('/guest/activate.json')
        ? Response.json({ guest_token: 'gt-1' })
        : Response.json(body)) as unknown as typeof fetch;
    return new XService(new GraphQLClient({ fetch: fetchImpl, loadRegistry: async () => ({}), sleep: async () => {} }));
  }

  it('does not read {"data":{},"errors":[...]} as an unknown handle', async () => {
    const error = await apiRejection(serviceOverHttp(PARTIAL).getProfile('jack'));

    expect(error.code).toBe(ERROR_CODES.PARTIAL_RESPONSE);
    expect(error.graphqlErrors?.[0]?.message).toBe('Internal error');
  });

  it('still resolves an unknown handle to undefined when there are no errors (real capture)', async () => {
    const body = { data: realData('UserByScreenName.not-found') };

    await expect(serviceOverHttp(body).getProfile('zzqq_nouser_x9')).resolves.toBeUndefined();
  });
});
