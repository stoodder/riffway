import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/api';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { BackingError, guideShouldMute, newLink, validateAudioFile } from '../../src/audio/backing';

describe('validateAudioFile', () => {
  it('accepts MP3/WAV/M4A in any case and rejects other types, empty and oversized files', () => {
    for (const name of ['a.mp3', 'b.WAV', 'c.m4a', 'My.Band - Live.Mp3']) expect(() => validateAudioFile({ name, size: 10 })).not.toThrow();
    const err = (f: { name: string; size: number }): string | undefined => {
      try {
        validateAudioFile(f);
        return undefined;
      } catch (e) {
        expect(e).toBeInstanceOf(BackingError);
        return (e as BackingError).code;
      }
    };
    expect(err({ name: 'a.ogg', size: 10 })).toBe('unsupported-type');
    expect(err({ name: 'mp3', size: 10 })).toBe('unsupported-type');
    expect(err({ name: 'a.wav', size: 0 })).toBe('empty');
    expect(err({ name: 'a.wav', size: LIMITS.audioBytes + 1 })).toBe('too-large');
  });
});

describe('guideShouldMute (guide is the fallback without backing)', () => {
  const s = (guide: boolean, muteGuideWithBacking: boolean) => ({ game: { ...DEFAULT_SETTINGS.game, guide, muteGuideWithBacking } });
  it('plays the guide when no backing is attached or it is off', () => {
    expect(guideShouldMute(s(true, true), null)).toBe(false);
    expect(guideShouldMute(s(true, true), { enabled: false })).toBe(false);
  });
  it('mutes the guide under enabled backing only when the setting says so', () => {
    expect(guideShouldMute(s(true, true), { enabled: true })).toBe(true);
    expect(guideShouldMute(s(true, false), { enabled: true })).toBe(false);
  });
  it('a guide switched off stays muted', () => {
    expect(guideShouldMute(s(false, false), null)).toBe(true);
  });
});

it('newLink starts at song 0 = audio 0, 0 dB, enabled', () => {
  expect(newLink('s:1', 2, 'ab', 'x.mp3')).toEqual({
    songId: 's:1',
    arrangement: 2,
    audioId: 'ab',
    fileName: 'x.mp3',
    anchors: [{ songTime: 0, audioTime: 0 }],
    gainDb: 0,
    enabled: true,
  });
});
