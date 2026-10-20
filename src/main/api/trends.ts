/**
 * Parsers for the legacy REST trends endpoints, the only guest source of trend
 * names (docs/HANDOFF.md §6). Shapes checked against
 * __fixtures__/trends-place.worldwide.real.json and trends-available.real.json.
 *
 * A response that does not have the expected shape throws: an empty trend
 * list is only ever what X sent.
 */
import { ApiError, ERROR_CODES } from './client';
import { asRecord } from './parsers';
import type { Trend, TrendList, TrendLocation } from '../../shared/types';

function unexpected(path: string, detail: string): ApiError {
  return new ApiError(200, `${path}: ${detail}; the X schema probably changed.`, ERROR_CODES.UNEXPECTED_SHAPE, {
    retriable: false,
  });
}

function parseTrend(node: unknown, path: string): Trend {
  const trend = asRecord(node);
  if (typeof trend?.name !== 'string' || !trend.name || typeof trend.url !== 'string') {
    throw unexpected(path, 'a trend has no name or url');
  }
  // null in every real capture; a missing field must not make an ad read as organic.
  if (!('promoted_content' in trend)) throw unexpected(path, 'a trend has no promoted_content field');
  return {
    name: trend.name,
    url: trend.url,
    postCount: typeof trend.tweet_volume === 'number' ? trend.tweet_volume : undefined,
    promoted: Boolean(trend.promoted_content),
  };
}

/** `1.1/trends/place.json`: a one-element array `{trends, as_of, locations}`. */
export function parseTrendPlace(body: unknown, path: string): TrendList {
  const place = Array.isArray(body) && body.length === 1 ? asRecord(body[0]) : undefined;
  if (!place) throw unexpected(path, 'expected a one-element array');
  const location = asRecord(Array.isArray(place.locations) ? place.locations[0] : undefined);
  if (!Array.isArray(place.trends)) throw unexpected(path, 'no trends array');
  if (typeof place.as_of !== 'string') throw unexpected(path, 'no as_of');
  if (typeof location?.name !== 'string' || typeof location.woeid !== 'number') {
    throw unexpected(path, 'no location');
  }
  return {
    asOf: place.as_of,
    location: { name: location.name, woeid: location.woeid },
    trends: place.trends.map((trend) => parseTrend(trend, path)),
  };
}

/** `1.1/trends/available.json`: an array of places. */
export function parseTrendLocations(body: unknown, path: string): TrendLocation[] {
  if (!Array.isArray(body)) throw unexpected(path, 'expected an array');
  return body.map((node) => {
    const place = asRecord(node);
    const kind = asRecord(place?.placeType)?.name;
    if (typeof place?.woeid !== 'number' || typeof place.name !== 'string' || typeof kind !== 'string') {
      throw unexpected(path, 'a place has no woeid, name or placeType');
    }
    return {
      woeid: place.woeid,
      name: place.name,
      kind,
      country: typeof place.country === 'string' && place.country ? place.country : undefined,
      countryCode: typeof place.countryCode === 'string' ? place.countryCode : undefined,
      parentWoeid: typeof place.parentid === 'number' && place.parentid > 0 ? place.parentid : undefined,
    };
  });
}
