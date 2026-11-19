/**
 * Local library source adapter (T-017); terms and approach in `docs/sources/local-folder.md`.
 * Scans the configured library folder recursively for song files (pairing `.txt`/`.tab` with a
 * sibling `.mid`) and watches it with chokidar (`awaitWriteFinish`, debounced).
 * @module
 */
import { mkdirSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { watch as chokidarWatch } from 'chokidar';
import type { IndexCandidate, SourceAdapter } from '@shared/sources';
import { ASCII_EXTENSIONS, MIDI_EXTENSION, isSongFile, lowerExt, toPosix } from '../../fs-safety';
import { idleStatus } from '../stub';

/** Timing knobs for the watcher (tests shorten them). */
export interface LocalAdapterOptions {
  /** Quiet period before a batch of changes is reported (ms). Default 300. */
  debounceMs?: number;
  /** chokidar `awaitWriteFinish.stabilityThreshold` (ms). Default 200. */
  stabilityMs?: number;
  /** chokidar `awaitWriteFinish.pollInterval` (ms). Default 50. */
  pollMs?: number;
  /** Called once the watcher has finished its initial walk and reports changes (tests wait on it). */
  onReady?: () => void;
}

/** Deepest folder level scanned below the library root. */
const MAX_DEPTH = 16;

/** Hidden files/folders (dotfiles, our `.riffway-upload-*` temp files) are never indexed. */
const isHidden = (name: string): boolean => name.startsWith('.');

/**
 * Walk `root` and list song files. Skips hidden entries and symlinks (no escaping the folder, no
 * cycles); ASCII tabs get `midiPath` when `<same basename>.mid` (any case) sits beside them.
 */
export async function scanLibraryFolder(root: string): Promise<IndexCandidate[]> {
  const out: IndexCandidate[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing or unreadable folder: nothing to index
    }
    const midiByStem = new Map<string, string>();
    for (const d of dirents) {
      if (d.isFile() && lowerExt(d.name) === MIDI_EXTENSION) midiByStem.set(basename(d.name, extname(d.name)).toLowerCase(), d.name);
    }
    for (const d of dirents) {
      if (isHidden(d.name) || d.isSymbolicLink()) continue;
      const abs = join(dir, d.name);
      if (d.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(abs, depth + 1);
        continue;
      }
      if (!d.isFile() || !isSongFile(d.name)) continue;
      let st;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      const candidate: IndexCandidate = { absPath: abs, relPath: toPosix(relative(root, abs)), mtimeMs: st.mtimeMs, size: st.size };
      if (ASCII_EXTENSIONS.includes(lowerExt(d.name))) {
        const midi = midiByStem.get(basename(d.name, extname(d.name)).toLowerCase());
        if (midi) candidate.midiPath = join(dir, midi);
      }
      out.push(candidate);
    }
  };
  await walk(root, 0);
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** Create the local-folder adapter. */
export function createLocalAdapter(opts: LocalAdapterOptions = {}): SourceAdapter {
  const debounceMs = opts.debounceMs ?? 300;
  const adapter: SourceAdapter = {
    id: 'local',
    displayName: 'Local library',
    kind: 'library',
    termsDoc: 'docs/sources/local-folder.md',
    scan: (ctx) => scanLibraryFolder(ctx.libraryDir),
    watch(ctx, onChange) {
      const root = ctx.libraryDir;
      mkdirSync(root, { recursive: true });
      const relevant = (path: string, isFile: boolean): boolean => {
        const rel = relative(root, path);
        if (!rel) return true;
        if (rel.split(/[/\\]/).some(isHidden)) return false;
        return !isFile || isSongFile(path) || lowerExt(path) === MIDI_EXTENSION;
      };
      const watcher = chokidarWatch(root, {
        ignoreInitial: true,
        followSymlinks: false,
        depth: MAX_DEPTH,
        awaitWriteFinish: { stabilityThreshold: opts.stabilityMs ?? 200, pollInterval: opts.pollMs ?? 50 },
        ignored: (path, stats) => !relevant(path, stats?.isFile() ?? false),
      });
      let pending = new Set<string>();
      let timer: NodeJS.Timeout | undefined;
      const flush = (): void => {
        timer = undefined;
        const paths = [...pending];
        pending = new Set();
        if (paths.length) onChange(paths);
      };
      watcher.on('all', (_event, path) => {
        pending.add(path);
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, debounceMs);
      });
      watcher.on('error', (err) => ctx.log.warn(`library watcher: ${String(err)}`));
      if (opts.onReady) watcher.once('ready', opts.onReady);
      // The returned promise lets the server await chokidar's close on shutdown.
      return () => {
        if (timer) clearTimeout(timer);
        return watcher.close();
      };
    },
    status: async (ctx) => idleStatus(adapter, ctx.libraryDir),
  };
  return adapter;
}
