/**
 * The generic, format-independent parts of `server/sources/songsterr/map.ts`. The response mapping
 * itself is the owner's (docs/guides/songsterr-search.md § 3d) and gets its own `map.test.ts` with
 * fixtures the owner records.
 */
import { describe, expect, it } from 'vitest';
import { mapSearchResponse, tuningFields } from '../../server/sources/songsterr/map';

describe('remote search mapping: generic parts', () => {
  it('tuning fields come from the first 6-string tuning via describeTuning', () => {
    expect(tuningFields([{}, { tuning: [64, 59, 55, 50, 45, 38] }])).toEqual({ tuning: [64, 59, 55, 50, 45, 38], tuningId: 'drop-d', tuningLabel: 'Drop D' });
    expect(tuningFields([{ tuning: [43, 38, 33, 28] }])).toEqual({});
    expect(tuningFields([])).toEqual({});
  });

  it('never throws on odd input', () => {
    for (const odd of [null, undefined, 42, 'x', {}, [null, 1, 'x', {}]]) expect(() => mapSearchResponse(odd)).not.toThrow();
    expect(mapSearchResponse({})).toEqual([]);
  });
});
