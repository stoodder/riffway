/**
 * Game (T-031/T-032) in keyboard mode (D6):
 * - a whole starter song scripted through the `?e2e=1` test hook, with exact Perfect / WrongNote
 *   (Shift-style wrong pitch) / Miss counts on the results screen (screenshots `game-mid-song`,
 *   `results`);
 * - a real-keypress smoke (keys 6 and Shift+6 at the right moments);
 * - practice at 70% with a one-bar A/B loop that wraps twice (screenshot `practice-loop`).
 */
import type { Page } from '@playwright/test';
import {
  expect,
  hookState,
  inject,
  judgements,
  openApp,
  pressPlay,
  sessionNotes,
  shot,
  test,
  waitForSession,
  waitForSongTime,
} from './support/test';

const PENTATONIC = 'starter:pentatonic-box-lick';
const OPEN_STRINGS = 'starter:open-strings-first-frets';

const playPath = (id: string, query: string): string => `/play/${encodeURIComponent(id)}?${query}`;

/** Count of each outcome tile on the results screen. */
async function resultTiles(page: Page): Promise<Record<string, number>> {
  const notes = page.getByRole('region', { name: 'Notes' });
  await expect(notes).toBeVisible();
  const out: Record<string, number> = {};
  for (const label of ['Perfect', 'Great', 'Good', 'Wrong', 'Miss']) {
    const tile = notes.locator('.rs-count').filter({ hasText: new RegExp(`^\\d+\\s*${label}$`) });
    out[label] = Number(await tile.locator('.rs-count__value').textContent());
  }
  return out;
}

test('scripted starter song: exact Perfect / WrongNote / Miss counts on results', async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, playPath(PENTATONIC, 'mode=play'));
  await waitForSession(page);
  const notes = await sessionNotes(page);
  expect(notes.length).toBeGreaterThan(60);

  // Wrong pitch on three single notes and silence on four others; every other note dead on time.
  const singles = notes.filter((n) => n.chord === null);
  const wrong = new Set([singles[2], singles[9], singles[30]].map((n) => n?.id));
  const missed = new Set([singles[5], singles[6], singles[20], singles[41]].map((n) => n?.id));
  expect(wrong.size + missed.size).toBe(7);
  await inject(
    page,
    notes.filter((n) => !missed.has(n.id)).map((n) => ({ lane: n.lane, songTime: n.songTime, wrongPitch: wrong.has(n.id) })),
  );
  await pressPlay(page);

  // Mid-song: the Bend Lick (bends, vibrato, hammer-ons) at the 5th-fret box, a hit just landed.
  const bendLick = notes.find((n) => n.songTime > 11 && n.chord === null);
  if (!bendLick) throw new Error('no note after 11 s');
  await waitForSongTime(page, bendLick.songTime + 0.05, 30_000);
  await shot(page, 'game-mid-song');
  const mid = await hookState(page);
  expect(mid.session?.state).toBe('playing');
  expect(mid.session?.judge.counts.Perfect).toBeGreaterThan(5);

  // The run ends by itself after the last note and the results screen opens.
  await expect(page).toHaveURL(/#\/results\//, { timeout: 60_000 });
  await expect(page.getByRole('heading', { level: 1, name: /Pentatonic Box Lick/ })).toBeVisible();
  const tiles = await resultTiles(page);
  expect(tiles).toEqual({ Perfect: notes.length - 7, Great: 0, Good: 0, Wrong: 3, Miss: 4 });

  const final = await judgements(page);
  expect(final.flatMap((j) => j.noteIds)).toHaveLength(notes.length);
  const ids = (outcome: string): number[] => final.filter((j) => j.outcome === outcome).flatMap((j) => j.noteIds).sort((a, b) => a - b);
  expect(ids('WrongNote')).toEqual([...wrong].sort((a, b) => (a ?? 0) - (b ?? 0)));
  expect(ids('Miss')).toEqual([...missed].sort((a, b) => (a ?? 0) - (b ?? 0)));
  await shot(page, 'results');
});

test('real keypresses: lane key hits, Shift + lane key is a wrong note', async ({ page }) => {
  await openApp(page, playPath(OPEN_STRINGS, 'mode=play'));
  await waitForSession(page);
  const notes = await sessionNotes(page);
  // The song opens with four low-E (string 6, key 6) quarter notes.
  const [n0, n1, n2] = notes;
  for (const n of [n0, n1, n2]) expect(n?.lane).toBe(6);
  await page.keyboard.press('Space');
  await expect(page.getByRole('dialog', { name: 'Ready to play' })).toBeHidden();

  // Press slightly before each note: key → page latency is a few ms, well inside Great (±70 ms).
  for (const [note, shift] of [[n0, false], [n1, false], [n2, true]] as const) {
    await waitForSongTime(page, (note?.songTime ?? 0) - 0.012);
    await page.keyboard.press(shift ? 'Shift+Digit6' : 'Digit6');
  }
  await expect.poll(async () => (await hookState(page)).session?.judge.judgedNotes, { timeout: 5000 }).toBeGreaterThanOrEqual(3);
  const counts = (await hookState(page)).session?.judge.counts;
  expect((counts?.Perfect ?? 0) + (counts?.Great ?? 0)).toBe(2);
  expect(counts?.WrongNote).toBe(1);

  // End the run from the pause menu: the results agree.
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Paused' }).getByRole('button', { name: 'End run & see results' }).click();
  await expect(page).toHaveURL(/#\/results\//);
  const tiles = await resultTiles(page);
  expect(tiles.Perfect + tiles.Great).toBe(2);
  expect(tiles.Wrong).toBe(1);
  const first = (await judgements(page)).slice(0, 3);
  expect(first.map((j) => j.outcome === 'WrongNote')).toEqual([false, false, true]);
});

test('practice: 70% speed and a one-bar A/B loop that wraps twice', async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page, playPath(OPEN_STRINGS, 'mode=practice'));
  await waitForSession(page);
  const practice = page.getByRole('region', { name: 'Practice', exact: true });
  await expect(practice).toBeVisible();

  // Loop "First Frets" (bars 9–16), shrink it to bar 9 with B ◂, fix the speed at 70%.
  const loop = practice.getByRole('region', { name: 'Loop' });
  await loop.getByRole('group', { name: 'Loop a section' }).getByRole('button', { name: /^First Frets/ }).click();
  for (let i = 0; i < 7; i++) await loop.getByRole('button', { name: 'Loop end one bar earlier' }).click();
  await expect(loop.getByRole('button', { name: 'Loop end one bar earlier' })).toBeDisabled();
  const trainer = practice.getByRole('switch', { name: 'Speed trainer' });
  if ((await trainer.getAttribute('aria-checked')) === 'true') await trainer.click();
  await expect(trainer).toHaveAttribute('aria-checked', 'false');
  await practice.getByRole('group', { name: 'Speed presets' }).getByRole('button', { name: '70%' }).click();
  await expect.poll(async () => (await hookState(page)).session?.speed).toBeCloseTo(0.7, 5);

  // Bar 9 of a 4/4 song at 72 BPM: 26.67 s … 30.00 s (song time); one bar of pre-roll before it.
  const bar = (4 * 60) / 72;
  const loopStart = 8 * bar;
  const loopEnd = 9 * bar;
  await pressPlay(page);

  const samples: number[] = [];
  let wraps = 0;
  let shotTaken = false;
  const started = Date.now();
  while (wraps < 2 && Date.now() - started < 45_000) {
    const s = (await hookState(page)).session;
    expect(s?.speed).toBeCloseTo(0.7, 5);
    if (s && (s.state === 'playing' || s.state === 'count-in')) {
      const prev = samples.at(-1);
      if (prev !== undefined && s.songTime < prev - bar / 2) wraps++;
      samples.push(s.songTime);
      if (wraps === 1 && !shotTaken) {
        await shot(page, 'practice-loop');
        shotTaken = true;
      }
    }
    await page.waitForTimeout(100);
  }
  expect(wraps).toBe(2);
  const playing = samples.filter((t) => t >= loopStart - bar);
  expect(Math.max(...playing)).toBeLessThanOrEqual(loopEnd + 0.15);
  expect(Math.max(...playing)).toBeGreaterThan(loopEnd - 0.5);
  // At 70% one bar of song (3.33 s) takes 4.76 s of real time: the two wraps took ≥ 9 s.
  expect(Date.now() - started).toBeGreaterThan(9000);
});
