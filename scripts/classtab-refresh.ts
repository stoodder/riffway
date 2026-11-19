/**
 * `npm run classtab:refresh` (T-025): conditional GET of the ClassTab zip into
 * `<dataDir>/classtab/`, safe extraction, then indexing into `<dataDir>/index.json` (D2,
 * docs/sources/classtab.md). A running server notices the new files and re-indexes them itself.
 *
 * Flags: `--force` ignores the once-per-day limit; `--data-dir <dir>` overrides
 * `RIFFWAY_DATA_DIR` / `~/.riffway`. Exit code 1 when the refresh fails.
 */
import { parseArgs } from 'node:util';
import type { ServerEvent } from '@shared/api';
import type { AdapterLogger } from '@shared/sources';
import { createServerContext } from '../server/context';
import { defaultDataDir } from '../server/paths';
import { createClassTabAdapter } from '../server/sources/classtab';

const USAGE = 'Usage: npm run classtab:refresh -- [--force] [--data-dir <dir>]';

const { values } = parseArgs({
  options: {
    force: { type: 'boolean', default: false },
    'data-dir': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const verbose = process.env.RIFFWAY_LOG_LEVEL === 'debug';
const log: AdapterLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(`warning: ${msg}`),
  error: (msg) => console.error(`error: ${msg}`),
  debug: (msg) => {
    if (verbose) console.log(msg);
  },
};

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Print one progress event (download progress rewrites its line on a terminal). */
function printProgress(event: ServerEvent): void {
  if (event.type !== 'classtab.progress') return;
  if (event.phase === 'downloading') {
    const line = `downloading ${mb(event.bytes ?? 0)}${event.totalBytes ? ` of ${mb(event.totalBytes)}` : ''}`;
    if (process.stdout.isTTY) process.stdout.write(`\r${line}`);
    return;
  }
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
  if (event.phase === 'done' || event.phase === 'error' || event.phase === 'not-modified') return;
  console.log(`${event.phase}…`);
}

const dataDir = values['data-dir'] ?? defaultDataDir();
const adapter = createClassTabAdapter();
const ctx = await createServerContext({ dataDir, staticDir: null, watch: false, sources: [() => adapter] }, log);
let exitCode = 0;
try {
  await ctx.library.ready;
  console.log(`ClassTab data: ${ctx.paths.classtabDir}`);
  const unsubscribe = ctx.events.subscribe(printProgress);
  const result = await adapter.refresh(ctx.adapterContext, { force: values.force });
  unsubscribe();
  const status = await adapter.classtabStatus(ctx.adapterContext);
  console.log(`${result.status}${result.message ? `: ${result.message}` : ''}`);
  console.log(
    `index: ${status.tabs} tabs, ${status.midis} MIDI files; rhythm from MIDI ${status.rhythm.midi}, ` +
      `beat ruler ${status.rhythm.ruler}, needs alignment ${status.rhythm.needsAlignment}`,
  );
  if (result.status === 'error') exitCode = 1;
} finally {
  await ctx.close();
}
process.exit(exitCode);
