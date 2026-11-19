import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { DB_VERSION } from '@shared/storage';
import { openRiffwayDb, runUpgrades, SCHEMA_STEPS, stepsBetween, type SchemaStep } from '../../src/storage/schema';
import { checkBackup } from '../../src/storage/export';
import { openStorage } from '../../src/storage';
import { freshStorage, makeRun } from './fixtures';

/** A hypothetical v2: adds a `loops` store and stamps every run with `migrated: 2` (DB and export). */
const V2: SchemaStep = {
  version: 2,
  upgradeDb(db, tx) {
    db.createObjectStore('loops', { keyPath: 'id' });
    const runs = tx.objectStore('runs');
    void runs.openCursor().then(async function walk(cursor): Promise<void> {
      if (!cursor) return;
      await cursor.update({ ...(cursor.value as object), migrated: 2 });
      return walk(await cursor.continue());
    });
  },
  migrateExport(file) {
    const stores = file.stores as { runs: object[] };
    return { ...file, stores: { ...stores, runs: stores.runs.map((r) => ({ ...r, migrated: 2 })) } };
  },
};
const V3: SchemaStep = {
  version: 3,
  upgradeDb(db) {
    db.createObjectStore('notes');
  },
  migrateExport: (file) => ({ ...file, v3: true }),
};

describe('schema steps', () => {
  it('v1 is the current version and the step list is complete', () => {
    expect(SCHEMA_STEPS.map((s) => s.version)).toEqual(Array.from({ length: DB_VERSION }, (_, i) => i + 1));
  });

  it('selects the steps between two versions in order', () => {
    expect(stepsBetween(0, 3, [V3, V2, ...SCHEMA_STEPS]).map((s) => s.version)).toEqual([1, 2, 3]);
    expect(stepsBetween(1, 3, [V3, ...SCHEMA_STEPS, V2]).map((s) => s.version)).toEqual([2, 3]);
    expect(stepsBetween(2, 2, [V2])).toEqual([]);
  });

  it('refuses an incomplete migration path', () => {
    expect(() => runUpgrades(null as never, 0, 3, null as never, [...SCHEMA_STEPS, V3])).toThrow(/No complete migration path from schema 0 to 3/);
  });
});

describe('database upgrade', () => {
  it('falls through v1 → v2 → v3 on an existing database and keeps its data', async () => {
    const name = `riffway-upgrade-${Math.random()}`;
    const storage = await openStorage({ dbName: name });
    await storage.addRun(makeRun());
    storage.close();

    const db = await openRiffwayDb(name, { version: 3, steps: [...SCHEMA_STEPS, V2, V3] });
    expect(db.version).toBe(3);
    expect([...db.objectStoreNames]).toEqual(expect.arrayContaining(['runs', 'loops', 'notes']));
    const runs = (await db.getAll('runs')) as unknown as { migrated?: number }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.migrated).toBe(2);
    db.close();
  });

  it('creates a fresh database through every step', async () => {
    const db = await openRiffwayDb(`riffway-fresh-${Math.random()}`, { version: 3, steps: [...SCHEMA_STEPS, V2, V3] });
    expect([...db.objectStoreNames]).toEqual(expect.arrayContaining(['settings', 'runs', 'loops', 'notes']));
    db.close();
  });
});

describe('export migration', () => {
  it('migrates an older file forward with the same steps', async () => {
    const storage = await freshStorage();
    await storage.addRun(makeRun({ mode: 'practice' }));
    const v1 = await storage.exportAll();
    storage.close();

    const { preview, file } = checkBackup(v1, [...SCHEMA_STEPS, V2, V3], 3);
    expect(preview).toMatchObject({ ok: true, errors: [], schemaVersion: 1 });
    expect(file?.schemaVersion).toBe(3);
    expect((file?.stores.runs[0] as unknown as { migrated: number }).migrated).toBe(2);
    expect((file as unknown as { v3: boolean }).v3).toBe(true);
    expect(v1.stores.runs[0]).not.toHaveProperty('migrated');
  });

  it('reports a failing migration step instead of throwing', async () => {
    const storage = await freshStorage();
    const v1 = await storage.exportAll();
    storage.close();
    const broken: SchemaStep = { ...V2, migrateExport: () => { throw new Error('boom'); } };
    const { preview, file } = checkBackup(v1, [...SCHEMA_STEPS, broken], 2);
    expect(file).toBeNull();
    expect(preview.errors).toEqual(['Migrating the backup to schema 2 failed: boom']);
  });

  it('reports a missing step', async () => {
    const storage = await freshStorage();
    const v1 = await storage.exportAll();
    storage.close();
    expect(checkBackup(v1, [...SCHEMA_STEPS, V3], 3).preview.errors).toEqual(['No migration path from schema 1 to 3.']);
  });
});
