/**
 * Data settings (docs/progress.md § Export / import): what's stored, export to a JSON backup
 * (progress, settings and the server's rhythm-alignment sidecars), import with a preview, merge or
 * replace and readable validation errors, and resets behind a confirmation.
 * @module
 */
import { defaultSettings } from '@shared/settings';
import type { ExportFile, ExportStores, ImportMode, ImportPreview } from '@shared/storage';
import type { Unsubscribe } from '@shared/clock';
import type { AppContext } from '@shared/ui';
import { backupFileName, ImportValidationError, parseBackup, serializeBackup } from '../../../storage';
import { button, h, icon, setBusy, uid } from '../../components';
import { choiceGroup, group, section } from './controls';
import { formatWhen, serverError } from './library';

/** Largest backup file accepted (bytes); real backups are a few MB at most. */
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

/** Preview count rows, in display order. */
const COUNT_ROWS: readonly [keyof ImportPreview['counts'], string][] = [
  ['runs', 'Runs'],
  ['bests', 'Personal bests'],
  ['sectionProgress', 'Section progress'],
  ['practiceDays', 'Practice days'],
  // One record (the weekly streak state), not the streak length: Home shows the streak (R3-U-08).
  ['streak', 'Streak history'],
  ['songCache', 'Songs played'],
  ['audioLinks', 'Backing-audio links'],
  ['sidecars', 'Rhythm alignments'],
];

/** One row of the counts list: `value` is what it shows (the count, or "Saved" / "None"). */
export interface CountRow {
  key: string;
  label: string;
  count: number;
  value: string;
}

/**
 * Labeled counts for a preview (or for local data), in display order. The streak store holds one
 * record, so it reads "Saved" / "None" rather than a number that looks like a streak length.
 */
export function countRows(counts: ImportPreview['counts']): CountRow[] {
  return COUNT_ROWS.map(([key, label]) => {
    const count = counts[key];
    return { key, label, count, value: key === 'streak' ? (count > 0 ? 'Saved' : 'None') : String(count) };
  });
}

/** Counts of local store contents (no sidecars: those live on the server). */
export function storeCounts(stores: ExportStores): ImportPreview['counts'] {
  return {
    runs: stores.runs.length,
    bests: stores.bests.length,
    sectionProgress: stores.sectionProgress.length,
    practiceDays: stores.practiceDays.length,
    streak: stores.streak ? 1 : 0,
    audioLinks: stores.audioLinks.length,
    songCache: stores.songCache.length,
    sidecars: 0,
  };
}

/** Explanation of each import mode. */
export const MODE_TEXT: Readonly<Record<ImportMode, string>> = {
  merge: 'Keep your settings, devices and calibration, and add the backup’s progress. Where both have the same record, the better one is kept. Importing the same file twice changes nothing.',
  replace: 'Delete everything on this computer first, then restore the backup exactly, including its settings.',
};

/** A parsed backup chosen by the player. */
interface Chosen {
  name: string;
  preview: ImportPreview;
  file: ExportFile | null;
}

/** Start a browser download of `text` as `name`. */
export function downloadText(doc: Document, name: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The Data tab. */
export function dataTab(ctx: AppContext): { el: HTMLElement; destroy(): void } {
  const doc = document;
  let destroyed = false;
  const unsubs: Unsubscribe[] = [];

  // ---- What's stored ----------------------------------------------------------------------------
  const summary = h('dl', { class: 'set-counts set-counts--local' });
  let summaryTimer: ReturnType<typeof setTimeout> | undefined;
  async function loadSummary(): Promise<void> {
    try {
      const file = await ctx.storage.exportAll();
      if (destroyed) return;
      summary.replaceChildren(...countList(countRows(storeCounts(file.stores)).filter((r) => r.key !== 'sidecars')));
    } catch (err) {
      summary.replaceChildren(h('p', { class: 'set-field__error' }, `Couldn’t read local data: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  unsubs.push(
    ctx.storage.onChange(() => {
      clearTimeout(summaryTimer);
      summaryTimer = setTimeout(() => void loadSummary(), 100);
    }),
  );
  void loadSummary();

  // ---- Export -----------------------------------------------------------------------------------------
  const exportStatus = h('p', { class: 'set-data__status', role: 'status' });
  const exportBtn = button({ label: 'Export backup', variant: 'primary', icon: 'import', onClick: () => void doExport() });
  async function doExport(): Promise<void> {
    setBusy(exportBtn, true);
    try {
      const file = await ctx.storage.exportAll();
      let note = '';
      try {
        file.server.sidecars = (await ctx.api.getSidecars()).sidecars;
      } catch (err) {
        note = ` Rhythm alignments weren’t included: ${serverError(err)}`;
      }
      const name = backupFileName(Date.now());
      downloadText(doc, name, serializeBackup(file));
      exportStatus.textContent = `Saved ${name}.${note}`;
      ctx.ui.toast(`Backup saved as ${name}`, { kind: note ? 'warning' : 'success' });
    } catch (err) {
      exportStatus.textContent = `Export failed: ${err instanceof Error ? err.message : String(err)}`;
      ctx.ui.toast('Export failed', { kind: 'error' });
    } finally {
      setBusy(exportBtn, false);
    }
  }

  // ---- Import ---------------------------------------------------------------------------------------
  const fileId = uid('set-import');
  const fileInput = h('input', { id: fileId, type: 'file', accept: '.json,application/json', class: 'rw-visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  const choose = button({ label: 'Choose backup file…', onClick: () => fileInput.click() });
  const previewBox = h('div', { class: 'set-preview', hidden: true, 'aria-live': 'polite' });
  let chosen: Chosen | null = null;
  let mode: ImportMode = 'merge';
  const modeGroup = choiceGroup<ImportMode>({
    label: 'How to import',
    choices: [
      { value: 'merge', label: 'Merge', tag: 'Recommended', description: MODE_TEXT.merge },
      { value: 'replace', label: 'Replace', description: MODE_TEXT.replace },
    ],
    value: 'merge',
    onChange: (v) => {
      mode = v;
      renderPreview();
    },
  });
  const apply = button({ label: 'Import', variant: 'primary', onClick: () => void doImport() });
  const cancel = button({ label: 'Cancel', variant: 'ghost', onClick: () => clearChosen(true) });

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) void readChosen(f);
  });

  async function readChosen(f: File): Promise<void> {
    const checked = await checkFile(f);
    if (destroyed) return;
    chosen = { name: f.name, preview: checked.preview, file: checked.file };
    renderPreview();
    previewBox.querySelector<HTMLElement>('.set-preview__title')?.focus();
  }

  function renderPreview(): void {
    previewBox.hidden = chosen === null;
    if (!chosen) {
      previewBox.replaceChildren();
      return;
    }
    const { preview, name } = chosen;
    const title = h('h3', { class: 'set-preview__title', tabindex: '-1' }, preview.ok ? 'Ready to import' : 'This file can’t be imported');
    const meta = h(
      'p',
      { class: 'set-preview__meta rw-muted' },
      h('span', { class: 'set-preview__file' }, name),
      preview.exportedAt && !Number.isNaN(Date.parse(preview.exportedAt)) ? ` · exported ${formatWhen(Date.parse(preview.exportedAt))}` : null,
      preview.schemaVersion > 0 ? ` · schema ${preview.schemaVersion}` : null,
    );
    if (!preview.ok) {
      const shown = preview.errors.slice(0, 20);
      previewBox.className = 'set-preview set-preview--error';
      previewBox.replaceChildren(
        h('div', { class: 'set-preview__head' }, icon('error', { size: '20px' }), title),
        meta,
        h('p', null, shown.length > 1 ? `${shown.length} problems were found. Nothing has been changed.` : 'Nothing has been changed.'),
        h('ul', { class: 'set-preview__errors', role: 'alert' }, shown.map((e) => h('li', null, h('code', null, e)))),
        h('div', { class: 'rw-row' }, button({ label: 'Choose another file', onClick: () => fileInput.click() }), cancel),
      );
      return;
    }
    previewBox.className = 'set-preview';
    (apply.querySelector('.rw-btn__label') as HTMLElement).textContent = mode === 'replace' ? 'Replace my data' : 'Merge into my data';
    apply.className = `rw-btn rw-btn--${mode === 'replace' ? 'danger' : 'primary'} rw-btn--md`;
    previewBox.replaceChildren(
      h('div', { class: 'set-preview__head' }, icon('check', { size: '20px' }), title),
      meta,
      h('dl', { class: 'set-counts' }, countList(countRows(preview.counts))),
      modeGroup.el,
      h('div', { class: 'rw-row' }, apply, cancel),
    );
  }

  function clearChosen(focusChoose: boolean): void {
    chosen = null;
    mode = 'merge';
    modeGroup.set('merge');
    renderPreview();
    if (focusChoose) choose.focus();
  }

  async function doImport(): Promise<void> {
    if (!chosen?.file) return;
    const file = chosen.file;
    if (mode === 'replace') {
      const ok = await ctx.ui.confirm('Everything on this computer — runs, bests, progress, streak and settings — is replaced by the backup. This can’t be undone.', {
        title: 'Replace your data?',
        confirmLabel: 'Replace my data',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(apply, true);
    try {
      await ctx.storage.importAll(file, mode);
    } catch (err) {
      setBusy(apply, false);
      if (chosen) {
        chosen = {
          ...chosen,
          file: null,
          preview: { ...chosen.preview, ok: false, errors: err instanceof ImportValidationError ? err.errors : [`Import failed: ${err instanceof Error ? err.message : String(err)}`] },
        };
        renderPreview();
      }
      return;
    }
    const sidecars = file.server.sidecars;
    const n = Object.keys(sidecars).length;
    let warning = '';
    if (n > 0) {
      try {
        await ctx.api.postSidecars({ sidecars });
      } catch (err) {
        warning = ` Rhythm alignments weren’t restored: ${serverError(err)} Import the file again once the server is running.`;
      }
    }
    setBusy(apply, false);
    const done = mode === 'replace' ? 'Backup restored.' : 'Backup merged.';
    exportStatus.textContent = '';
    ctx.ui.toast(`${done}${warning}`, { kind: warning ? 'warning' : 'success', timeoutMs: warning ? 10_000 : undefined });
    clearChosen(true);
  }

  // ---- Reset ----------------------------------------------------------------------------------------
  const resetSettings = button({
    label: 'Restore default settings',
    onClick: async () => {
      const ok = await ctx.ui.confirm('Gameplay, practice, goals, keys, devices, monitoring and calibration go back to their defaults. Your progress is kept.', {
        title: 'Restore default settings?',
        confirmLabel: 'Restore defaults',
        danger: true,
      });
      if (!ok) return;
      try {
        await ctx.settings.replace(defaultSettings());
        ctx.ui.toast('Settings restored to defaults.', { kind: 'success' });
      } catch (err) {
        ctx.ui.toast(`Couldn’t reset settings: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
      }
    },
  });
  const resetAll = button({
    label: 'Delete all data…',
    variant: 'danger',
    onClick: async () => {
      const ok = await ctx.ui.confirm(
        'This deletes every run, best, section progress, practice day, your streak, backing-audio links and all settings on this computer. Song files in your library are not touched. Export a backup first if you might want it back.',
        { title: 'Delete all Riffway data?', confirmLabel: 'Delete everything', danger: true },
      );
      if (!ok) return;
      setBusy(resetAll, true);
      try {
        await ctx.storage.clearAll();
        ctx.ui.toast('All data deleted. Riffway is back to a fresh start.', { kind: 'success' });
      } catch (err) {
        ctx.ui.toast(`Couldn’t delete the data: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
      } finally {
        setBusy(resetAll, false);
      }
    },
  });

  const el = h(
    'div',
    { class: 'set-tab' },
    section('Your data', 'Progress and settings are stored in this browser only. Back them up before switching browsers or computers.', group(null, summary)),
    section(
      'Export',
      'One JSON file with your progress, settings and rhythm alignments. Backing-audio files are not included: re-attach them after restoring on another computer.',
      group(null, h('div', { class: 'rw-row' }, exportBtn), exportStatus),
    ),
    section('Import', 'Restore or combine a backup made by Riffway. You see what’s in it before anything changes.', group(null, h('div', { class: 'rw-row' }, choose, fileInput), previewBox)),
    section('Reset', null, group(null, h('div', { class: 'set-reset' }, resetSettings, resetAll))),
  );
  return {
    el,
    destroy() {
      destroyed = true;
      clearTimeout(summaryTimer);
      for (const u of unsubs.splice(0)) u();
    },
  };
}

function countList(rows: CountRow[]): HTMLElement[] {
  return rows.map((r) => h('div', { class: 'set-counts__item', dataset: { count: r.key } }, h('dt', null, r.label), h('dd', { class: 'rw-num' }, r.value)));
}

/** Read and check a chosen file; size, read and JSON problems become a failed preview. */
async function checkFile(f: File): Promise<{ preview: ImportPreview; file: ExportFile | null }> {
  if (f.size > MAX_BACKUP_BYTES) {
    return { file: null, preview: failedPreview(`This file is ${Math.round(f.size / 1_048_576)} MB; Riffway backups are much smaller. Is it the right file?`) };
  }
  let text: string;
  try {
    text = await f.text();
  } catch (err) {
    return { file: null, preview: failedPreview(`The file couldn’t be read: ${err instanceof Error ? err.message : String(err)}`) };
  }
  if (!text.trim()) return { file: null, preview: failedPreview('The file is empty.') };
  return parseBackup(text);
}

function failedPreview(message: string): ImportPreview {
  return {
    ok: false,
    errors: [message],
    schemaVersion: 0,
    exportedAt: null,
    counts: { runs: 0, bests: 0, sectionProgress: 0, practiceDays: 0, streak: 0, audioLinks: 0, songCache: 0, sidecars: 0 },
  };
}
