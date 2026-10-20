import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../client';
import { parseTrendLocations, parseTrendPlace } from '../trends';
import { realBody } from './fixtures';

const PLACE_PATH = '/1.1/trends/place.json?id=1';

describe('parseTrendPlace (real 1.1/trends/place.json)', () => {
  it('reads the worldwide list with its date and location', () => {
    const list = parseTrendPlace(realBody('trends-place.worldwide'), PLACE_PATH);

    expect(list.asOf).toBe('2026-10-20T00:27:36Z');
    expect(list.location).toEqual({ name: 'Worldwide', woeid: 1 });
    expect(list.trends).toHaveLength(50);
    expect(list.trends[0]).toEqual({
      name: '#ShowDoLulaNoSbt',
      url: 'http://twitter.com/search?q=%23ShowDoLulaNoSbt',
      postCount: undefined,
      promoted: false,
    });
  });

  it('leaves the post count unknown when X sends tweet_volume: null', () => {
    const list = parseTrendPlace(realBody('trends-place.worldwide'), PLACE_PATH);

    expect(list.trends.every((trend) => trend.postCount === undefined)).toBe(true);
  });

  it('throws on a changed shape instead of returning no trends (synthetic)', () => {
    expect(() => parseTrendPlace({ trends: [] }, PLACE_PATH)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.UNEXPECTED_SHAPE }),
    );
    expect(() => parseTrendPlace([{ as_of: 'x', locations: [{ name: 'W', woeid: 1 }], trends: [{}] }], PLACE_PATH)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.UNEXPECTED_SHAPE }),
    );
  });
});

describe('parseTrendLocations (real 1.1/trends/available.json)', () => {
  it('reads every place with its kind and parent', () => {
    const places = parseTrendLocations(realBody('trends-available'), '/1.1/trends/available.json');

    expect(places).toHaveLength(467);
    expect(places[0]).toEqual({
      woeid: 1,
      name: 'Worldwide',
      kind: 'Supername',
      country: undefined,
      countryCode: undefined,
      parentWoeid: undefined,
    });
    expect(places.find((place) => place.name === 'Paris')).toEqual({
      woeid: 615702,
      name: 'Paris',
      kind: 'Town',
      country: 'France',
      countryCode: 'FR',
      parentWoeid: 23424819,
    });
  });
});
