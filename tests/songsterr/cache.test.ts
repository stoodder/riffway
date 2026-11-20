import { describe, expect, it } from 'vitest';
import type { RemoteSearchHit } from '@shared/sources';
import { cacheKey, createSearchCache } from '../../server/sources/songsterr/cache';

const hit = (title: string): RemoteSearchHit => ({ source: 'songsterr', remoteId: title, title, url: `https://fixtures.invalid/${title}`, tracks: [] });

describe('remote search cache', () => {
  it('hits and misses', () => {
    const cache = createSearchCache();
    expect(cache.get('fixture riff')).toBeUndefined();
    cache.set('fixture riff', [hit('a')]);
    expect(cache.get('fixture riff')).toEqual([hit('a')]);
    expect(cache.get('other')).toBeUndefined();
  });

  it('keys ignore case and spacing', () => {
    expect(cacheKey('  Fixture   RIFF ')).toBe('fixture riff');
    const cache = createSearchCache();
    cache.set('Fixture Riff', [hit('a')]);
    expect(cache.get('  fixture   riff')).toEqual([hit('a')]);
  });

  it('expires entries after the TTL', () => {
    let t = 0;
    const cache = createSearchCache(10, 1000, () => t);
    cache.set('q', [hit('a')]);
    t = 1000;
    expect(cache.get('q')).toEqual([hit('a')]);
    t = 1001;
    expect(cache.get('q')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used entry at max', () => {
    const cache = createSearchCache(2);
    cache.set('a', [hit('a')]);
    cache.set('b', [hit('b')]);
    cache.get('a'); // a is now the most recent
    cache.set('c', [hit('c')]);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual([hit('a')]);
    expect(cache.get('c')).toEqual([hit('c')]);
    expect(cache.size).toBe(2);
  });
});
