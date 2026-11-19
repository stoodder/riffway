/**
 * `createBacking` against a real engine (AudioContext) with an in-memory API and storage:
 * attach → load (decode) → update → enable → detach, missing audio, and a context rebuild.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiClient, AudioUploadResponse } from '@shared/api';
import type { AudioEngine, BackingService } from '@shared/services';
import type { AudioLink, ExportFile, StorageService } from '@shared/storage';
import { BackingError, createBacking } from '../../src/audio/backing';
import { WarpError } from '../../src/audio/backing/warp';
import { createEngine } from '../../src/audio/engine';
import { clickTrack, encodeWav } from './helpers';

class ApiNotFound extends Error {
  readonly status = 404;
}

function fakeApi() {
  const files = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  let seq = 0;
  const api = {
    async uploadAudio(file: Blob, fileName: string): Promise<AudioUploadResponse> {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const audioId = (++seq).toString(16).padStart(40, '0');
      files.set(audioId, bytes);
      return { audioId, fileName, ext: '.wav', bytes: bytes.length };
    },
    async getAudio(audioId: string): Promise<ArrayBuffer> {
      const b = files.get(audioId);
      if (!b) throw new ApiNotFound('missing');
      return b.slice().buffer;
    },
    async deleteAudio(audioId: string): Promise<void> {
      deleted.push(audioId);
      if (!files.delete(audioId)) throw new ApiNotFound('missing');
    },
  };
  return { api: api as unknown as ApiClient, files, deleted };
}

function fakeStorage() {
  const links = new Map<string, AudioLink>();
  const key = (songId: string, arr: number): string => `${songId}#${arr}`;
  const storage = {
    async getAudioLink(songId: string, arr: number) {
      const l = links.get(key(songId, arr));
      return l ? structuredClone(l) : null;
    },
    async putAudioLink(link: AudioLink) {
      links.set(key(link.songId, link.arrangement), structuredClone(link));
    },
    async deleteAudioLink(songId: string, arr: number) {
      links.delete(key(songId, arr));
    },
    async exportAll() {
      return { stores: { audioLinks: [...links.values()] } } as unknown as ExportFile;
    },
  };
  return { storage: storage as unknown as StorageService, links };
}

const wavFile = (name: string, seconds = 1, sampleRate = 44100): File =>
  new File([encodeWav(clickTrack([0.2, 0.7], seconds, sampleRate, 2)).slice().buffer as ArrayBuffer], name, { type: 'audio/wav' });

describe('createBacking (real AudioContext, in-memory API + storage)', () => {
  let engine: AudioEngine | null = null;
  afterEach(async () => {
    await engine?.dispose();
    engine = null;
  });

  async function setup(): Promise<{ backing: BackingService; api: ReturnType<typeof fakeApi>; store: ReturnType<typeof fakeStorage> }> {
    engine = await createEngine({ sampleRate: 48000 });
    const api = fakeApi();
    const store = fakeStorage();
    return { backing: await createBacking(engine, api.api, store.storage), api, store };
  }

  it('attaches, loads (resampled to the context), updates, toggles and detaches', async () => {
    const { backing, api, store } = await setup();
    await expect(backing.attach(new File(['x'], 'song.ogg'), 's:1', 0)).rejects.toMatchObject({ code: 'unsupported-type' });
    await expect(backing.attach(new File([], 'song.mp3'), 's:1', 0)).rejects.toBeInstanceOf(BackingError);

    const link = await backing.attach(wavFile('Take 1.wav', 2), 's:1', 0);
    expect(link).toMatchObject({ songId: 's:1', arrangement: 0, fileName: 'Take 1.wav', gainDb: 0, enabled: true });
    expect(link.anchors).toEqual([{ songTime: 0, audioTime: 0 }]);
    expect(store.links.size).toBe(1);

    await backing.load(link);
    expect(backing.link?.audioId).toBe(link.audioId);
    expect(backing.buffer?.sampleRate).toBe(48000);
    expect(backing.buffer?.duration).toBeCloseTo(2, 2);

    await backing.update({ ...link, anchors: [{ songTime: 4, audioTime: 4.5 }, { songTime: 0, audioTime: 0.4 }], gainDb: -6 });
    expect(backing.link?.anchors).toEqual([{ songTime: 0, audioTime: 0.4 }, { songTime: 4, audioTime: 4.5 }]);
    expect((await store.storage.getAudioLink('s:1', 0))?.gainDb).toBe(-6);
    await expect(backing.update({ ...link, anchors: [{ songTime: 0, audioTime: 0 }, { songTime: 1, audioTime: 5 }] })).rejects.toBeInstanceOf(WarpError);

    backing.setEnabled(false);
    expect(backing.link?.enabled).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect((await store.storage.getAudioLink('s:1', 0))?.enabled).toBe(false);

    // Replacing the recording releases the old file; a file still linked elsewhere is kept.
    await store.storage.putAudioLink({ ...link, songId: 's:2' });
    const second = await backing.attach(wavFile('Take 2.wav'), 's:1', 0);
    expect(api.deleted).toEqual([]);
    await backing.load(second);
    await backing.detach('s:1', 0);
    expect(backing.link).toBeNull();
    expect(backing.buffer).toBeNull();
    expect(api.deleted).toEqual([second.audioId]);
    expect(await store.storage.getAudioLink('s:1', 0)).toBeNull();
    await backing.detach('s:2', 0);
    expect(api.deleted).toEqual([second.audioId, link.audioId]);
  });

  it('reports a missing server file as a BackingError and keeps the link for re-attaching', async () => {
    const { backing, api } = await setup();
    const link = await backing.attach(wavFile('gone.wav'), 's:1', 0);
    api.files.clear();
    await expect(backing.load(link)).rejects.toMatchObject({ code: 'missing' });
    expect(backing.link?.audioId).toBe(link.audioId);
    expect(backing.buffer).toBeNull();
  });

  it('rebuilds on a context change (sample-rate switch) and re-decodes at the new rate', async () => {
    const { backing } = await setup();
    const link = await backing.attach(wavFile('a.wav'), 's:1', 0);
    await backing.load(link);
    await engine!.setSampleRate(44100);
    for (let i = 0; i < 100 && backing.buffer?.sampleRate !== 44100; i++) await new Promise((r) => setTimeout(r, 20));
    expect(backing.buffer?.sampleRate).toBe(44100);
  });
});
