import { describe, expect, it } from 'vitest';
import { DEFAULT_QUERY, hasFilters, queryFromParams, queryToParams, sameQuery, toSearchQuery, type LibraryQuery } from '../../src/ui/screens/library/query';

describe('library query state', () => {
  it('parses every route param', () => {
    expect(
      queryFromParams({ q: 'iron', source: 'local,starter', tierMin: '2', tierMax: '5', tuning: 'drop-d', playable: 'true', tags: 'fingerstyle,Bends' }),
    ).toEqual({ q: 'iron', sources: ['local', 'starter'], tierMin: 2, tierMax: 5, tuning: 'drop-d', playable: 'playable', technique: 'fingerstyle', tags: ['bends'] });
    expect(queryFromParams({ playable: 'false' }).playable).toBe('needs-work');
  });

  it('is lenient with hand-edited URLs', () => {
    const q = queryFromParams({ source: 'local,bogus', tierMin: '0', tierMax: 'x', playable: 'maybe', tags: 'pick,,pick' });
    expect(q).toEqual({ ...DEFAULT_QUERY, sources: ['local'], technique: 'pick' });
    expect(queryFromParams({ tierMin: '8', tierMax: '3' })).toMatchObject({ tierMin: 3, tierMax: 8 });
  });

  it('round-trips through route params and omits defaults', () => {
    expect(queryToParams(DEFAULT_QUERY)).toEqual({});
    const q: LibraryQuery = { q: ' sandman ', sources: ['classtab'], tierMin: 1, tierMax: 4, tuning: 'standard', playable: 'needs-work', technique: 'pick', tags: ['metal'] };
    const params = queryToParams(q);
    expect(params).toEqual({ q: 'sandman', source: 'classtab', tierMax: '4', tuning: 'standard', playable: 'false', tags: 'pick,metal' });
    expect(queryFromParams(params)).toEqual({ ...q, q: 'sandman' });
  });

  it('maps to the search API query (no tier filter at 1–10, so unrated songs stay)', () => {
    expect(toSearchQuery(DEFAULT_QUERY, 50)).toEqual({ limit: 50 });
    expect(toSearchQuery({ ...DEFAULT_QUERY, q: ' x ', tierMin: 2, playable: 'playable', technique: 'fingerstyle', tags: ['bends'] }, 10)).toEqual({
      limit: 10,
      q: 'x',
      tierMin: 2,
      playable: true,
      tags: ['fingerstyle', 'bends'],
    });
  });

  it('knows when filters are active and compares queries', () => {
    expect(hasFilters(DEFAULT_QUERY)).toBe(false);
    expect(hasFilters({ ...DEFAULT_QUERY, q: 'only text' })).toBe(false);
    expect(hasFilters({ ...DEFAULT_QUERY, tierMax: 9 })).toBe(true);
    expect(hasFilters({ ...DEFAULT_QUERY, technique: 'pick' })).toBe(true);
    expect(sameQuery({ ...DEFAULT_QUERY, q: 'a ' }, { ...DEFAULT_QUERY, q: 'a' })).toBe(true);
    expect(sameQuery(DEFAULT_QUERY, { ...DEFAULT_QUERY, sources: ['local'] })).toBe(false);
  });
});
