import { describe, expect, it } from 'vitest';
import { createRemoteCache } from '../remoteCache';

describe('createRemoteCache', () => {
  it('serves a value until its ttl has passed, then forgets it', () => {
    let now = 0;
    const cache = createRemoteCache<string>(1000, () => now);

    cache.set('a', 'one');
    now = 999;
    expect(cache.get('a')).toBe('one');
    now = 1000;
    expect(cache.get('a')).toBeUndefined();
  });

  it('returns undefined for an unknown key, not an empty value', () => {
    expect(createRemoteCache<string>(1000).get('nope')).toBeUndefined();
  });

  it('delete drops one key (a manual reload must refetch)', () => {
    const cache = createRemoteCache<string>(1000, () => 0);
    cache.set('a', 'one');
    cache.set('b', 'two');

    cache.delete('a');

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('two');
  });

  it('keeps memory bounded by dropping the oldest entries', () => {
    const cache = createRemoteCache<number>(1000, () => 0, 2);

    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });
});
