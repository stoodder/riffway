/**
 * Library & sources settings: the library folder and drop subfolder (`PUT /api/config`, path checked
 * with the library screen's `validateLibraryPath`), rescan, enabled sources, and ClassTab's status
 * and refresh with live progress from `classtab.progress` events.
 * @module
 */
import type { ClassTabStatus, ServerConfig, ServerEvent } from '@shared/api';
import type { SourceId } from '@shared/song';
import type { SourceStatus } from '@shared/sources';
import type { Unsubscribe } from '@shared/clock';
import type { AppContext } from '@shared/ui';
import { ApiError } from '../../../api/client';
import { badge, button, h, icon, setBusy, toggle, uid, type BadgeTone } from '../../components';
import { classtabProgress } from '../library/classtab-offer';
import { validateLibraryPath } from '../library/library-folder';
import { group, section } from './controls';

/** Sources refresh this long after the last library/index event (ms). */
export const SOURCES_REFRESH_DEBOUNCE_MS = 500;

/**
 * Validate the drop subfolder (relative to the library folder; `''` = the folder itself). Returns
 * an error message or null. The server normalises and has the final word.
 */
export function validateImportSubfolder(raw: string): string | null {
  const sub = raw.trim();
  if (!sub) return null;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f]/.test(sub)) return 'The folder name contains invalid characters.';
  if (/^([/\\]|~|[A-Za-z]:)/.test(sub)) return 'Use a folder inside the library, like Imported (not a full path).';
  if (sub.split(/[/\\]+/).some((seg) => seg === '..')) return 'The folder must stay inside the library (no “..”).';
  return null;
}

/** A readable message for a failed server call. */
export function serverError(err: unknown): string {
  if (err instanceof ApiError && err.status > 0) return err.message;
  return "Can't reach the Riffway companion server. Start it with npm run dev (or npm start), then try again.";
}

const nf = new Intl.NumberFormat('en-US');

/** When something happened, e.g. `19 Nov 2026, 20:00`. */
export function formatWhen(at: number): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(at);
}

/** ClassTab state as a badge and summary lines. */
export function classtabSummary(s: ClassTabStatus): { badge: { text: string; tone: BadgeTone }; lines: string[] } {
  const lines: string[] = [];
  if (s.state === 'not-downloaded') {
    lines.push('Not downloaded yet. Riffway fetches ClassTab’s official zip (about 14 MB) once, then checks for monthly updates when you ask.');
  } else {
    lines.push(`${nf.format(s.tabs)} tabs · ${nf.format(s.midis)} MIDI files`);
    lines.push(
      `Rhythm: ${nf.format(s.rhythm.midi)} from MIDI · ${nf.format(s.rhythm.ruler)} from the beat ruler · ${nf.format(s.rhythm.needsAlignment)} need alignment`,
    );
  }
  if (s.lastRefresh !== null) lines.push(`Last checked ${formatWhen(s.lastRefresh)}${s.lastModified ? ` · zip dated ${formatWhen(Date.parse(s.lastModified))}` : ''}`);
  if (s.state === 'error' && s.error) lines.push(`Last refresh failed: ${s.error}`);
  const badges: Record<ClassTabStatus['state'], { text: string; tone: BadgeTone }> = {
    'not-downloaded': { text: 'Not downloaded', tone: 'neutral' },
    ready: { text: 'Ready', tone: 'success' },
    refreshing: { text: 'Refreshing', tone: 'info' },
    error: { text: 'Error', tone: 'danger' },
  };
  return { badge: badges[s.state], lines };
}

/** Progress text for a `classtab.progress` event (shared with the library's ClassTab offer). */
export { classtabProgress };

const KIND_TEXT: Record<SourceStatus['kind'], string> = {
  library: 'Files on this computer',
  download: 'Downloaded bundle',
  'link-out': 'Link-out search (opens the site)',
};

const STATE_BADGE: Record<SourceStatus['state'], { text: string; tone: BadgeTone } | null> = {
  idle: null,
  indexing: { text: 'Indexing', tone: 'info' },
  refreshing: { text: 'Refreshing', tone: 'info' },
  error: { text: 'Error', tone: 'danger' },
  'not-downloaded': { text: 'Not downloaded', tone: 'neutral' },
};

/** The Library & sources tab. */
export function libraryTab(ctx: AppContext): { el: HTMLElement; destroy(): void } {
  let config: ServerConfig | null = null;
  let sources: SourceStatus[] = [];
  let destroyed = false;
  let sourcesTimer: ReturnType<typeof setTimeout> | undefined;
  const unsubs: Unsubscribe[] = [];

  // ---- Server error banner --------------------------------------------------------------------
  const banner = h('div', { class: 'set-banner', role: 'alert', hidden: true });
  const showBanner = (message: string | null): void => {
    banner.hidden = message === null;
    banner.replaceChildren();
    if (message) banner.append(icon('warning'), h('span', null, message), button({ label: 'Try again', size: 'sm', onClick: () => void load() }));
  };

  // ---- Library folder ---------------------------------------------------------------------------
  const dirId = uid('set-dir');
  const subId = uid('set-sub');
  const dirError = h('p', { class: 'set-field__error', id: `${dirId}-err`, role: 'alert' });
  const subError = h('p', { class: 'set-field__error', id: `${subId}-err`, role: 'alert' });
  const dirInput = h('input', {
    id: dirId,
    class: 'set-input set-input--mono',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-describedby': `${dirId}-hint ${dirId}-err`,
  });
  const subInput = h('input', {
    id: subId,
    class: 'set-input set-input--mono',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: '(the library folder itself)',
    'aria-describedby': `${subId}-hint ${subId}-err`,
  });
  const save = button({ label: 'Save', variant: 'primary', size: 'sm', type: 'submit', disabled: true });
  const rescan = button({
    label: 'Rescan library',
    size: 'sm',
    variant: 'ghost',
    icon: 'loop',
    onClick: async () => {
      setBusy(rescan, true);
      try {
        await ctx.api.rescan();
        ctx.ui.toast('Rescanning your library…', { kind: 'info' });
      } catch (err) {
        ctx.ui.toast(`Rescan failed: ${serverError(err)}`, { kind: 'error' });
      } finally {
        setBusy(rescan, false);
      }
    },
  });
  const setError = (input: HTMLInputElement, out: HTMLElement, message: string | null): void => {
    out.textContent = message ?? '';
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  };
  const dirty = (): boolean => config !== null && (dirInput.value.trim() !== config.libraryDir || subInput.value.trim() !== config.importSubfolder);
  const onEdit = (): void => {
    save.disabled = !dirty();
    if (dirInput.getAttribute('aria-invalid')) setError(dirInput, dirError, validateLibraryPath(dirInput.value));
    if (subInput.getAttribute('aria-invalid')) setError(subInput, subError, validateImportSubfolder(subInput.value));
  };
  dirInput.addEventListener('input', onEdit);
  subInput.addEventListener('input', onEdit);
  const folderForm = h(
    'form',
    { class: 'set-folder', novalidate: true },
    h(
      'div',
      { class: 'rw-field' },
      h('label', { class: 'rw-field__label', for: dirId }, 'Library folder'),
      dirInput,
      h('p', { class: 'rw-field__hint', id: `${dirId}-hint` }, 'The folder’s full path on this computer, for example ~/Music/Tabs. Riffway watches it and creates it if needed.'),
      dirError,
    ),
    h(
      'div',
      { class: 'rw-field' },
      h('label', { class: 'rw-field__label', for: subId }, 'Dropped files go to'),
      subInput,
      h('p', { class: 'rw-field__hint', id: `${subId}-hint` }, 'A subfolder of the library for files you drag in, for example Imported. Leave empty for the library folder itself.'),
      subError,
    ),
    h('div', { class: 'set-folder__actions' }, save, rescan),
  );
  folderForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!config) return;
    const dirProblem = validateLibraryPath(dirInput.value);
    const subProblem = validateImportSubfolder(subInput.value);
    setError(dirInput, dirError, dirProblem);
    setError(subInput, subError, subProblem);
    if (dirProblem || subProblem) {
      (dirProblem ? dirInput : subInput).focus();
      return;
    }
    const update: { libraryDir?: string; importSubfolder?: string } = {};
    if (dirInput.value.trim() !== config.libraryDir) update.libraryDir = dirInput.value.trim();
    if (subInput.value.trim() !== config.importSubfolder) update.importSubfolder = subInput.value.trim();
    setBusy(save, true);
    try {
      const next = await ctx.api.putConfig(update);
      applyConfig(next);
      ctx.ui.toast(update.libraryDir ? `Library folder set to ${next.libraryDir}. Scanning it now…` : 'Library settings saved.', { kind: 'success' });
    } catch (err) {
      const message = serverError(err);
      if (update.libraryDir !== undefined || update.importSubfolder === undefined) setError(dirInput, dirError, message);
      else setError(subInput, subError, message);
    } finally {
      setBusy(save, false);
      save.disabled = !dirty();
    }
  });

  function applyConfig(next: ServerConfig): void {
    config = next;
    dirInput.value = next.libraryDir;
    subInput.value = next.importSubfolder;
    setError(dirInput, dirError, null);
    setError(subInput, subError, null);
    save.disabled = true;
    renderSources();
  }

  // ---- Sources ------------------------------------------------------------------------------------
  const sourceList = h('ul', { class: 'set-sources', 'aria-label': 'Song sources' });
  function renderSources(): void {
    sourceList.replaceChildren(
      ...sources.map((s) => {
        const enabled = config ? config.enabledSources.includes(s.id) : s.enabled;
        const state = STATE_BADGE[s.state];
        const sw = toggle({
          label: s.displayName,
          description: s.kind === 'link-out' ? KIND_TEXT[s.kind] : `${KIND_TEXT[s.kind]} · ${nf.format(s.indexed)} indexed`,
          checked: enabled,
          onChange: (on) => void setSource(s.id, on, sw.set),
        });
        if (state) sw.el.querySelector('.rw-field__label')?.append(badge(state.text, { tone: state.tone, title: s.message }));
        return h('li', { class: 'set-source', dataset: { source: s.id } }, sw.el);
      }),
    );
  }
  async function setSource(id: SourceId, on: boolean, revert: (checked: boolean) => void): Promise<void> {
    if (!config) return;
    const set = new Set(config.enabledSources);
    if (on) set.add(id);
    else set.delete(id);
    try {
      config = await ctx.api.putConfig({ enabledSources: [...set] });
      ctx.ui.toast(`${sources.find((s) => s.id === id)?.displayName ?? id} ${on ? 'enabled' : 'disabled'}.`, { kind: 'success' });
    } catch (err) {
      revert(!on);
      ctx.ui.toast(`Couldn’t change the source: ${serverError(err)}`, { kind: 'error' });
    }
  }
  async function refreshSources(): Promise<void> {
    try {
      sources = (await ctx.api.sources()).sources;
      if (!destroyed) renderSources();
    } catch {
      // Keep the last list; the banner covers an unreachable server on load.
    }
  }

  // ---- ClassTab -------------------------------------------------------------------------------------
  const ctBadge = h('span', { class: 'set-ct__badge' });
  const ctLines = h('div', { class: 'set-ct__lines' });
  const ctProgressText = h('p', { class: 'set-ct__progress-text', role: 'status', 'aria-live': 'polite' });
  const ctBar = h('progress', { class: 'set-ct__bar', max: '1', hidden: true, 'aria-label': 'ClassTab download progress' });
  const ctReason = h('p', { class: 'set-ct__reason', hidden: true });
  const ctForce = button({ label: 'Check anyway', size: 'sm', variant: 'ghost', onClick: () => void refreshClassTab(true) });
  ctForce.hidden = true;
  const ctRefresh = button({ label: 'Check for update', size: 'sm', icon: 'loop', onClick: () => void refreshClassTab(false) });
  let ctStatus: ClassTabStatus | null = null;
  let ctRunning = false;
  /** Whether the latest progress event ended a refresh; null when none arrived since the last request. */
  let ctLastFinished: boolean | null = null;

  function renderClassTab(): void {
    if (!ctStatus) return;
    const sum = classtabSummary(ctStatus);
    ctBadge.replaceChildren(badge(sum.badge.text, { tone: sum.badge.tone }));
    ctLines.replaceChildren(...sum.lines.map((l) => h('p', null, l)));
    (ctRefresh.querySelector('.rw-btn__label') as HTMLElement).textContent = ctStatus.state === 'not-downloaded' ? 'Download ClassTab' : 'Check for update';
    ctRefresh.disabled = ctRunning || ctStatus.state === 'refreshing' || ctRefresh.hasAttribute('aria-busy');
  }
  async function loadClassTab(): Promise<void> {
    try {
      ctStatus = await ctx.api.classtabStatus();
      if (!destroyed) renderClassTab();
    } catch {
      // Covered by the banner.
    }
  }
  async function refreshClassTab(force: boolean): Promise<void> {
    ctReason.hidden = true;
    ctForce.hidden = true;
    setBusy(ctRefresh, true);
    ctLastFinished = null;
    try {
      const res = await ctx.api.classtabRefresh(force ? { force: true } : {});
      if (res.started) {
        // Progress events can beat the response; a refresh that already finished stays finished.
        ctRunning = ctLastFinished !== true;
        if (ctLastFinished === null) ctProgressText.textContent = 'Starting…';
      } else {
        ctReason.textContent = res.reason ?? 'A refresh isn’t needed right now.';
        ctReason.hidden = false;
        ctForce.hidden = force;
      }
    } catch (err) {
      ctProgressText.textContent = `Refresh failed: ${serverError(err)}`;
    } finally {
      setBusy(ctRefresh, false);
      renderClassTab();
    }
  }
  function onClassTabProgress(ev: Extract<ServerEvent, { type: 'classtab.progress' }>): void {
    const p = classtabProgress(ev);
    ctProgressText.textContent = p.text;
    ctBar.hidden = p.fraction === null || p.finished;
    if (p.fraction !== null) ctBar.value = p.fraction;
    ctRunning = !p.finished;
    ctLastFinished = p.finished;
    if (p.finished) {
      void loadClassTab();
      void refreshSources();
    }
    renderClassTab();
  }

  const classtab = h(
    'div',
    { class: 'set-ct' },
    h('div', { class: 'set-ct__head' }, h('h3', { class: 'set-group__title' }, 'ClassTab'), ctBadge),
    ctLines,
    h('div', { class: 'set-ct__progress' }, ctProgressText, ctBar),
    h('div', { class: 'rw-row' }, ctRefresh, ctForce),
    ctReason,
    h(
      'p',
      { class: 'rw-field__hint' },
      'ClassTab publishes no license, so its tabs stay on this computer for your own practice: Riffway never copies or shares them.',
    ),
  );

  // ---- Events and loading ---------------------------------------------------------------------------
  unsubs.push(
    ctx.api.subscribe((ev) => {
      if (destroyed) return;
      if (ev.type === 'classtab.progress') onClassTabProgress(ev);
      else {
        clearTimeout(sourcesTimer);
        sourcesTimer = setTimeout(() => void refreshSources(), SOURCES_REFRESH_DEBOUNCE_MS);
      }
    }),
  );

  async function load(): Promise<void> {
    try {
      const [cfg, src] = await Promise.all([ctx.api.getConfig(), ctx.api.sources()]);
      if (destroyed) return;
      sources = src.sources;
      applyConfig(cfg);
      showBanner(null);
      await loadClassTab();
    } catch (err) {
      if (!destroyed) showBanner(serverError(err));
    }
  }
  void load();

  const el = h(
    'div',
    { class: 'set-tab' },
    banner,
    section('Library folder', 'Where your song files live. Riffway indexes everything in it, including subfolders.', group(null, folderForm)),
    section(
      'Sources',
      'Where search looks. Link-out sources never contact the site from Riffway; they open a search in a new tab.',
      group(null, sourceList),
      group(null, classtab),
    ),
  );
  return {
    el,
    destroy() {
      destroyed = true;
      clearTimeout(sourcesTimer);
      for (const u of unsubs.splice(0)) u();
    },
  };
}
