/**
 * Section progress bar (T-031): the song's sections as proportional segments, the playhead (on the
 * underline, clear of the section names) with the played part, the loop region, and each section's
 * live accuracy (colour of its underline). Clicking a section seeks to it when `onSeek` is given
 * (practice mode).
 * @module
 */
import type { TransportLoop } from '@shared/clock';
import type { Judgement } from '@shared/judge';
import type { Song } from '@shared/song';
import { sectionAt } from '@core/model';
import { h } from '../../components';

/** `m:ss`. */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Heat class of an accuracy % (≥ 90 clean, ≥ 70 ok, else rough). */
export function heatClass(accuracy: number): 'hot' | 'warm' | 'cold' {
  return accuracy >= 90 ? 'hot' : accuracy >= 70 ? 'warm' : 'cold';
}

/** The bar. */
export class SectionProgressBar {
  readonly el: HTMLElement;
  private readonly segments: HTMLElement[];
  private readonly playhead = h('span', { class: 'gm-progress__playhead' });
  private readonly played = h('span', { class: 'gm-progress__played' });
  private readonly loopBox = h('span', { class: 'gm-progress__loop', hidden: true });
  private readonly time = h('span', { class: 'gm-progress__time rw-num' }, '0:00');
  private readonly duration: number;
  private readonly stats: { notes: number; hits: number }[];
  private readonly counted = new Set<string>();
  private lastPct = -1;
  private lastSec = -1;
  private current = -2;

  constructor(
    private readonly song: Song,
    onSeek: ((songTime: number) => void) | null,
  ) {
    this.duration = Math.max(1e-6, song.meta.durationSec);
    const sections = song.sections.length > 0 ? song.sections : [{ name: '', start: 0, end: song.meta.durationSec, startBar: 0, endBar: 0 }];
    this.stats = sections.map(() => ({ notes: 0, hits: 0 }));
    this.segments = sections.map((s, i) => {
      const left = (s.start / this.duration) * 100;
      const width = (Math.max(0, s.end - s.start) / this.duration) * 100;
      const label = s.name || `Section ${i + 1}`;
      const attrs = {
        class: 'gm-progress__seg',
        style: `left:${left}%;width:${width}%`,
        title: label,
        dataset: { idx: String(i) },
      };
      return onSeek
        ? h('button', { ...attrs, type: 'button', 'aria-label': `Jump to ${label}`, on: { click: () => onSeek(s.start) } }, h('span', { class: 'gm-progress__name' }, label))
        : h('span', attrs, h('span', { class: 'gm-progress__name' }, label));
    });
    this.el = h(
      'div',
      { class: 'gm-progress' },
      h('div', { class: 'gm-progress__track' }, this.segments, this.loopBox, this.played, this.playhead),
      h('div', { class: 'gm-progress__clock' }, this.time, h('span', { class: 'gm-progress__dur rw-num' }, ` / ${fmtClock(song.meta.durationSec)}`)),
    );
  }

  /** Move the playhead and highlight the current section. */
  setTime(songTime: number): void {
    const p = Math.round((Math.min(Math.max(songTime, 0), this.duration) / this.duration) * 1000) / 10;
    if (p !== this.lastPct) {
      this.lastPct = p;
      this.playhead.style.left = `${p}%`;
      this.played.style.width = `${p}%`;
    }
    const sec = Math.floor(Math.max(0, songTime));
    if (sec !== this.lastSec) {
      this.lastSec = sec;
      this.time.textContent = fmtClock(sec);
    }
    const idx = this.song.sections.length > 0 ? sectionAt(this.song, songTime) : 0;
    if (idx !== this.current) {
      this.segments[this.current]?.classList.remove('is-current');
      this.segments[idx]?.classList.add('is-current');
      this.current = idx;
    }
  }

  setLoop(loop: TransportLoop | null): void {
    this.loopBox.hidden = !loop;
    if (!loop) return;
    this.loopBox.style.left = `${(loop.start / this.duration) * 100}%`;
    this.loopBox.style.width = `${((loop.end - loop.start) / this.duration) * 100}%`;
  }

  /** Count a final judgement into its section's live accuracy. */
  judgement(j: Judgement): void {
    if (!j.final) return;
    const key = `${j.pass}:${j.noteIds[0] ?? -1}`;
    if (this.counted.has(key)) return;
    this.counted.add(key);
    const idx = this.song.sections.length > 0 ? sectionAt(this.song, j.songTime) : 0;
    const st = this.stats[idx];
    const seg = this.segments[idx];
    if (!st || !seg) return;
    st.notes += j.noteIds.length;
    if (j.outcome === 'Perfect' || j.outcome === 'Great' || j.outcome === 'Good') st.hits += j.noteIds.length;
    seg.dataset.heat = heatClass((st.hits / st.notes) * 100);
  }

  /** Forget live accuracy (new run). */
  reset(): void {
    this.counted.clear();
    for (const s of this.stats) {
      s.notes = 0;
      s.hits = 0;
    }
    for (const seg of this.segments) delete seg.dataset.heat;
  }
}
