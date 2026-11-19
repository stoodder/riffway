/**
 * Library folder line + chooser. A browser can't show a folder picker for the companion server's
 * disk, so the folder is a validated path text field saved with `PUT /api/config` (the server
 * expands `~`, rescans and restarts its watcher). Also offers "Rescan".
 * @module
 */
import type { ApiClient, ServerConfig } from '@shared/api';
import type { UiApi } from '@shared/ui';
import { button, h, setBusy, uid } from '../../components';

/**
 * Validate a library folder path typed by the user. Returns an error message, or null when the path
 * can be sent (the server normalises and has the final word). Accepts POSIX absolute paths, `~` and
 * `~/…`, and Windows drive or UNC paths.
 */
export function validateLibraryPath(raw: string): string | null {
  const path = raw.trim();
  if (!path) return 'Enter the folder path.';
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f]/.test(path)) return 'The path contains invalid characters.';
  const absolute = path === '~' || path.startsWith('~/') || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
  if (!absolute) return 'Use a full path, starting with / or ~ (for example ~/Music/Tabs).';
  return null;
}

/** Library-folder display path with the import subfolder, e.g. `~/Music/Tabs/Imported`. */
export function importDestination(config: Pick<ServerConfig, 'libraryDir' | 'importSubfolder'>): string {
  const sub = config.importSubfolder.replace(/^[/\\]+|[/\\]+$/g, '');
  return sub ? `${config.libraryDir.replace(/[/\\]+$/, '')}/${sub}` : config.libraryDir;
}

/** Options for {@link libraryFolder}. */
export interface LibraryFolderOptions {
  api: ApiClient;
  ui: UiApi;
  /** The config was saved (new folder). */
  onSaved: (config: ServerConfig) => void;
}

/** A mounted library-folder control. */
export interface LibraryFolder {
  el: HTMLElement;
  set(config: ServerConfig): void;
  /** Open the editor (empty-state action). */
  edit(): void;
}

/** Create the library-folder line and its inline editor. */
export function libraryFolder(opts: LibraryFolderOptions): LibraryFolder {
  let config: ServerConfig | null = null;
  const path = h('code', { class: 'lib-folder__path' }, '…');
  const inputId = uid('lib-folder');
  const hintId = uid('lib-folder-hint');
  const errorId = uid('lib-folder-error');
  const input = h('input', {
    id: inputId,
    class: 'lib-folder__input',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-describedby': `${hintId} ${errorId}`,
  });
  const error = h('p', { class: 'lib-folder__error', id: errorId, role: 'alert' });
  const save = button({ label: 'Save folder', variant: 'primary', size: 'sm', type: 'submit' });
  const cancel = button({ label: 'Cancel', variant: 'ghost', size: 'sm', onClick: () => close(true) });
  const form = h(
    'form',
    { class: 'lib-folder__form', hidden: true, novalidate: true },
    h('label', { class: 'rw-field__label', for: inputId }, 'Library folder on this computer'),
    h('div', { class: 'lib-folder__controls' }, input, save, cancel),
    h(
      'p',
      { class: 'rw-field__hint', id: hintId },
      "Type or paste the folder's full path (for example ~/Music/Tabs). Riffway watches it and copies dropped files into it; the folder is created if needed.",
    ),
    error,
  );
  const change = button({ label: 'Change folder', variant: 'ghost', size: 'sm', onClick: () => open() });
  const rescan = button({
    label: 'Rescan',
    variant: 'ghost',
    size: 'sm',
    icon: 'loop',
    title: 'Re-read every file in the library folder',
    onClick: async () => {
      setBusy(rescan, true);
      try {
        await opts.api.rescan();
        opts.ui.toast('Rescanning your library…', { kind: 'info' });
      } catch (err) {
        opts.ui.toast(`Rescan failed: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
      } finally {
        setBusy(rescan, false);
      }
    },
  });
  const line = h('p', { class: 'lib-folder__line' }, h('span', { class: 'rw-muted' }, 'Library folder'), path, change, rescan);
  const el = h('div', { class: 'lib-folder' }, line, form);

  const apply = (next: ServerConfig): void => {
    config = next;
    path.textContent = next.libraryDir;
    path.title = `${next.libraryDir}\nDrops are copied to ${importDestination(next)}`;
  };

  const showError = (message: string | null): void => {
    error.textContent = message ?? '';
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  };

  function open(): void {
    form.hidden = false;
    change.hidden = true;
    input.value = config?.libraryDir ?? '';
    showError(null);
    input.focus();
    input.select();
  }

  function close(restoreFocus: boolean): void {
    form.hidden = true;
    change.hidden = false;
    showError(null);
    if (restoreFocus) change.focus();
  }

  input.addEventListener('input', () => {
    if (input.getAttribute('aria-invalid')) showError(validateLibraryPath(input.value));
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close(true);
    }
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const problem = validateLibraryPath(input.value);
    if (problem) {
      showError(problem);
      input.focus();
      return;
    }
    if (config && input.value.trim() === config.libraryDir) {
      close(true);
      return;
    }
    setBusy(save, true);
    try {
      const next = await opts.api.putConfig({ libraryDir: input.value.trim() });
      apply(next);
      close(true);
      opts.ui.toast(`Library folder set to ${next.libraryDir}. Scanning it now…`, { kind: 'success' });
      opts.onSaved(next);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
      input.focus();
    } finally {
      setBusy(save, false);
    }
  });

  return {
    el,
    set: apply,
    edit: open,
  };
}
