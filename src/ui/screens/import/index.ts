/**
 * Import screen (T-028): paste or open an ASCII tab, check the live parse preview, set the rhythm
 * (snap-to-grid or tap-along), preview it with sound and a scrolling strip, and save it to the
 * library with its rhythm sidecar (docs/song-formats.md § Rhythm alignment UX).
 *
 * Routes: `#/import` (paste a new tab; `q` prefills the title) and `#/import?song=<id>` ("Align
 * rhythm" for a library ASCII tab: the file stays as it is, only the sidecar is saved).
 * @module
 */
import type { TransportTimeline } from '@shared/clock';
import type { RhythmSidecar, Song, SongBundle } from '@shared/song';
import type { AppContext, RouteParams, ScreenHandle, ScreenMount } from '@shared/ui';
import { asciiToSong, decodeText } from '@core/import/ascii';
import { describeTuning } from '@core/model';
import { append, button, card, emptyState, h, icon, select, setBusy, tabs, toggle, uid, type IconName, type Select } from '../../components';
import {
  DEFAULT_BPM,
  DEFAULT_TIME_SIG,
  MAX_BPM,
  MIN_BPM,
  SUBDIVISIONS,
  TIME_SIGNATURES,
  TUNING_CHOICES,
  addTap,
  buildSidecar,
  composeText,
  computeOnsets,
  parsePaste,
  previewFileName,
  restartFromBar,
  suggestSubdivision,
  tapTempoBpm,
  tapTimeline,
  ugSearchUrl,
  type PasteParse,
  type RhythmChoice,
  type Subdivision,
} from './model';
import { ImportAudio } from './player';
import { RhythmStrip } from './strip';
import './import.css';

/** Debounce for re-parsing while typing (ms). */
const PARSE_DEBOUNCE_MS = 150;
/** Accepted file types for "Open file". */
const FILE_ACCEPT = '.txt,.tab,text/plain';
/** Tap-along speeds. */
const TAP_SPEEDS = [0.5, 0.6, 0.75, 1] as const;
/** Preview speeds. */
const PREVIEW_SPEEDS = [0.5, 0.75, 1] as const;
/** Upcoming onsets shown while tapping. */
const NEXT_UP = 8;

const PLACEHOLDER = `Paste a tab here, for example:

e|---------0-------|---------0-------|
B|-------1---1-----|-------1---1-----|
G|-----0-------0---|-----2-------2---|
D|---2-----------2-|---2-----------2-|
A|-3---------------|-0---------------|
E|-----------------|-----------------|`;

/** Everything the screen keeps between renders. */
interface State {
  /** `paste`: new tab → library file. `align`: existing library song → sidecar only. */
  mode: 'paste' | 'align';
  songId: string | null;
  /** Align mode: the song's bundle as served (main file + MIDI + current sidecar). */
  bundle: SongBundle | null;
  raw: string;
  parse: PasteParse;
  titleTouched: boolean;
  artistTouched: boolean;
  /** `auto` = as detected, else a {@link TUNING_CHOICES} id. */
  tuning: string;
  /** Null = as detected. */
  capo: number | null;
  bpm: number;
  bpmTouched: boolean;
  timeSig: [number, number];
  timeSigTouched: boolean;
  /** `auto` = {@link suggestSubdivision}. */
  grid: 'auto' | Subdivision;
  method: 'snap' | 'tap';
  taps: number[];
  quantizeTaps: boolean;
  tapSpeed: number;
  previewSpeed: number;
  click: boolean;
  phase: 'idle' | 'preview' | 'tapping';
  /** Song time from which tap-along accepts taps (count-in taps are ignored). */
  tapFrom: number;
  onsets: number[];
  previewSong: Song | null;
  previewBundle: SongBundle | null;
  previewError: string | null;
  /** Align mode: "Artist – Title" of the song being aligned. */
  alignTitle?: string;
}

export const mount: ScreenMount = async (el, ctx, params) => {
  const screen = new ImportScreen(el, ctx, params);
  await screen.init();
  return screen;
};

/** The import / align-rhythm screen. */
class ImportScreen implements ScreenHandle {
  private readonly state: State;
  private readonly audio: ImportAudio;
  private readonly root: HTMLElement;
  private readonly cleanups: (() => void)[] = [];
  private parseTimer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private tempoTaps: number[] = [];
  private destroyed = false;
  /** False while build() runs (tab panels are rendered eagerly then). */
  private built = false;

  // Controls (created in build()).
  private textarea!: HTMLTextAreaElement;
  private fileInput!: HTMLInputElement;
  private parsedView!: HTMLElement;
  private summary!: HTMLElement;
  private warnings!: HTMLElement;
  private titleInput!: HTMLInputElement;
  private artistInput!: HTMLInputElement;
  private tuningSelect!: Select;
  private capoInput!: HTMLInputElement;
  private tuningNote!: HTMLElement;
  private ugLink!: HTMLAnchorElement;
  private bpmInput!: HTMLInputElement;
  private tapTempoBtn!: HTMLButtonElement;
  private timeSigSelect!: Select;
  private gridRadios = new Map<string, HTMLInputElement>();
  private autoGridLabel!: HTMLElement;
  private tapStartBtn!: HTMLButtonElement;
  private tapUndoBtn!: HTMLButtonElement;
  private tapPad!: HTMLButtonElement;
  private restartBarInput!: HTMLInputElement;
  private restartBtn!: HTMLButtonElement;
  private tapStatus!: HTMLElement;
  private nextUp!: HTMLElement;
  private strip!: RhythmStrip;
  private playBtn!: HTMLButtonElement;
  private voiceNote!: HTMLElement;
  private saveBtn!: HTMLButtonElement;
  private saveNote!: HTMLElement;

  constructor(
    private readonly el: HTMLElement,
    private readonly ctx: AppContext,
    private readonly params: RouteParams,
  ) {
    this.audio = new ImportAudio(ctx);
    this.audio.onEnded(() => this.stopPlayback());
    this.root = h('div', { class: 'imp' });
    const songId = params.song || null;
    this.state = {
      mode: songId ? 'align' : 'paste',
      songId,
      bundle: null,
      raw: '',
      parse: parsePaste(''),
      titleTouched: false,
      artistTouched: false,
      tuning: 'auto',
      capo: null,
      bpm: DEFAULT_BPM,
      bpmTouched: false,
      timeSig: [...DEFAULT_TIME_SIG],
      timeSigTouched: false,
      grid: 'auto',
      method: 'snap',
      taps: [],
      quantizeTaps: false,
      tapSpeed: 0.75,
      previewSpeed: 1,
      click: true,
      phase: 'idle',
      tapFrom: 0,
      onsets: [],
      previewSong: null,
      previewBundle: null,
      previewError: null,
    };
  }

  /** Build the screen; in align mode load the song first. */
  async init(): Promise<void> {
    this.el.append(this.root);
    if (this.state.mode === 'align') {
      const ok = await this.loadSongForAlignment();
      if (!ok || this.destroyed) return;
    }
    this.build();
    if (this.state.mode === 'paste' && this.params.q) {
      this.titleInput.value = this.params.q;
      this.onTitleInput();
    }
    this.reparse();
    const onKey = (ev: KeyboardEvent): void => this.onKeyDown(ev);
    document.addEventListener('keydown', onKey, true);
    this.cleanups.push(() => document.removeEventListener('keydown', onKey, true));
  }

  unmount(): void {
    this.destroyed = true;
    if (this.parseTimer) clearTimeout(this.parseTimer);
    cancelAnimationFrame(this.raf);
    for (const c of this.cleanups.splice(0)) c();
    this.audio.dispose();
    this.strip?.destroy();
    this.root.remove();
  }

  // -------------------------------------------------------------------------------------------
  // Align mode: load a library song
  // -------------------------------------------------------------------------------------------

  private async loadSongForAlignment(): Promise<boolean> {
    const id = this.state.songId as string;
    const loading = h('p', { class: 'imp-loading', role: 'status' }, 'Loading the song…');
    this.root.append(loading);
    try {
      const [meta, bundle] = await Promise.all([this.ctx.api.song(id), this.ctx.api.songBundle(id)]);
      loading.remove();
      if (meta.entry.format !== 'ascii') {
        this.root.append(
          emptyState({
            title: 'This song already has its rhythm',
            message: 'Only ASCII tabs need rhythm alignment. Guitar Pro, MusicXML and alphaTex files carry exact timing.',
            icon: 'check',
            headingLevel: 1,
            action: { label: 'Open the song', onClick: () => this.ctx.router.navigate(this.ctx.router.href('song', { id })) },
          }),
        );
        return false;
      }
      this.state.bundle = bundle;
      this.state.raw = decodeText(bundle.data);
      this.state.alignTitle = [meta.entry.artist, meta.entry.title].filter(Boolean).join(' – ');
      const sc = bundle.sidecar;
      if (sc) {
        this.state.bpm = sc.bpm;
        this.state.bpmTouched = true;
        this.state.timeSig = [sc.timeSig[0], sc.timeSig[1]];
        this.state.timeSigTouched = true;
        this.state.grid = sc.grid;
        if (sc.method === 'tap' || sc.method === 'manual') {
          this.state.method = 'tap';
          this.state.taps = [...sc.onsets];
        }
      }
      return true;
    } catch (err) {
      loading.remove();
      this.root.append(
        emptyState({
          title: 'Song not found',
          message: `It may have been removed from the library. (${errorText(err)})`,
          icon: 'warning',
          headingLevel: 1,
          action: { label: 'Go to the library', onClick: () => this.ctx.router.navigate(this.ctx.router.href('library')) },
        }),
      );
      return false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------------------------

  private build(): void {
    const align = this.state.mode === 'align';
    this.ugLink = h(
      'a',
      { class: 'rw-btn rw-btn--secondary rw-btn--md imp-ug', target: '_blank', rel: 'noopener noreferrer', href: ugSearchUrl('') },
      icon('search'),
      h('span', { class: 'rw-btn__label' }, 'Search on Ultimate Guitar'),
    );
    const header = h(
      'header',
      { class: 'imp-header' },
      h(
        'div',
        null,
        h('h1', { class: 'imp-title' }, align ? 'Align rhythm' : 'Import a tab'),
        h(
          'p',
          { class: 'imp-lede rw-muted' },
          align
            ? `${this.state.alignTitle ?? 'This tab'} has notes but no reliable rhythm yet. Pick a tempo, snap or tap the rhythm, preview it and save.`
            : 'Paste a text tab (or open a .txt file), check what was read, give it a rhythm, preview it and save it to your library.',
        ),
      ),
      align ? null : h('div', { class: 'imp-header__aside' }, this.ugLink, h('p', { class: 'imp-ug-hint rw-muted' }, 'Opens in a new tab. Copy the tab text and paste it here.')),
    );
    append(this.root, [header, this.buildSourceCard(), align ? null : this.buildDetailsCard(), this.buildRhythmCard(), this.buildPreviewCard()]);
    this.built = true;
  }

  private buildSourceCard(): HTMLElement {
    const align = this.state.mode === 'align';
    const taId = uid('tab-text');
    this.textarea = h('textarea', {
      id: taId,
      class: 'imp-textarea',
      spellcheck: 'false',
      autocomplete: 'off',
      wrap: 'off',
      rows: 16,
      placeholder: PLACEHOLDER,
      readonly: align,
      'aria-describedby': undefined,
    });
    this.textarea.value = this.state.raw;
    this.textarea.addEventListener('input', () => this.scheduleParse());
    this.textarea.addEventListener('dragover', (ev) => ev.preventDefault());
    this.textarea.addEventListener('drop', (ev) => {
      const file = ev.dataTransfer?.files?.[0];
      if (!file || align) return;
      ev.preventDefault();
      void this.openFile(file);
    });
    this.fileInput = h('input', { type: 'file', accept: FILE_ACCEPT, class: 'rw-visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (file) void this.openFile(file);
      this.fileInput.value = '';
    });
    const actions = align
      ? null
      : h(
          'div',
          { class: 'imp-row' },
          button({ label: 'Open file…', icon: 'import', size: 'sm', onClick: () => this.fileInput.click() }),
          button({
            label: 'Clear',
            variant: 'ghost',
            size: 'sm',
            onClick: () => {
              this.textarea.value = '';
              this.reparse();
              this.textarea.focus();
            },
          }),
          this.fileInput,
        );
    this.summary = h('div', { class: 'imp-summary', role: 'status', 'aria-live': 'polite' });
    this.warnings = h('ul', { class: 'imp-warnings', 'aria-label': 'Parse warnings' });
    this.parsedView = h('div', { class: 'imp-parsed', role: 'region', 'aria-label': 'Parsed view', tabindex: '0' });
    return card({
      title: align ? 'Tab' : '1 · Paste the tab',
      headingLevel: 2,
      class: 'imp-card imp-source',
      body: h(
        'div',
        { class: 'imp-source__grid' },
        h(
          'div',
          { class: 'imp-source__edit' },
          h('label', { class: 'rw-field__label', for: taId }, align ? 'Tab text (read-only)' : 'Tab text'),
          this.textarea,
          actions,
        ),
        h(
          'div',
          { class: 'imp-source__preview' },
          h('p', { class: 'rw-field__label' }, 'What Riffway read'),
          this.summary,
          this.warnings,
          this.parsedView,
        ),
      ),
    });
  }

  private buildDetailsCard(): HTMLElement {
    const titleId = uid('title');
    const artistId = uid('artist');
    const capoId = uid('capo');
    this.titleInput = h('input', { id: titleId, class: 'imp-input', type: 'text', maxlength: 200, autocomplete: 'off', required: true });
    this.artistInput = h('input', { id: artistId, class: 'imp-input', type: 'text', maxlength: 200, autocomplete: 'off' });
    this.titleInput.addEventListener('input', () => this.onTitleInput());
    this.artistInput.addEventListener('input', () => {
      this.state.artistTouched = true;
      this.updateNames();
    });
    this.tuningSelect = select({
      label: 'Tuning',
      options: [{ value: 'auto', label: 'As detected' }],
      value: 'auto',
      onChange: (v) => {
        this.state.tuning = v;
        this.refresh();
      },
    });
    this.capoInput = h('input', { id: capoId, class: 'imp-input imp-input--num', type: 'number', min: 0, max: 15, step: 1, inputmode: 'numeric' });
    this.capoInput.addEventListener('input', () => {
      const v = this.capoInput.value.trim();
      const n = Number(v);
      this.state.capo = v === '' || !Number.isInteger(n) || n < 0 || n > 15 ? null : n;
      this.refresh();
    });
    this.tuningNote = h('p', { class: 'rw-field__hint imp-tuning-note', hidden: true });
    return card({
      title: '2 · Song details',
      headingLevel: 2,
      class: 'imp-card',
      body: h(
        'div',
        { class: 'imp-fields' },
        field('Title', titleId, this.titleInput, 'Required. The file is saved as “Artist - Title.txt”.'),
        field('Artist', artistId, this.artistInput),
        h('div', { class: 'imp-field-wrap' }, this.tuningSelect.el, this.tuningNote),
        field('Capo', capoId, this.capoInput, 'Fret; empty = as written in the tab.'),
      ),
    });
  }

  private buildRhythmCard(): HTMLElement {
    const bpmId = uid('bpm');
    this.bpmInput = h('input', { id: bpmId, class: 'imp-input imp-input--num', type: 'number', min: MIN_BPM, max: MAX_BPM, step: 1, inputmode: 'numeric' });
    this.bpmInput.value = String(this.state.bpm);
    this.bpmInput.addEventListener('input', () => {
      const n = Number(this.bpmInput.value);
      if (!Number.isFinite(n) || n < MIN_BPM || n > MAX_BPM) {
        this.bpmInput.setAttribute('aria-invalid', 'true');
        return;
      }
      this.bpmInput.removeAttribute('aria-invalid');
      this.state.bpm = n;
      this.state.bpmTouched = true;
      this.refresh();
    });
    this.tapTempoBtn = button({ label: 'Tap tempo', icon: 'audio', size: 'sm', title: 'Click (or press T) on every beat; 4 or more taps' });
    this.tapTempoBtn.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      this.tapTempo(ev.timeStamp);
    });
    this.tapTempoBtn.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Enter' || ev.key === ' ') && !ev.repeat) {
        ev.preventDefault();
        this.tapTempo(ev.timeStamp);
      }
    });
    this.timeSigSelect = select({
      label: 'Time signature',
      options: TIME_SIGNATURES.map(([n, d]) => ({ value: `${n}/${d}`, label: `${n}/${d}` })),
      value: '4/4',
      onChange: (v) => {
        const [n, d] = v.split('/').map(Number) as [number, number];
        this.state.timeSig = [n, d];
        this.state.timeSigTouched = true;
        this.refresh();
      },
    });
    const tempoRow = h(
      'div',
      { class: 'imp-fields imp-fields--tempo' },
      h(
        'div',
        { class: 'rw-field' },
        h('label', { class: 'rw-field__label', for: bpmId }, 'Tempo (BPM, quarter notes)'),
        h('div', { class: 'imp-row' }, this.bpmInput, this.tapTempoBtn),
      ),
      this.timeSigSelect.el,
    );

    const methodTabs = tabs({
      label: 'Rhythm method',
      variant: 'segmented',
      selected: this.state.method,
      tabs: [
        { id: 'snap', label: 'Snap to grid', render: () => this.buildSnapPanel() },
        { id: 'tap', label: 'Tap along', render: () => this.buildTapPanel() },
      ],
      onChange: (id) => {
        this.state.method = id as 'snap' | 'tap';
        if (!this.built) return;
        this.stopPlayback();
        this.stopTapping();
        this.refresh();
      },
    });
    this.cleanups.push(() => methodTabs.destroy());
    // Build both panels now so their controls exist for refresh().
    const initial = this.state.method;
    methodTabs.select(initial === 'snap' ? 'tap' : 'snap');
    methodTabs.select(initial);
    return card({
      title: this.state.mode === 'align' ? 'Rhythm' : '3 · Rhythm',
      headingLevel: 2,
      class: 'imp-card',
      body: [tempoRow, methodTabs.el],
    });
  }

  private buildSnapPanel(): HTMLElement {
    const name = uid('grid');
    const opts: { value: 'auto' | Subdivision; label: string }[] = [{ value: 'auto', label: 'Auto' }, ...SUBDIVISIONS];
    const group = h('div', { class: 'imp-seg', role: 'radiogroup', 'aria-label': 'Grid' });
    for (const o of opts) {
      const input = h('input', { type: 'radio', name, value: String(o.value), class: 'imp-seg__input' });
      input.checked = this.state.grid === o.value;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        this.state.grid = o.value;
        this.refresh();
      });
      this.gridRadios.set(String(o.value), input);
      const label = h('span', { class: 'imp-seg__label' }, o.label);
      if (o.value === 'auto') this.autoGridLabel = label;
      group.append(h('label', { class: 'imp-seg__item' }, input, label));
    }
    return h(
      'div',
      { class: 'imp-method' },
      h('p', { class: 'rw-field__label' }, 'Grid'),
      group,
      h(
        'p',
        { class: 'rw-field__hint' },
        'The spacing between notes in the tab is read as their length, then each note snaps to the nearest grid step. Chords stay together. Listen to the preview and try another grid if it sounds off.',
      ),
    );
  }

  private buildTapPanel(): HTMLElement {
    const speed = select({
      label: 'Metronome speed',
      options: TAP_SPEEDS.map((s) => ({ value: String(s), label: `${Math.round(s * 100)}%` })),
      value: String(this.state.tapSpeed),
      onChange: (v) => {
        this.state.tapSpeed = Number(v);
      },
    });
    const quantize = toggle({
      label: 'Quantize taps',
      description: 'Snap each tap to the grid chosen under “Snap to grid”.',
      checked: this.state.quantizeTaps,
      onChange: (on) => {
        this.state.quantizeTaps = on;
        this.refresh();
      },
    });
    this.tapStartBtn = button({ label: 'Start tapping', variant: 'primary', icon: 'play', onClick: () => void this.toggleTapping() });
    this.tapUndoBtn = button({ label: 'Undo tap', variant: 'secondary', size: 'sm', title: 'Backspace', onClick: () => this.undoTap() });
    const barId = uid('bar');
    this.restartBarInput = h('input', { id: barId, class: 'imp-input imp-input--num', type: 'number', min: 1, step: 1, value: 1, inputmode: 'numeric' });
    this.restartBtn = button({ label: 'Restart from bar', variant: 'secondary', size: 'sm', icon: 'loop', onClick: () => void this.restartTapping() });
    this.tapPad = h(
      'button',
      { type: 'button', class: 'imp-tap-pad', 'aria-label': 'Tap (Space)', disabled: true },
      h('span', { class: 'imp-tap-pad__big' }, 'TAP'),
      h('span', { class: 'imp-tap-pad__small' }, h('kbd', null, 'Space')),
    );
    this.tapPad.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      this.tap(ev.timeStamp);
    });
    this.tapStatus = h('p', { class: 'imp-tap-status', role: 'status', 'aria-live': 'polite' });
    this.nextUp = h('div', { class: 'imp-next', 'aria-label': 'Next onsets to tap' });
    return h(
      'div',
      { class: 'imp-method' },
      h(
        'p',
        { class: 'rw-field__hint' },
        'A metronome counts in one bar, then tap Space (or the pad) once for every note or chord in the tab, in order. Pick a comfortable slower speed: the timing is scaled back to the BPM above.',
      ),
      h('div', { class: 'imp-fields imp-fields--tap' }, speed.el, quantize.el),
      h('div', { class: 'imp-tap' }, this.tapPad, h('div', { class: 'imp-tap__side' }, this.tapStatus, this.nextUp)),
      h(
        'div',
        { class: 'imp-row imp-row--wrap' },
        this.tapStartBtn,
        this.tapUndoBtn,
        h('span', { class: 'imp-row imp-restart' }, h('label', { class: 'rw-visually-hidden', for: barId }, 'Bar'), this.restartBtn, this.restartBarInput),
      ),
    );
  }

  private buildPreviewCard(): HTMLElement {
    this.strip = new RhythmStrip({
      onPick: (t) => {
        if (this.state.phase !== 'tapping') void this.startPreview(t);
      },
    });
    this.playBtn = button({ label: 'Play preview', icon: 'play', variant: 'secondary', onClick: () => void this.togglePreview() });
    const speed = select({
      label: 'Speed',
      options: PREVIEW_SPEEDS.map((s) => ({ value: String(s), label: `${Math.round(s * 100)}%` })),
      value: String(this.state.previewSpeed),
      onChange: (v) => {
        this.state.previewSpeed = Number(v);
        if (this.state.phase === 'preview') void this.startPreview(this.audio.heardSongTime() ?? 0);
      },
    });
    const click = toggle({
      label: 'Click',
      checked: this.state.click,
      onChange: (on) => {
        this.state.click = on;
        this.audio.setMetronome(on);
      },
    });
    this.voiceNote = h('p', { class: 'rw-field__hint imp-voice' });
    this.saveNote = h('p', { class: 'imp-save-note rw-muted' });
    this.saveBtn = button({
      label: this.state.mode === 'align' ? 'Save rhythm' : 'Save to library',
      variant: 'primary',
      size: 'lg',
      icon: 'check',
      onClick: () => void this.save(),
    });
    return card({
      title: this.state.mode === 'align' ? 'Preview and save' : '4 · Preview and save',
      headingLevel: 2,
      class: 'imp-card',
      body: [
        h('div', { class: 'imp-row imp-row--wrap imp-preview-controls' }, this.playBtn, speed.el, click.el),
        this.strip.el,
        this.voiceNote,
      ],
      footer: h('div', { class: 'imp-save' }, this.saveNote, this.saveBtn),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Parsing and derived state
  // -------------------------------------------------------------------------------------------

  private scheduleParse(): void {
    if (this.parseTimer) clearTimeout(this.parseTimer);
    this.parseTimer = setTimeout(() => this.reparse(), PARSE_DEBOUNCE_MS);
  }

  /** Re-parse the text, update auto-filled fields, then refresh everything derived. */
  private reparse(): void {
    this.parseTimer = null;
    const raw = this.textarea.value;
    const changed = raw !== this.state.raw || this.state.parse.tab === null;
    this.state.raw = raw;
    this.state.parse = parsePaste(raw);
    if (changed && this.state.method === 'tap' && this.state.mode === 'paste') this.state.taps = [];
    const header = this.state.parse.tab?.header;
    if (!this.state.bpmTouched) {
      this.state.bpm = header?.tempo ?? DEFAULT_BPM;
      this.bpmInput.value = String(this.state.bpm);
    }
    if (!this.state.timeSigTouched) this.state.timeSig = header?.timeSig ? [header.timeSig[0], header.timeSig[1]] : [...DEFAULT_TIME_SIG];
    this.syncTimeSigOptions();
    if (this.state.mode === 'paste') {
      if (!this.state.titleTouched && header?.title) this.titleInput.value = header.title;
      if (!this.state.artistTouched) this.artistInput.value = header?.artist ?? header?.composer ?? '';
      this.syncTuningOptions();
      this.capoInput.placeholder = String(header?.capo ?? 0);
    }
    this.renderParse();
    this.refresh();
  }

  /** Recompute onsets → sidecar → preview song, and update every dependent control. */
  private refresh(): void {
    const s = this.state;
    const tab = s.parse.tab;
    const groups = tab?.groups ?? [];
    const grid = this.effectiveGrid();
    if (this.autoGridLabel) this.autoGridLabel.textContent = `Auto (${SUBDIVISIONS.find((o) => o.value === suggestSubdivision(groups, s.timeSig))?.label ?? '1/16'})`;
    s.onsets = computeOnsets(groups, this.choice(grid));
    s.previewSong = null;
    s.previewBundle = null;
    s.previewError = null;
    if (groups.length) {
      const sidecar = buildSidecar(s.onsets, this.choice(grid), Date.now());
      const bundle = this.bundleFor(sidecar);
      try {
        const song = asciiToSong(bundle);
        if (song.meta.rhythm !== 'aligned') s.previewError = 'The rhythm does not fit the tab; check the warnings above.';
        else {
          s.previewSong = song;
          s.previewBundle = bundle;
        }
        this.updateTuningNote(song);
      } catch (err) {
        s.previewError = errorText(err);
      }
    }
    if (s.phase === 'preview') this.stopPlayback();
    this.strip.setSong(s.previewSong);
    this.updateTapUi();
    this.updateNames();
    this.updateSaveState();
  }

  private effectiveGrid(): Subdivision {
    const s = this.state;
    if (s.grid !== 'auto') return s.grid;
    return suggestSubdivision(s.parse.tab?.groups ?? [], s.timeSig);
  }

  private choice(grid: Subdivision): RhythmChoice {
    const s = this.state;
    return { bpm: s.bpm, timeSig: s.timeSig, grid, method: s.method, taps: s.taps, quantizeTaps: s.quantizeTaps };
  }

  /** The text that will be saved (paste mode adds header lines for overrides). */
  private composedText(): string {
    const s = this.state;
    if (s.mode === 'align') return s.raw;
    const tuning = TUNING_CHOICES.find((t) => t.id === s.tuning)?.midi;
    return composeText(
      s.raw,
      {
        ...(tuning ? { tuning } : {}),
        ...(s.capo !== null ? { capo: s.capo } : {}),
        ...(s.bpmTouched ? { bpm: s.bpm } : {}),
        ...(s.timeSigTouched ? { timeSig: s.timeSig } : {}),
      },
      s.parse.tab,
    );
  }

  private bundleFor(sidecar: RhythmSidecar): SongBundle {
    const s = this.state;
    if (s.mode === 'align' && s.bundle) return { ...s.bundle, sidecar };
    const fileName = previewFileName(this.titleInput.value, this.artistInput.value);
    return { fileName, data: new TextEncoder().encode(this.composedText()), source: { source: 'local', path: fileName }, sidecar };
  }

  // -------------------------------------------------------------------------------------------
  // Rendering helpers
  // -------------------------------------------------------------------------------------------

  private renderParse(): void {
    const p = this.state.parse;
    const tab = p.tab;
    const chips: Node[] = [];
    if (tab && p.onsets > 0) {
      chips.push(
        stat('Tuning', p.tuningLabel),
        stat('Bars', String(p.bars)),
        stat('Onsets', String(p.onsets)),
        stat('Notes', String(p.notes)),
      );
      if (tab.header.tempo) chips.push(stat('Tempo', `${tab.header.tempo} BPM`));
      if (tab.header.timeSig) chips.push(stat('Time', `${tab.header.timeSig[0]}/${tab.header.timeSig[1]}`));
      if (tab.header.capo) chips.push(stat('Capo', String(tab.header.capo)));
    }
    this.summary.replaceChildren(
      ...(chips.length
        ? chips
        : [h('p', { class: 'rw-muted imp-summary__empty' }, this.state.raw.trim() ? 'No tab staff found yet.' : 'Nothing pasted yet.')]),
    );

    this.warnings.replaceChildren(
      ...p.warnings.map((w) =>
        h(
          'li',
          { class: `imp-warning imp-warning--${w.severity}` },
          icon(w.severity === 'info' ? 'info' : w.severity === 'error' ? 'error' : 'warning', { size: '1em' }),
          w.line !== undefined
            ? h('button', { type: 'button', class: 'imp-warning__line', on: { click: () => this.goToLine(w.line as number) } }, `Line ${w.line}`)
            : null,
          h('span', null, w.message),
        ),
      ),
    );

    const lines = this.state.raw.split(/\r\n|\r|\n/);
    const rows: Node[] = [];
    if (this.state.raw.trim()) {
      lines.forEach((text, i) => {
        const n = i + 1;
        const cls = p.unparsedLines.has(n) ? 'imp-line imp-line--bad' : p.staffLines.has(n) ? 'imp-line imp-line--staff' : 'imp-line';
        rows.push(h('div', { class: cls, dataset: { line: String(n) } }, h('span', { class: 'imp-line__no' }, String(n)), h('span', { class: 'imp-line__text' }, text || ' ')));
      });
    }
    this.parsedView.replaceChildren(...rows);
    this.parsedView.hidden = rows.length === 0;
  }

  /** Select a line in the text box and scroll the parsed view to it. */
  private goToLine(line: number): void {
    const lines = this.textarea.value.split('\n');
    let start = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) start += lines[i].length + 1;
    const end = start + (lines[line - 1]?.length ?? 0);
    this.textarea.focus();
    this.textarea.setSelectionRange(start, end);
    const lineHeight = parseFloat(getComputedStyle(this.textarea).lineHeight) || 18;
    this.textarea.scrollTop = Math.max(0, (line - 4) * lineHeight);
    this.parsedView.querySelector(`[data-line="${line}"]`)?.scrollIntoView?.({ block: 'center' });
  }

  private syncTuningOptions(): void {
    const detected = this.state.parse.tab ? describeTuning(this.state.parse.tab.tuning).label : 'Standard';
    this.tuningSelect.setOptions([
      { value: 'auto', label: `As detected (${detected})` },
      ...TUNING_CHOICES.map((t) => ({ value: t.id, label: describeTuning(t.midi).label })),
    ]);
    this.tuningSelect.set(this.state.tuning);
  }

  private syncTimeSigOptions(): void {
    const [n, d] = this.state.timeSig;
    const value = `${n}/${d}`;
    const opts = TIME_SIGNATURES.map(([a, b]) => ({ value: `${a}/${b}`, label: `${a}/${b}` }));
    if (!opts.some((o) => o.value === value)) opts.push({ value, label: value });
    this.timeSigSelect.setOptions(opts);
    this.timeSigSelect.set(value);
  }

  /** Warn when string labels in the tab override the chosen tuning. */
  private updateTuningNote(song: Song): void {
    if (this.state.mode !== 'paste') return;
    const want = TUNING_CHOICES.find((t) => t.id === this.state.tuning)?.midi;
    const mismatch = !!want && !want.every((m, i) => m === song.meta.tuning[i]);
    this.tuningNote.hidden = !mismatch;
    this.tuningNote.textContent = mismatch
      ? `The string labels in the tab say ${describeTuning(song.meta.tuning).label}; edit the labels to change the tuning.`
      : '';
  }

  private onTitleInput(): void {
    this.state.titleTouched = true;
    this.updateNames();
  }

  /** Update the UG link and the "saves as" note from the title/artist fields. */
  private updateNames(): void {
    if (this.state.mode !== 'paste') return;
    const query = [this.artistInput.value, this.titleInput.value].map((v) => v.trim()).filter(Boolean).join(' ');
    this.ugLink.href = ugSearchUrl(query);
    this.updateSaveState();
  }

  private updateSaveState(): void {
    const s = this.state;
    let problem: string | null = null;
    if (!s.parse.tab || s.parse.onsets === 0) problem = s.mode === 'align' ? 'The tab has no notes.' : 'Paste a tab to continue.';
    else if (s.mode === 'paste' && !this.titleInput.value.trim()) problem = 'Add a title to save.';
    else if (s.previewError) problem = s.previewError;
    else if (s.phase === 'tapping') problem = 'Stop tapping to save.';
    this.saveBtn.disabled = problem !== null;
    if (problem) this.saveNote.textContent = problem;
    else if (s.mode === 'align') this.saveNote.textContent = 'Saves the rhythm next to the song; the tab file is not changed.';
    else this.saveNote.textContent = `Saves “${previewFileName(this.titleInput.value, this.artistInput.value)}” to your library with its rhythm.`;
    const duration = s.previewSong ? formatTime(s.previewSong.meta.durationSec) : '–';
    this.voiceNote.textContent = s.previewSong
      ? `${s.previewSong.timing.bars.length} bars · ${duration} at ${s.bpm} BPM${this.audio.voice === 'pluck' ? ' · simple preview sound (the guide synth is not available)' : ''}`
      : s.previewError ?? 'The preview appears once a tab is pasted.';
    this.playBtn.disabled = !s.previewSong || s.phase === 'tapping';
  }

  private updateTapUi(): void {
    if (!this.tapStatus) return;
    const s = this.state;
    const groups = s.parse.tab?.groups ?? [];
    const total = groups.length;
    const tapping = s.phase === 'tapping';
    const done = s.taps.length;
    setButton(this.tapStartBtn, tapping ? 'Stop' : done > 0 && done < total ? 'Continue tapping' : 'Start tapping', tapping ? 'pause' : 'play');
    this.tapStartBtn.disabled = total === 0;
    this.tapUndoBtn.disabled = done === 0;
    this.tapPad.disabled = !tapping;
    this.tapPad.classList.toggle('imp-tap-pad--live', tapping);
    this.restartBtn.disabled = total === 0;
    const lastBar = total ? groups[total - 1].bar + 1 : 1;
    this.restartBarInput.max = String(lastBar);
    const next = groups[done];
    this.tapStatus.textContent =
      total === 0
        ? 'Paste a tab first.'
        : done >= total
          ? `All ${total} onsets tapped. Preview it below, or undo / restart to fix a spot.`
          : `${done} of ${total} onsets tapped${next ? ` · next in bar ${next.bar + 1}` : ''}${done > 0 && !tapping ? ' · the rest are estimated' : ''}`;
    this.nextUp.replaceChildren(
      ...groups.slice(done, done + NEXT_UP).map((g, k) => {
        const frets: (string | null)[] = [null, null, null, null, null, null];
        for (const n of g.notes) frets[n.string - 1] = n.tech.dead ? 'x' : String(n.fret);
        return h(
          'div',
          { class: `imp-next__col${k === 0 ? ' imp-next__col--now' : ''}` },
          ...frets.map((f, i) => h('span', { class: 'imp-next__cell', style: f === null ? undefined : `--lane: var(--string-${i + 1})` }, f ?? '·')),
        );
      }),
    );
    const highlightTime = tapping && s.previewSong && done < total ? (s.onsets[done] ?? null) : null;
    this.strip.setHighlight(highlightTime);
  }

  // -------------------------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------------------------

  private async openFile(file: File): Promise<void> {
    if (file.size > 20 * 1024 * 1024) {
      this.ctx.ui.toast('That file is larger than 20 MB.', { kind: 'error' });
      return;
    }
    const text = decodeText(new Uint8Array(await file.arrayBuffer()));
    if (this.destroyed) return;
    this.textarea.value = text;
    const stem = file.name.replace(/\.[^.]+$/, '');
    const dash = /^(.+?)\s+-\s+(.+)$/.exec(stem);
    if (!this.state.titleTouched) {
      this.titleInput.value = dash ? dash[2].trim() : stem.replace(/_+/g, ' ').trim();
      this.state.titleTouched = true;
    }
    if (!this.state.artistTouched && dash) {
      this.artistInput.value = dash[1].trim();
      this.state.artistTouched = true;
    }
    this.reparse();
  }

  private tapTempo(timeStampMs: number): void {
    this.tempoTaps.push(timeStampMs);
    if (this.tempoTaps.length > 32) this.tempoTaps.splice(0, this.tempoTaps.length - 32);
    const bpm = tapTempoBpm(this.tempoTaps);
    if (bpm === null) return;
    this.state.bpm = bpm;
    this.state.bpmTouched = true;
    this.bpmInput.value = String(bpm);
    this.bpmInput.removeAttribute('aria-invalid');
    this.refresh();
  }

  private onKeyDown(ev: KeyboardEvent): void {
    const target = ev.target as HTMLElement | null;
    const typing = !!target && (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && !['radio', 'checkbox', 'range'].includes((target as HTMLInputElement).type)) || target.tagName === 'SELECT');
    if (this.state.phase === 'tapping') {
      if (ev.key === ' ' || ev.code === 'Space') {
        ev.preventDefault();
        ev.stopPropagation();
        if (!ev.repeat) this.tap(ev.timeStamp);
      } else if (ev.key === 'Backspace' && !typing) {
        ev.preventDefault();
        this.undoTap();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.stopTapping();
      }
      return;
    }
    if (!typing && (ev.key === 't' || ev.key === 'T') && !ev.repeat && !ev.metaKey && !ev.ctrlKey && !ev.altKey) this.tapTempo(ev.timeStamp);
  }

  private async toggleTapping(): Promise<void> {
    if (this.state.phase === 'tapping') {
      this.stopTapping();
      return;
    }
    const groups = this.state.parse.tab?.groups ?? [];
    if (this.state.taps.length >= groups.length) this.state.taps = [];
    await this.resumeTapping(groups[this.state.taps.length]?.bar ?? 0);
  }

  private async restartTapping(): Promise<void> {
    this.stopTapping();
    await this.resumeTapping(Math.max(1, Math.round(Number(this.restartBarInput.value) || 1)) - 1);
  }

  /** Keep the taps before `bar` (0-based) and start the metronome a bar before it. */
  private async resumeTapping(bar: number): Promise<void> {
    const groups = this.state.parse.tab?.groups ?? [];
    if (!groups.length) return;
    const { taps, from } = restartFromBar(this.state.taps, groups, bar, this.state.bpm, this.state.timeSig);
    this.state.taps = taps;
    await this.startTapping(from);
  }

  private async startTapping(from: number): Promise<void> {
    this.stopPlayback();
    const s = this.state;
    const all = computeOnsets(s.parse.tab?.groups ?? [], { ...this.choice(this.effectiveGrid()), quantizeTaps: false });
    const timeline: TransportTimeline = tapTimeline(all, s.bpm, s.timeSig);
    s.phase = 'tapping';
    s.tapFrom = from;
    this.refresh();
    try {
      await this.audio.start(timeline, null, { speed: s.tapSpeed, from, metronome: true, countInBars: 1 });
    } catch (err) {
      s.phase = 'idle';
      this.refresh();
      this.audioError(err);
      return;
    }
    if (this.state.phase !== 'tapping') return;
    this.tapPad.focus();
    this.loop();
  }

  private stopTapping(): void {
    if (this.state.phase !== 'tapping') return;
    this.audio.stop();
    this.state.phase = 'idle';
    this.strip.setPlayhead(null);
    this.refresh();
  }

  /** One tap at event time `timeStampMs` (ms since time origin). */
  private tap(timeStampMs: number): void {
    const s = this.state;
    if (s.phase !== 'tapping') return;
    const t = this.audio.eventSongTime(timeStampMs);
    if (t === null) return;
    const beat = (60 / s.bpm) * (4 / s.timeSig[1]);
    if (t < s.tapFrom - beat / 4) return; // count-in
    const total = s.parse.tab?.groups.length ?? 0;
    const next = addTap(s.taps, t, total);
    if (next.length === s.taps.length) return;
    s.taps = next;
    this.tapPad.classList.remove('imp-tap-pad--hit');
    void this.tapPad.offsetWidth;
    this.tapPad.classList.add('imp-tap-pad--hit');
    if (next.length >= total) {
      this.stopTapping();
      this.ctx.ui.toast(`All ${total} onsets tapped. Play the preview to check it.`, { kind: 'success' });
      return;
    }
    this.refresh();
  }

  private undoTap(): void {
    if (!this.state.taps.length) return;
    this.state.taps = this.state.taps.slice(0, -1);
    this.refresh();
  }

  private async togglePreview(): Promise<void> {
    if (this.state.phase === 'preview') this.stopPlayback();
    else await this.startPreview(0);
  }

  private async startPreview(from: number): Promise<void> {
    const s = this.state;
    if (!s.previewSong || s.phase === 'tapping') return;
    const song = s.previewSong;
    s.phase = 'preview';
    this.setPlayLabel(true);
    try {
      await this.audio.start({ durationSec: song.meta.durationSec, bars: song.timing.bars }, { song, bundle: s.previewBundle }, {
        speed: s.previewSpeed,
        from,
        metronome: s.click,
        countInBars: 0,
      });
    } catch (err) {
      this.stopPlayback();
      this.audioError(err);
      return;
    }
    if (s.phase !== 'preview' || s.previewSong !== song) return;
    this.updateSaveState();
    this.loop();
  }

  private stopPlayback(): void {
    if (this.state.phase !== 'preview') return;
    this.audio.stop();
    this.state.phase = 'idle';
    this.setPlayLabel(false);
    this.strip.setPlayhead(null);
  }

  private setPlayLabel(playing: boolean): void {
    setButton(this.playBtn, playing ? 'Stop' : 'Play preview', playing ? 'pause' : 'play');
  }

  /** Playhead animation while previewing or tapping. */
  private loop(): void {
    cancelAnimationFrame(this.raf);
    const frame = (): void => {
      if (this.destroyed || this.state.phase === 'idle') return;
      const t = this.audio.heardSongTime();
      if (t !== null && Number.isFinite(t)) this.strip.setPlayhead(t, true);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private audioError(err: unknown): void {
    if (err instanceof Error && err.name === 'AudioGestureDismissedError') return;
    this.ctx.ui.toast(`Audio could not start: ${errorText(err)}`, { kind: 'error' });
  }

  private async save(): Promise<void> {
    const s = this.state;
    this.stopPlayback();
    this.stopTapping();
    const total = s.parse.tab?.groups.length ?? 0;
    if (!s.previewSong || total === 0) return;
    if (s.method === 'tap' && s.taps.length < total) {
      const ok = await this.ctx.ui.confirm(`Only ${s.taps.length} of ${total} onsets were tapped; the rest use an estimate from the tab spacing. Save anyway?`, {
        title: 'Save an incomplete tap-along?',
        confirmLabel: 'Save anyway',
      });
      if (!ok) return;
    }
    const grid = this.effectiveGrid();
    const sidecar = buildSidecar(computeOnsets(s.parse.tab?.groups ?? [], this.choice(grid)), this.choice(grid), Date.now());
    setBusy(this.saveBtn, true);
    try {
      let id: string;
      if (s.mode === 'align' && s.songId) {
        await this.ctx.api.putSidecar(s.songId, sidecar);
        id = s.songId;
        this.ctx.ui.toast('Rhythm saved.', { kind: 'success' });
      } else {
        const title = this.titleInput.value.trim();
        const artist = this.artistInput.value.trim();
        const res = await this.ctx.api.paste({ title, ...(artist ? { artist } : {}), text: this.composedText(), sidecar });
        id = res.id;
        this.ctx.ui.toast(`Saved “${title}” to your library (${res.path}).`, { kind: 'success' });
      }
      if (!this.destroyed) this.ctx.router.navigate(this.ctx.router.href('song', { id }));
    } catch (err) {
      this.ctx.ui.toast(`Could not save: ${errorText(err)}`, { kind: 'error' });
    } finally {
      if (!this.destroyed) {
        setBusy(this.saveBtn, false);
        this.updateSaveState();
      }
    }
  }
}

/** A labelled field around an input. */
function field(label: string, id: string, input: HTMLElement, hint?: string): HTMLElement {
  const hintId = hint ? uid('hint') : undefined;
  if (hintId) input.setAttribute('aria-describedby', hintId);
  return h(
    'div',
    { class: 'rw-field' },
    h('label', { class: 'rw-field__label', for: id }, label),
    input,
    hint ? h('p', { class: 'rw-field__hint', id: hintId }, hint) : null,
  );
}

/** Change a kit button's label and leading icon in place. */
function setButton(btn: HTMLButtonElement, label: string, name: IconName): void {
  const labelEl = btn.querySelector('.rw-btn__label');
  if (labelEl) labelEl.textContent = label;
  btn.querySelector('svg')?.replaceWith(icon(name));
}

/** One summary stat chip. */
function stat(label: string, value: string): HTMLElement {
  return h('div', { class: 'imp-stat' }, h('span', { class: 'imp-stat__label' }, label), h('span', { class: 'imp-stat__value rw-num' }, value));
}

function formatTime(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

