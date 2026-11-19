/**
 * Path resolution (T-010; T-017 may extend). **Must stay at depth 1 under the repo root**
 * (`server/paths.ts` ↔ bundled `dist-server/index.js`) so `new URL('..', import.meta.url)` is the
 * repo root in both dev (tsx) and production (esbuild bundle).
 * @module
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import type { ServerPaths } from './types';

/** App version from package.json. */
export const APP_VERSION: string = pkg.version;

/** Repository root. */
export const REPO_ROOT: string = fileURLToPath(new URL('..', import.meta.url));

/** `RIFFWAY_DATA_DIR` or `~/.riffway` (DEC-20). */
export function defaultDataDir(): string {
  return process.env.RIFFWAY_DATA_DIR || join(homedir(), '.riffway');
}

/** Default library folder `~/Music/Tabs`. */
export function defaultLibraryDir(): string {
  return join(homedir(), 'Music', 'Tabs');
}

/** `<repoRoot>/dist` when it holds a build, else null. */
export function defaultStaticDir(): string | null {
  const dir = join(REPO_ROOT, 'dist');
  return existsSync(join(dir, 'index.html')) ? dir : null;
}

/** All server paths for a data dir. */
export function resolvePaths(dataDir: string, staticDir: string | null): ServerPaths {
  return {
    repoRoot: REPO_ROOT,
    dataDir,
    configFile: join(dataDir, 'config.json'),
    indexFile: join(dataDir, 'index.json'),
    classtabDir: join(dataDir, 'classtab'),
    sidecarsDir: join(dataDir, 'sidecars'),
    audioDir: join(dataDir, 'audio'),
    starterDir: join(REPO_ROOT, 'starter'),
    staticDir,
  };
}
