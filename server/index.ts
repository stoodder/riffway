/**
 * Companion-server bootstrap (T-010): `npm run dev` runs it with `tsx watch`, `npm start` runs the
 * esbuild bundle `dist-server/index.js`. Listens on 127.0.0.1 only (DEC-20) on `RIFFWAY_PORT`
 * (default 5174) and serves `dist/` when built. Env: `RIFFWAY_DATA_DIR`, `RIFFWAY_PORT`,
 * `RIFFWAY_LIBRARY_DIR` (override the configured library folder).
 */
import { SERVER_PORT } from '@shared/api';
import { createApp } from './app';

const port = Number(process.env.RIFFWAY_PORT || SERVER_PORT);
const { app } = await createApp({
  logger: { level: process.env.RIFFWAY_LOG_LEVEL || 'info' },
  ...(process.env.RIFFWAY_LIBRARY_DIR ? { libraryDir: process.env.RIFFWAY_LIBRARY_DIR } : {}),
});

const shutdown = async (): Promise<void> => {
  await app.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await app.listen({ host: '127.0.0.1', port });
