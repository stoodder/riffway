/**
 * Starter library source adapter (T-017); content and licensing in `starter/README.md` (T-019).
 * Reads `starter/manifest.json` and offers each item's `<slug>.atex` with the fixed id
 * `starter:<slug>` (DEC-14) and the manifest's style/genre tags. Read-only; not watched.
 * @module
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { IndexCandidate, SourceAdapter, StarterItem } from '@shared/sources';
import { isRecord } from '../../json-file';
import { REPO_ROOT } from '../../paths';
import { idleStatus } from '../stub';

/** Options (tests point `dir` at a temp folder). */
export interface StarterAdapterOptions {
  /** Folder holding `manifest.json` and the `.atex` files. Default `<repoRoot>/starter`. */
  dir?: string;
}

/** Slugs become file names and ids, so they are restricted to a safe alphabet. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

function isStarterItem(value: unknown): value is StarterItem {
  return isRecord(value) && typeof value.slug === 'string' && SLUG_RE.test(value.slug) && typeof value.title === 'string';
}

/** Read the manifest's valid items; [] when the manifest is missing or malformed. */
export async function readStarterManifest(dir: string): Promise<StarterItem[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!isRecord(raw) || !Array.isArray(raw.items)) return [];
  return raw.items.filter(isStarterItem);
}

/** Create the starter adapter. */
export function createStarterAdapter(opts: StarterAdapterOptions = {}): SourceAdapter {
  const dir = opts.dir ?? join(REPO_ROOT, 'starter');
  const adapter: SourceAdapter = {
    id: 'starter',
    displayName: 'Starter library',
    kind: 'library',
    termsDoc: 'starter/README.md',
    async scan() {
      const out: IndexCandidate[] = [];
      for (const item of await readStarterManifest(dir)) {
        const relPath = `${item.slug}.atex`;
        const absPath = join(dir, relPath);
        try {
          const st = await stat(absPath);
          if (!st.isFile()) continue;
          const tags = isRecord(item.tags) ? { style: item.tags.style ?? [], genre: item.tags.genre ?? [] } : undefined;
          out.push({ absPath, relPath, mtimeMs: st.mtimeMs, size: st.size, id: `starter:${item.slug}`, ...(tags ? { tags } : {}) });
        } catch {
          // Listed but missing: skip.
        }
      }
      return out;
    },
    status: async () => idleStatus(adapter),
  };
  return adapter;
}
