/**
 * Game session driven through a fake engine (real `TransportCore`, fake context clock): scripted
 * test-hook / keyboard / guitar events give the expected `RunSummary`, runs and progress are saved,
 * loops drive the speed trainer, pause/seek/restart/quit follow docs/game-mechanics.md.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { SongCacheEntry } from '@shared/storage';
import { recallResult, resultKey } from '../../src/game/session/results';
import { FakeGuide, FakeInput, makeSong, Rig, settle, testStorage } from './helpers';

/** 4 bars, one note per beat on string 1 (open e, MIDI 64) from bar 1 on (bar 0 empty). */
function beatSong() {
  const specs = [];
  for (let t = 2; t < 8; t += 0.5) specs.push({ time: t, string: 1 as const });
  return makeSong(specs, { bars: 4, sections: [['Intro', 0, 1], ['Verse', 1, 3], ['Outro', 3, 4]] });
}

describe('GameSessionImpl — scripted runs', () => {
  it('test-hook injections give exact Perfect / WrongNote / Miss counts and a saved run', async () => {
    const storage = await testStorage();
    const song = beatSong();
    const rig = new Rig({ song, storage });
    const s = rig.session;
    expect(s.state).toBe('ready');
    s.play();
    expect(s.state).toBe('playing');
    // Inject every note up front: note 3 wrong pitch (Shift), note 7 omitted.
    song.notes.forEach((n, i) => {
      if (i === 7) return;
      s.injectTest({ lane: n.string, songTime: n.time, wrongPitch: i === 3 });
    });
    rig.until(() => rig.runEnds.length > 0, 20);
    await settle();
    expect(s.state).toBe('ended');
    const { summary, runId } = rig.runEnds[0]!;
    expect(summary.counts).toEqual({ Perfect: song.notes.length - 2, Great: 0, Good: 0, WrongNote: 1, Miss: 1 });
    expect(summary.judgedNotes).toBe(song.notes.length);
    expect(summary.histogram.bins.reduce((a, b) => a + b, 0)).toBe(song.notes.length - 1);
    expect(runId).not.toBeNull();
    const finals = s.judgements().filter((j) => j.final);
    expect(finals).toHaveLength(song.notes.length);
    expect(finals.filter((j) => j.outcome === 'Perfect').every((j) => j.deltaMs === 0)).toBe(true);

    const [run] = await storage.listRuns({ songId: 'test:song' });
    expect(run).toMatchObject({ id: runId, mode: 'play', speed: 1, inputSource: 'test', clean: false });
    expect(run!.activeSec).toBeGreaterThan(7);
    const bests = await storage.getBests('test:song', 0);
    expect(bests).toHaveLength(1);
    expect(bests[0]).toMatchObject({ speedBucket: 100, score: summary.score, runId });
    // Sections fully played count as runs of those sections.
    const progress = await storage.getSectionProgress('test:song', 0);
    expect(progress.map((p) => p.sectionIdx).sort()).toEqual([1, 2]);
    const days = await storage.listPracticeDays();
    expect(days[0]!.runs).toBe(1);
    expect(await storage.getStreak()).not.toBeNull();
    // Result handed to the results screen.
    expect(s.lastResult).not.toBeNull();
    expect(recallResult(resultKey(s.lastResult!))?.counts.WrongNote).toBe(1);
    expect(s.lastResult!.newBest).toBe(true);
    await s.dispose();
    storage.close();
  });

  it('starting a run marks the song as last played, even if the run is quit', async () => {
    const storage = await testStorage();
    await storage.putSongCache({ songId: 'test:song', meta: { id: 'test:song', title: 'Test Song' } as SongCacheEntry['meta'], difficulty: null, lastPlayedAt: null, favourite: false });
    const rig = new Rig({ song: beatSong(), storage });
    const s = rig.session;
    s.play();
    await settle();
    expect((await storage.getSongCache('test:song'))?.lastPlayedAt).toBe(rig.wall);
    await s.quit();
    expect(await storage.listRuns()).toHaveLength(0);
    expect((await storage.listRecentSongs(5)).map((e) => e.songId)).toEqual(['test:song']);
    await s.dispose();
    storage.close();
  });

  it('keyboard presses use the heard-domain time minus the keyboard offset', async () => {
    const song = beatSong();
    const rig = new Rig({ song, settings: { calibration: { keyboardOffsetMs: 30 } } });
    const s = rig.session;
    s.play();
    const deltas = [0, 0.05, -0.1, 0.2];
    // Press at note time + delta + offset (the offset is subtracted again).
    song.notes.slice(0, 4).forEach((n, i) => {
      rig.until(() => rig.clock.t >= rig.ctxOf(n.time) + (deltas[i] ?? 0) + 0.03, 10);
      const ev = s.keyPress({ lane: 1, wrongPitch: false, timeStampMs: rig.clock.t * 1000 });
      expect(ev?.source).toBe('keyboard');
      expect(ev?.midi).toBe(64);
    });
    rig.advance(0.5);
    const finals = s.judgements().filter((j) => j.final);
    expect(finals.slice(0, 4).map((j) => j.outcome)).toEqual(['Perfect', 'Great', 'Good', 'Miss']);
    expect(finals[2]?.timing).toBe('early');
    // The 0.2 s late press found no candidate within Good → a stray, not a WrongNote.
    expect(s.judgeState().counts.WrongNote).toBe(0);
    await s.dispose();
  });

  it('timing leniency scales the windows of the run (relaxed ×1.5, tight ×0.75)', async () => {
    const outcomes = async (leniency: 'tight' | 'standard' | 'relaxed'): Promise<string[]> => {
      const song = beatSong();
      const rig = new Rig({ song, settings: { game: { timingLeniency: leniency } } });
      const s = rig.session;
      s.play();
      const deltas = [0.03, 0.06, 0.1, 0.15];
      song.notes.slice(0, 4).forEach((n, i) => {
        rig.until(() => rig.clock.t >= rig.ctxOf(n.time) + (deltas[i] ?? 0), 10);
        s.keyPress({ lane: 1, wrongPitch: false, timeStampMs: rig.clock.t * 1000 });
      });
      rig.advance(0.5);
      const out = s.judgements().filter((j) => j.final).slice(0, 4).map((j) => j.outcome);
      await s.dispose();
      return out;
    };
    expect(await outcomes('standard')).toEqual(['Perfect', 'Great', 'Good', 'Miss']);
    expect(await outcomes('relaxed')).toEqual(['Perfect', 'Great', 'Great', 'Good']);
    expect(await outcomes('tight')).toEqual(['Great', 'Good', 'Miss', 'Miss']);
  });

  it('Shift on a key press plays one semitone up: a WrongNote that breaks the combo', async () => {
    const song = beatSong();
    const rig = new Rig({ song });
    const s = rig.session;
    s.play();
    const n0 = song.notes[0]!;
    rig.until(() => rig.clock.t >= rig.ctxOf(n0.time), 5);
    const ev = s.keyPress({ lane: 1, wrongPitch: true, timeStampMs: rig.clock.t * 1000 });
    expect(ev?.midi).toBe(65);
    rig.advance(0.3);
    const j = s.judgements().filter((x) => x.final)[0];
    expect(j?.outcome).toBe('WrongNote');
    expect(j?.playedMidi).toBe(65);
    await s.dispose();
  });

  it('guitar events and expect hints flow through the input service', async () => {
    const song = beatSong();
    const input = new FakeInput();
    const rig = new Rig({ song, deps: { input } });
    const s = rig.session;
    expect(s.hasGuitar).toBe(true);
    s.play();
    const n0 = song.notes[0]!;
    rig.until(() => rig.clock.t >= rig.ctxOf(n0.time) + 0.15, 5);
    input.emit(rig.ctxOf(n0.time) + 0.04, 64);
    rig.advance(0.4);
    expect(s.judgements().find((j) => j.final)?.outcome).toBe('Great');
    expect(input.hints.some((h) => h?.minMidi === 64 && h.maxMidi === 64)).toBe(true);
    await s.dispose();
    expect(input.hints.at(-1)).toBeNull();
  });

  it('a guitar run waits for the guitar input horizon before closing windows', async () => {
    const song = beatSong();
    const input = new FakeInput();
    const rig = new Rig({ song, deps: { input } });
    const s = rig.session;
    s.play();
    const n0 = song.notes[0]!;
    // 125 ms after the note's window closes for the keyboard, the guitar may still deliver.
    rig.until(() => rig.clock.t >= rig.ctxOf(n0.time) + 0.2, 5);
    expect(s.judgements().filter((j) => j.final)).toHaveLength(0);
    input.emit(rig.ctxOf(n0.time) + 0.1, 64);
    rig.advance(0.3);
    expect(s.judgements().find((j) => j.final)?.outcome).toBe('Good');
    await s.dispose();
  });
});

describe('GameSessionImpl — transport control', () => {
  it('onsets while paused are strays; resume continues the same pass', async () => {
    const song = beatSong();
    const rig = new Rig({ song });
    const s = rig.session;
    const strays: number[] = [];
    s.onStray((x) => strays.push(x.ctxTime));
    s.play();
    rig.until(() => s.clock.nowSong() >= 3.1, 10);
    s.pause();
    expect(s.state).toBe('paused');
    rig.advance(0.5);
    s.input({ ctxTime: rig.clock.t, kind: 'onset', midi: 64, cents: 0, clarity: 1, source: 'test' });
    rig.advance(0.3);
    expect(strays).toHaveLength(1);
    const judgedWhilePaused = s.judgeState().judgedNotes;
    rig.advance(2);
    expect(s.judgeState().judgedNotes).toBe(judgedWhilePaused);
    s.play();
    expect(s.state).toBe('playing');
    rig.until(() => s.state === 'ended', 20);
    await settle();
    // Nothing played: every note judged once, all Miss (one pass, nothing lost or doubled).
    expect(rig.runEnds[0]?.summary.counts.Miss).toBe(song.notes.length);
    await s.dispose();
  });

  it('a forward seek leaves the skipped notes unjudged (new pass)', async () => {
    const song = beatSong();
    const rig = new Rig({ song });
    const s = rig.session;
    s.play();
    rig.until(() => s.clock.nowSong() >= 2.2, 10);
    s.seek(6);
    rig.until(() => s.state === 'ended', 20);
    await settle();
    const summary = rig.runEnds[0]!.summary;
    // Notes 2.0 (judged before the seek) + 6.0…7.5 after it.
    expect(summary.judgedNotes).toBe(1 + 4);
    expect(new Set(s.judgements().map((j) => j.pass))).toEqual(new Set([0, 1]));
    await s.dispose();
  });

  it('restart discards the run; quit records time only and reports no run id', async () => {
    const storage = await testStorage();
    const song = beatSong();
    const rig = new Rig({ song, storage });
    const s = rig.session;
    s.play();
    rig.advance(3);
    s.restart();
    expect(s.state).toBe('playing');
    rig.advance(0.1);
    expect(s.clock.nowSong()).toBeLessThan(0.2);
    expect(s.judgeState().judgedNotes).toBe(0);
    rig.advance(3);
    await s.quit();
    await settle();
    expect(s.state).toBe('ended');
    expect(rig.runEnds).toEqual([expect.objectContaining({ runId: null })]);
    expect(await storage.listRuns()).toHaveLength(0);
    const days = await storage.listPracticeDays();
    expect(days[0]!.activeSec).toBeGreaterThan(5);
    expect(days[0]!.runs).toBe(0);
    await s.dispose();
    storage.close();
  });

  it('the guide follows the mute rule and the manual override', async () => {
    const guide = new FakeGuide();
    const rig = new Rig({ song: beatSong(), deps: { guide } });
    expect(guide.muted).toBe(false);
    rig.settings.update({ game: { guide: false } });
    expect(guide.muted).toBe(true);
    rig.session.setGuideMuted(false);
    expect(guide.muted).toBe(false);
    await rig.session.setSpeed(0.8);
    expect(guide.speeds).toEqual([0.8]);
    expect(rig.session.speed).toBe(0.8);
    await rig.session.dispose();
  });

  it('speed is clamped to 40–110% and the loop pre-roll grows to 2 bars below 60%', async () => {
    const rig = new Rig({ song: beatSong() });
    const s = rig.session;
    s.setLoopBars(1, 3);
    expect(s.loop).toEqual({ start: 2, end: 6, preroll: 2 });
    await s.setSpeed(0.5);
    expect(s.loop?.preroll).toBe(4);
    await s.setSpeed(0.1);
    expect(s.speed).toBe(0.4);
    await s.setSpeed(2);
    expect(s.speed).toBe(1.1);
    await s.dispose();
  });
});

describe('GameSessionImpl — practice loops', () => {
  it('clean loop passes step the speed trainer up and update section progress', async () => {
    const storage = await testStorage();
    const song = beatSong();
    const rig = new Rig({ song, storage, speed: 0.7, deps: { mode: 'practice', speedTrainer: true, loopSection: 1 } });
    const s = rig.session;
    expect(s.loop).toEqual({ start: 2, end: 6, preroll: 2 });
    s.play();
    // Play every note of every pass perfectly: inject per pass when it starts.
    let lastPass = -1;
    const speeds: number[] = [];
    rig.until(() => {
      const pass = rig.core.pass;
      if (pass !== lastPass && s.state === 'playing') {
        lastPass = pass;
        speeds.push(s.speed);
        for (const n of song.notes) if (n.time >= 2 && n.time < 6) s.injectTest({ lane: 1, songTime: n.time });
      }
      return rig.messages.filter((m) => m.kind === 'trainer').length >= 2;
    }, 60);
    const trainer = rig.messages.filter((m) => m.kind === 'trainer').map((m) => m.text);
    expect(trainer).toEqual(['Clean run! +5% → 75%', 'Clean run! +5% → 80%']);
    rig.advance(5);
    expect(s.speed).toBe(0.8);
    await settle();
    const [verse] = await storage.getSectionProgress('test:song', 0);
    expect(verse).toMatchObject({ sectionIdx: 1, cleanRuns: 2 });
    expect(verse!.trainer.speed).toBe(0.8);
    // Ending the loop run saves a practice run with the loop, no best.
    const result = await s.finish();
    expect(result).toMatchObject({ mode: 'practice', loop: { startBar: 1, endBar: 3 }, completed: false });
    expect(result!.sectionUpdates.length).toBeGreaterThanOrEqual(2);
    expect(await storage.getBests('test:song', 0)).toHaveLength(0);
    const [run] = await storage.listRuns();
    expect(run?.loop).toEqual({ startBar: 1, endBar: 3 });
    expect(run?.speed).toBe(0.7);
    await s.dispose();
    storage.close();
  });

  it('two failed passes step the trainer down', async () => {
    const song = beatSong();
    const rig = new Rig({ song, speed: 0.8, deps: { mode: 'practice', speedTrainer: true, loopSection: 1 } });
    const s = rig.session;
    s.play();
    const streaks: number[] = [];
    let loops = 0;
    s.onMessage((m) => {
      if (m.kind === 'loop' && m.text.startsWith('Loop:')) {
        loops++;
        streaks.push(s.trainerState.failStreak);
      }
    });
    rig.until(() => rig.messages.some((m) => m.kind === 'trainer'), 60);
    expect(rig.messages.find((m) => m.kind === 'trainer')?.text).toBe('Slow down a notch → 75%');
    // The first failed pass shows a fail streak of 1; the second steps down and resets it.
    expect(loops).toBe(2);
    expect(streaks).toEqual([1, 0]);
    expect(s.trainerState).toEqual({ speed: 0.75, failStreak: 0 });
    rig.advance(4);
    expect(s.speed).toBe(0.75);
    await s.dispose();
  });

  it('exposes count-in bars and the metronome (settings defaults, setters, settings changes)', async () => {
    const rig = new Rig({ song: beatSong(), settings: { practice: { countInBars: 2, metronome: false } } });
    const s = rig.session;
    expect(s.countInBars).toBe(2);
    expect(s.metronome).toBe(false);
    s.setCountInBars(7);
    expect(s.countInBars).toBe(2);
    s.setCountInBars(0);
    expect(s.countInBars).toBe(0);
    s.setMetronome(true);
    expect(s.metronome).toBe(true);
    // Settings changes made elsewhere (the engine follows them) are mirrored.
    await rig.settings.update({ practice: { metronome: true } });
    await rig.settings.update({ practice: { metronome: false } });
    expect(s.metronome).toBe(false);
    await rig.settings.update({ game: { noteSpeed: 1.5 } });
    expect(s.metronome).toBe(false);
    await s.dispose();
  });

  it('setLoopBars mid-run keeps the pass and only judges the loop region', async () => {
    const song = beatSong();
    const rig = new Rig({ song });
    const s = rig.session;
    s.play();
    rig.until(() => s.clock.nowSong() >= 2.6, 10);
    s.setLoopBars(1, 2);
    expect(rig.core.pass).toBe(0);
    rig.until(() => rig.core.pass >= 2, 20);
    rig.advance(0.5);
    const outside = s.judgements().filter((j) => j.songTime >= 4);
    expect(outside).toHaveLength(0);
    expect(rig.messages.some((m) => m.kind === 'loop' && m.text === 'Looping bars 2–2')).toBe(true);
    await s.dispose();
  });
});
