/**
 * ClassTab in the library (R2-U-12 / R2-S-05): while ClassTab is enabled but not downloaded yet, the
 * "Find more tabs" section offers it in one low-key card ("Download ClassTab (≈14 MB,
 * classical/fingerstyle)"). The button starts the same server refresh as Settings → Library & sources
 * (`POST /api/classtab/refresh`) and shows its `classtab.progress` events live; when the download is
 * indexed the card hides and the library refreshes. ClassTab's content stays on this computer (D2).
 * @module
 */
import type { ApiClient, ClassTabStatus, ServerConfig, ServerEvent } from '@shared/api';
import { button, h, icon, setBusy } from '../../components';

type ClassTabProgressEvent = Extract<ServerEvent, { type: 'classtab.progress' }>;

/** The download button's label (size from docs/sources/classtab.md). */
export const CLASSTAB_OFFER_LABEL = 'Download ClassTab (≈14 MB, classical/fingerstyle)';

const mb = (bytes: number): string => (bytes / 1_048_576).toFixed(1);

/** Progress text for a `classtab.progress` event, and the fraction when the size is known. */
export function classtabProgress(ev: ClassTabProgressEvent): { text: string; fraction: number | null; finished: boolean } {
  switch (ev.phase) {
    case 'checking':
      return { text: 'Checking classtab.org for an update…', fraction: null, finished: false };
    case 'downloading': {
      const total = ev.totalBytes ?? 0;
      const got = ev.bytes ?? 0;
      return {
        text: total > 0 ? `Downloading… ${mb(got)} of ${mb(total)} MB` : `Downloading… ${mb(got)} MB`,
        fraction: total > 0 ? Math.min(1, got / total) : null,
        finished: false,
      };
    }
    case 'extracting':
      return { text: 'Unpacking the zip…', fraction: null, finished: false };
    case 'indexing':
      return { text: 'Indexing tabs…', fraction: null, finished: false };
    case 'done':
      return { text: 'ClassTab is up to date.', fraction: 1, finished: true };
    case 'not-modified':
      return { text: 'No update: you already have the latest ClassTab.', fraction: null, finished: true };
    case 'error':
      return { text: `Refresh failed: ${ev.message ?? 'unknown error'}`, fraction: null, finished: true };
  }
}

/**
 * Whether the library offers the ClassTab download: the source is enabled (a player who switched it
 * off is not nagged) and nothing has been downloaded yet, or the first download failed.
 */
export function shouldOfferClassTab(status: Pick<ClassTabStatus, 'state' | 'tabs'>, config: Pick<ServerConfig, 'enabledSources'> | null): boolean {
  if (config && !config.enabledSources.includes('classtab')) return false;
  return status.state === 'not-downloaded' || (status.state === 'error' && status.tabs === 0) || (status.state === 'refreshing' && status.tabs === 0);
}

/** Options for {@link classtabOffer}. */
export interface ClassTabOfferOptions {
  api: Pick<ApiClient, 'classtabStatus' | 'classtabRefresh'>;
  /** The download finished (the library should reload its sources and results). */
  onReady: () => void;
}

/** A mounted ClassTab offer card. */
export interface ClassTabOffer {
  el: HTMLElement;
  /** Re-read the ClassTab status and show or hide the card for `config`. */
  load(config: ServerConfig | null): Promise<void>;
  /** Feed a server event (only `classtab.progress` matters). */
  onEvent(event: ServerEvent): void;
}

/** Create the ClassTab offer card (hidden until {@link ClassTabOffer.load} finds it relevant). */
export function classtabOffer(opts: ClassTabOfferOptions): ClassTabOffer {
  let config: ServerConfig | null = null;
  /** A refresh this card started (or saw running) has not finished yet. */
  let running = false;
  /** The last status read wanted the offer (an update of an existing download never shows it). */
  let offered = false;
  /** Whether the latest progress event ended a refresh; null when none arrived since the click. */
  let lastFinished: boolean | null = null;
  /** A click is waiting for the refresh response. */
  let starting = false;
  const progressText = h('p', { class: 'lib-classtab__progress', role: 'status', 'aria-live': 'polite' });
  const bar = h('progress', { class: 'lib-classtab__bar', max: '1', hidden: true, 'aria-label': 'ClassTab download progress' });
  const download = button({ label: CLASSTAB_OFFER_LABEL, variant: 'secondary', icon: 'import', onClick: () => void start() });
  const el = h(
    'div',
    { class: 'lib-linkout lib-classtab', dataset: { source: 'classtab' }, hidden: true },
    h('p', { class: 'lib-classtab__title' }, icon('library', { size: '18px' }), h('strong', null, 'ClassTab'), h('span', { class: 'rw-muted' }, 'not downloaded')),
    h(
      'p',
      { class: 'lib-linkout__hint' },
      'About 4,000 free classical and fingerstyle guitar tabs from classtab.org. Riffway downloads the official zip once and keeps it on this computer; it then shows up in this search.',
    ),
    download,
    progressText,
    bar,
  );

  function setRunning(on: boolean): void {
    running = on;
    download.disabled = on;
  }

  async function start(): Promise<void> {
    setBusy(download, true);
    progressText.textContent = 'Starting…';
    lastFinished = null;
    starting = true;
    try {
      const res = await opts.api.classtabRefresh({});
      // Progress events can beat the response; a refresh that already finished stays finished.
      if (res.started) setRunning(lastFinished !== true);
      else progressText.textContent = res.reason ?? 'ClassTab can’t be downloaded right now. Try again later from Settings → Library & sources.';
    } catch (err) {
      progressText.textContent = `Download failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      starting = false;
      setBusy(download, false);
      download.disabled = running;
    }
  }

  async function load(next: ServerConfig | null): Promise<void> {
    config = next;
    try {
      const status = await opts.api.classtabStatus();
      offered = shouldOfferClassTab(status, config);
      el.hidden = !offered && !running;
      if (offered && status.state === 'refreshing') setRunning(true);
    } catch {
      // The library shows its own "server unreachable" state; the offer just stays hidden.
      el.hidden = !running;
    }
  }

  return {
    el,
    load,
    onEvent(event) {
      if (event.type !== 'classtab.progress' || !(offered || running || starting)) return;
      const p = classtabProgress(event);
      progressText.textContent = p.text;
      bar.hidden = p.fraction === null || p.finished;
      if (p.fraction !== null) bar.value = p.fraction;
      setRunning(!p.finished);
      lastFinished = p.finished;
      if (p.finished) {
        if (event.phase === 'done' || event.phase === 'not-modified') opts.onReady();
        void load(config);
      }
    },
  };
}
