import { describe, expect, it } from 'vitest';
import { ApiError, ERROR_CODES } from '../client';
import { extractSsrResults } from '../ssr';
import { realPage } from './fixtures';

describe('extractSsrResults (real x.com pages)', () => {
  it('returns every server-rendered GraphQL result of a profile page, in order', () => {
    const results = extractSsrResults(realPage('profile-page.elonmusk'));

    expect(results.map((result) => result.relayId)).toEqual([
      'nbvL57CsECD0Vmj_4CgeLA', // UserByScreenName
      'dm5QEQ6Zg_QrdzrCDhMN6w', // UserOriginalsTimeline
    ]);
    expect(results[1].variables).toMatchObject({ screenName: 'elonmusk', count: 20, cursor: null });
    expect(results[1].response.data).toHaveProperty(
      'user_result_by_screen_name.result.profile_user_originals_timeline.timeline.instructions',
    );
  });

  it('reads the empty UserByScreenName result of an unknown handle page', () => {
    const results = extractSsrResults(realPage('profile-page.not-found'));

    expect(results).toHaveLength(1);
    expect(results[0].response).toEqual({ data: {} });
  });

  it('returns [] for a page that carries no rendered data', () => {
    expect(extractSsrResults('<!DOCTYPE html><html><body>login</body></html>')).toEqual([]);
  });
});

describe('extractSsrResults on damaged pages (synthetic)', () => {
  const page = realPage('profile-page.elonmusk');
  const failure = (html: string) => {
    try {
      extractSsrResults(html);
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it('throws BAD_RESPONSE on a truncated page instead of dropping the result', () => {
    const cut = page.slice(0, page.indexOf('profile_user_originals_timeline') + 100);

    const error = failure(cut);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(ERROR_CODES.BAD_RESPONSE);
  });

  it('decodes the \\x3C escape seroval uses for "<" (a bio such as "I <3 X")', () => {
    // In the page source the name sits in a JSON string inside a JS string: \"name\":\"...\".
    const marked = page.replace('\\"name\\":\\"Elon Musk\\"', '\\"name\\":\\"I \\x3C3 X\\"');
    expect(marked).not.toBe(page);

    const user = extractSsrResults(marked)[0].response.data as Record<string, any>;

    expect(user.user_result_by_screen_name.result.core.name).toBe('I <3 X');
  });

  it('throws when a completed request did not end in Result.Ok', () => {
    const error = failure(page.replace('kind:"Result.Ok"', 'kind:"Result.Error"'));

    expect((error as ApiError).code).toBe(ERROR_CODES.BAD_RESPONSE);
  });
});
