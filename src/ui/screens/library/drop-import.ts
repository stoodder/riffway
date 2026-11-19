/**
 * Drag-and-drop (whole window) and file-picker import. Files are checked locally (extension and size,
 * same rules as the server), posted to `POST /api/library/import`, which copies them into the library
 * folder; progress shows inline and the outcome as toasts. The new songs then arrive through the
 * watcher → `library.changed` SSE → live search refresh (docs/sources/local-folder.md).
 * @module
 */
import { LIMITS, type ApiClient, type ImportResponse } from '@shared/api';
import { SONG_EXTENSIONS } from '@shared/song';
import type { ToastKind, UiApi } from '@shared/ui';
import { h, icon, meter } from '../../components';

/** Extensions the import accepts: song files plus a paired `.mid` (mirrors the server allowlist). */
export const IMPORT_ACCEPT: readonly string[] = [...SONG_EXTENSIONS, '.mid'];

/** A file refused before upload. */
export interface LocalRejection {
  name: string;
  reason: string;
}

const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
};

/** Split files into those worth uploading and those the server would reject anyway. */
export function partitionFiles(files: readonly File[]): { accepted: File[]; rejected: LocalRejection[] } {
  const accepted: File[] = [];
  const rejected: LocalRejection[] = [];
  for (const f of files) {
    const ext = extOf(f.name);
    if (!IMPORT_ACCEPT.includes(ext)) rejected.push({ name: f.name, reason: ext ? `${ext} files aren't song files` : 'Not a song file' });
    else if (f.size > LIMITS.importBytes) rejected.push({ name: f.name, reason: `Larger than ${LIMITS.importBytes / 1024 / 1024} MB` });
    else if (f.size === 0) rejected.push({ name: f.name, reason: 'The file is empty' });
    else accepted.push(f);
  }
  return { accepted, rejected };
}

/** One toast to show after an import. */
export interface ImportToast {
  kind: ToastKind;
  message: string;
}

/** List at most three names, then "and N more". */
function names(list: readonly string[]): string {
  const shown = list.slice(0, 3).join(', ');
  return list.length > 3 ? `${shown} and ${list.length - 3} more` : shown;
}

/** Turn the server's per-file results (plus local rejections) into user-facing toasts. */
export function summarizeImport(response: ImportResponse | null, local: readonly LocalRejection[]): ImportToast[] {
  const files = response?.files ?? [];
  const imported = files.filter((f) => f.status === 'imported');
  const duplicates = files.filter((f) => f.status === 'duplicate');
  const rejected = [...files.filter((f) => f.status === 'rejected').map((f) => ({ name: f.name, reason: f.reason ?? 'Rejected' })), ...local];
  const toasts: ImportToast[] = [];
  if (imported.length) {
    const n = imported.length;
    toasts.push({ kind: 'success', message: `Added ${n} ${n === 1 ? 'file' : 'files'} to your library. ${n === 1 ? 'It appears' : 'They appear'} below once indexed.` });
  }
  if (duplicates.length) toasts.push({ kind: 'info', message: `Already in your library: ${names(duplicates.map((f) => f.name))}.` });
  if (rejected.length === 1) {
    const [only] = rejected;
    toasts.push({ kind: 'error', message: `Couldn't add ${only?.name}: ${only?.reason}.` });
  } else if (rejected.length > 1) {
    toasts.push({
      kind: 'error',
      message: `Couldn't add ${rejected.length} files: ${names(rejected.map((r) => `${r.name} (${r.reason})`))}. Riffway reads Guitar Pro, MusicXML, alphaTex and ASCII tab files.`,
    });
  }
  return toasts;
}

/** True when a drag carries files (not text or links). */
function hasFiles(ev: DragEvent): boolean {
  return Array.from(ev.dataTransfer?.types ?? []).includes('Files');
}

/** Options for {@link dropImport}. */
export interface DropImportOptions {
  api: ApiClient;
  ui: UiApi;
  win: Window;
  /** Destination folder shown on the drop overlay. */
  destination: () => string;
  /** Library-relative paths the server wrote (marks rows as new). */
  onImported: (paths: string[]) => void;
}

/** A mounted drop zone + picker. */
export interface DropImport {
  /** Full-window overlay shown while dragging files. */
  overlay: HTMLElement;
  /** Inline progress status. */
  progress: HTMLElement;
  /** Open the native file picker. */
  pick(): void;
  /** Import files (drop, picker, tests). Imports run one after another. */
  importFiles(files: readonly File[]): Promise<void>;
  destroy(): void;
}

/** Install the whole-window drop zone and the hidden file picker. */
export function dropImport(opts: DropImportOptions): DropImport {
  const { win } = opts;
  const where = h('p', { class: 'lib-drop__where' });
  const overlay = h(
    'div',
    { class: 'lib-drop', hidden: true, 'aria-hidden': 'true' },
    h(
      'div',
      { class: 'lib-drop__panel' },
      icon('import', { size: '40px' }),
      h('p', { class: 'lib-drop__title' }, 'Drop to add to your library'),
      h('p', { class: 'lib-drop__formats' }, 'Guitar Pro (.gp, .gpx, .gp3–5), MusicXML, alphaTex or ASCII tab (.txt, .tab)'),
      where,
    ),
  );
  const bar = meter({ label: 'Upload progress', hideLabel: true });
  const progressText = h('span', { class: 'lib-import__text' });
  const progress = h('div', { class: 'lib-import', role: 'status', hidden: true }, progressText, bar.el);
  const input = h('input', { type: 'file', multiple: true, accept: IMPORT_ACCEPT.join(','), class: 'rw-visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  progress.append(input);

  let depth = 0;
  let queue: Promise<void> = Promise.resolve();
  let destroyed = false;

  const show = (on: boolean): void => {
    overlay.hidden = !on;
    if (on) where.textContent = `Copied into ${opts.destination()}`;
  };

  async function run(files: readonly File[]): Promise<void> {
    const { accepted, rejected } = partitionFiles(files);
    let response: ImportResponse | null = null;
    if (accepted.length) {
      progress.hidden = false;
      progressText.textContent = `Adding ${accepted.length} ${accepted.length === 1 ? 'file' : 'files'}…`;
      bar.set(0);
      try {
        response = await opts.api.importFiles(accepted, (f) => bar.set(f));
      } catch (err) {
        opts.ui.toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
      } finally {
        if (!destroyed) progress.hidden = true;
      }
    }
    if (destroyed) return;
    for (const t of summarizeImport(response, rejected)) opts.ui.toast(t.message, { kind: t.kind });
    const paths = (response?.files ?? []).filter((f) => f.status === 'imported' && f.path).map((f) => f.path as string);
    if (paths.length) opts.onImported(paths);
  }

  const importFiles = (files: readonly File[]): Promise<void> => {
    if (!files.length) return queue;
    queue = queue.then(() => run(files));
    return queue;
  };

  const onDragEnter = (ev: DragEvent): void => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    depth++;
    show(true);
  };
  const onDragOver = (ev: DragEvent): void => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (ev: DragEvent): void => {
    if (!hasFiles(ev)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(false);
  };
  const onDrop = (ev: DragEvent): void => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    depth = 0;
    show(false);
    void importFiles(Array.from(ev.dataTransfer?.files ?? []));
  };
  const onPicked = (): void => {
    void importFiles(Array.from(input.files ?? []));
    input.value = '';
  };

  win.addEventListener('dragenter', onDragEnter);
  win.addEventListener('dragover', onDragOver);
  win.addEventListener('dragleave', onDragLeave);
  win.addEventListener('drop', onDrop);
  input.addEventListener('change', onPicked);

  return {
    overlay,
    progress,
    pick: () => input.click(),
    importFiles,
    destroy() {
      destroyed = true;
      win.removeEventListener('dragenter', onDragEnter);
      win.removeEventListener('dragover', onDragOver);
      win.removeEventListener('dragleave', onDragLeave);
      win.removeEventListener('drop', onDrop);
      input.removeEventListener('change', onPicked);
    },
  };
}
