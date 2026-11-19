import { describe, expect, it } from 'vitest';
import { asciiToSong, parseAsciiTab } from '@core/import/ascii';
import {
  MIN_TAP_GAP,
  addTap,
  buildSidecar,
  clampBpm,
  composeText,
  computeOnsets,
  firstGroupInBar,
  parsePaste,
  previewFileName,
  restartFromBar,
  suggestSubdivision,
  tapTempoBpm,
  tapTimeline,
  tuningNames,
  ugSearchUrl,
  type RhythmChoice,
} from '../../src/ui/screens/import/model';
import { ARPEGGIO, TRIPLETS, WITH_JUNK } from './tabs';

const snap = (over: Partial<RhythmChoice> = {}): RhythmChoice => ({
  bpm: 120,
  timeSig: [4, 4],
  grid: 8,
  method: 'snap',
  taps: [],
  quantizeTaps: false,
  ...over,
});

describe('parsePaste', () => {
  it('summarises a clean paste: tuning, bars, onsets, staff lines', () => {
    const p = parsePaste(ARPEGGIO);
    expect(p.tab).not.toBeNull();
    expect(p.bars).toBe(2);
    expect(p.onsets).toBe(16);
    expect(p.notes).toBe(16);
    expect(p.tuningLabel).toBe('Standard');
    expect([...p.staffLines]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(p.unparsedLines.size).toBe(0);
    expect(p.warnings).toEqual([]);
  });

  it('reports lines that look like tab but did not parse, with line numbers, sorted', () => {
    const p = parsePaste(WITH_JUNK);
    expect([...p.unparsedLines]).toEqual([11, 12]);
    const lines = p.warnings.map((w) => w.line);
    expect(lines).toContain(12);
    expect([...lines].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(lines);
    expect(p.warnings.find((w) => w.line === 12)?.code).toBe('unparsed-line');
    expect([...p.staffLines]).toEqual([4, 5, 6, 7, 8, 9]);
    expect(p.tab?.header).toMatchObject({ title: 'Test Riff', tempo: 100 });
  });

  it('detects tuning from labels', () => {
    const p = parsePaste(ARPEGGIO.replace(/^E\|/m, 'D|').replace(/^e\|/m, 'e|'));
    expect(p.tuningLabel).toBe('Drop D');
  });

  it('flags text without a staff and empty text', () => {
    expect(parsePaste('').tab).toBeNull();
    const p = parsePaste('just some words\nand more words');
    expect(p.onsets).toBe(0);
    expect(p.warnings.at(-1)).toMatchObject({ severity: 'error', code: 'no-notes' });
  });

  it('imports only the first version of a multi-version text, like asciiToSong', () => {
    const two = `${ARPEGGIO}\nversion 2\n\n${ARPEGGIO.replace(/0/g, '1')}${ARPEGGIO}`;
    const p = parsePaste(two);
    const song = asciiToSong({ fileName: 'x.txt', data: new TextEncoder().encode(two) });
    expect(new Set(song.notes.map((n) => n.time)).size).toBe(p.onsets);
    if (p.versions > 1) expect(p.warnings.some((w) => w.code === 'multiple-versions')).toBe(true);
  });
});

describe('composeText', () => {
  const tab = parseAsciiTab(ARPEGGIO);

  it('returns the text unchanged when nothing differs from the tab', () => {
    expect(composeText(ARPEGGIO, { tuning: tab.tuning, capo: 0 }, tab)).toBe(ARPEGGIO);
  });

  it('prepends header lines the parser reads back (tuning, capo, tempo, time)', () => {
    const text = composeText(ARPEGGIO, { tuning: [64, 59, 55, 50, 45, 38], capo: 2, bpm: 96, timeSig: [3, 4] }, tab);
    expect(text.split('\n').slice(0, 5)).toEqual(['Tuning: D A D G B E', 'Capo: 2', 'Tempo: Q=96', 'Time: 3/4', '']);
    const back = parseAsciiTab(text);
    expect(back.tuning).toEqual([64, 59, 55, 50, 45, 38]);
    expect(back.header).toMatchObject({ capo: 2, tempo: 96, timeSig: [3, 4] });
    expect(back.groups.length).toBe(tab.groups.length);
  });

  it('lets a typed title and artist beat a title-like first line (R2-S-06)', () => {
    const titled = `My Riff\n${ARPEGGIO}`;
    const own = parseAsciiTab(titled);
    expect(own.header.title).toBe('My Riff');
    const text = composeText(titled, { title: 'Review Riff', artist: '' }, own);
    expect(text.split('\n')[0]).toBe('Title: Review Riff');
    const back = parseAsciiTab(text);
    expect(back.header.title).toBe('Review Riff');
    expect(back.groups.length).toBe(own.groups.length);
    // Typed values that match the text, or a text without a title, add nothing (the file name carries them).
    expect(composeText(titled, { title: 'My Riff' }, own)).toBe(titled);
    expect(composeText(ARPEGGIO, { title: 'Anything', artist: 'Someone' }, tab)).toBe(ARPEGGIO);
  });

  it('overrides the tab’s own header values', () => {
    const own = `Tempo: 70\nCapo 3\n\n${ARPEGGIO}`;
    const ownTab = parseAsciiTab(own);
    const back = parseAsciiTab(composeText(own, { bpm: 110, capo: 0 }, ownTab));
    expect(back.header.tempo).toBe(110);
    expect(back.header.capo).toBe(0);
  });

  it('writes tunings low → high', () => {
    expect(tuningNames([62, 57, 55, 50, 45, 38])).toBe('D A D G A D');
  });
});

describe('computeOnsets', () => {
  const groups = parseAsciiTab(ARPEGGIO).groups;

  it('snap: eighths at 120 BPM land every 0.25 s, bar 2 at 2 s', () => {
    const on = computeOnsets(groups, snap());
    expect(on.slice(0, 8)).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75]);
    expect(on[8]).toBe(2);
  });

  it('snap follows BPM and grid', () => {
    const slow = computeOnsets(groups, snap({ bpm: 60 }));
    expect(slow[1]).toBeCloseTo(0.5);
    const sixteenths = computeOnsets(groups, snap({ grid: 16 }));
    expect(sixteenths[1]).toBeCloseTo(0.25);
  });

  it('tap: uses taps, extrapolates the rest at the tapped tempo', () => {
    const taps = [1, 1.5, 2, 2.5];
    const on = computeOnsets(groups, snap({ method: 'tap', taps }));
    expect(on.slice(0, 4)).toEqual(taps);
    expect(on[4]).toBeCloseTo(3, 5);
    expect(on[15]).toBeGreaterThan(on[14]);
  });

  it('tap with fewer than two taps follows the BPM from the first tap', () => {
    expect(computeOnsets(groups, snap({ method: 'tap', taps: [] }))[1]).toBeCloseTo(0.25);
    const one = computeOnsets(groups, snap({ method: 'tap', taps: [0.4] }));
    expect(one[0]).toBeCloseTo(0.4);
    expect(one[1]).toBeCloseTo(0.65);
  });

  it('tap with quantise snaps taps to the grid', () => {
    const on = computeOnsets(groups, snap({ method: 'tap', taps: [0.01, 0.27, 0.49, 0.77], quantizeTaps: true }));
    expect(on.slice(0, 4)).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it('empty tab → no onsets', () => {
    expect(computeOnsets([], snap())).toEqual([]);
  });
});

describe('sidecar → asciiToSong', () => {
  it('a built sidecar applies to the composed text (rhythm aligned, times as computed)', () => {
    const tab = parseAsciiTab(ARPEGGIO);
    const choice = snap({ bpm: 100 });
    const onsets = computeOnsets(tab.groups, choice);
    const sidecar = buildSidecar(onsets, choice, 1234);
    expect(sidecar).toMatchObject({ schema: 1, bpm: 100, timeSig: [4, 4], grid: 8, method: 'snap', savedAt: 1234 });
    const song = asciiToSong({ fileName: 'A - B.txt', data: new TextEncoder().encode(composeText(ARPEGGIO, { bpm: 100 }, tab)), sidecar });
    expect(song.meta.rhythm).toBe('aligned');
    expect([...new Set(song.notes.map((n) => n.time))]).toEqual(sidecar.onsets);
    expect(song.timing.tempos[0].bpm).toBe(100);
  });

  it('rounds onsets to microseconds and clamps negatives', () => {
    expect(buildSidecar([-0.01, 0.123456789], snap(), 0).onsets).toEqual([0, 0.123457]);
  });
});

describe('suggestSubdivision', () => {
  it('eighths for evenly spaced eighths, triplets for triplet spacing, sixteenths otherwise', () => {
    expect(suggestSubdivision(parseAsciiTab(ARPEGGIO).groups, [4, 4])).toBe(8);
    expect(suggestSubdivision(parseAsciiTab(TRIPLETS).groups, [4, 4])).toBe(12);
    expect(suggestSubdivision([], [4, 4])).toBe(16);
  });
});

describe('tap tempo', () => {
  it('averages intervals; needs two taps; a long pause starts over', () => {
    expect(tapTempoBpm([1000])).toBeNull();
    expect(tapTempoBpm([0, 500, 1000, 1500])).toBe(120);
    expect(tapTempoBpm([0, 500, 1000, 5000, 5750])).toBe(80);
    expect(tapTempoBpm([0, 10])).toBe(400);
  });

  it('uses only the last eight intervals', () => {
    const slow = [0, 1000, 2000, 3000];
    const fast = Array.from({ length: 9 }, (_, i) => 3500 + i * 500);
    expect(tapTempoBpm([...slow, ...fast])).toBe(120);
  });

  it('clamps', () => {
    expect(clampBpm(5)).toBe(20);
    expect(clampBpm(1000)).toBe(400);
  });
});

describe('tap-along session', () => {
  const groups = parseAsciiTab(ARPEGGIO).groups;

  it('addTap ignores bounces, extra taps, and clamps count-in taps to 0', () => {
    let taps = addTap([], -0.05, 3);
    expect(taps).toEqual([0]);
    taps = addTap(taps, MIN_TAP_GAP / 2, 3);
    expect(taps).toEqual([0]);
    taps = addTap(addTap(taps, 0.5, 3), 1, 3);
    expect(addTap(taps, 2, 3)).toEqual([0, 0.5, 1]);
  });

  it('restart from a bar keeps earlier taps and starts one bar before the expected onset', () => {
    const taps = Array.from({ length: 10 }, (_, i) => i * 0.25);
    expect(firstGroupInBar(groups, 1)).toBe(8);
    const r = restartFromBar(taps, groups, 1, 120, [4, 4]);
    expect(r.taps).toEqual(taps.slice(0, 8));
    expect(r.from).toBeCloseTo(0);
    const early = restartFromBar(taps.slice(0, 3), groups, 1, 120, [4, 4]);
    expect(early.taps).toHaveLength(3);
    expect(early.from).toBe(0);
  });

  it('restart beyond the taps keeps them all', () => {
    const r = restartFromBar([0, 0.25], groups, 5, 120, [4, 4]);
    expect(r.taps).toEqual([0, 0.25]);
  });

  it('tap timeline covers the expected end plus spare bars with beats', () => {
    const t = tapTimeline([0, 1, 3.9], 120, [4, 4]);
    expect(t.bars).toHaveLength(4);
    expect(t.bars[1]).toEqual({ time: 2, dur: 2, beats: [2, 2.5, 3, 3.5] });
    expect(t.durationSec).toBe(8);
    expect(tapTimeline([], 120, [6, 8]).bars[0].beats).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25]);
  });
});

describe('names and links', () => {
  it('file name mirrors the server', () => {
    expect(previewFileName('Song', 'AC/DC')).toBe('AC-DC - Song.txt');
    expect(previewFileName('  ', '')).toBe('Untitled.txt');
  });

  it('UG link-out search URL', () => {
    expect(ugSearchUrl(' Metallica One ')).toBe('https://www.ultimate-guitar.com/search.php?search_type=title&value=Metallica%20One');
  });
});
