/**
 * Writes the WAV files Chrome plays as its fake microphone (`--use-file-for-fake-audio-capture`).
 * Tones loop seamlessly: a whole number of periods fits the file, amplitude is constant.
 */
import { writeFileSync } from 'node:fs';

/** Constant harmonic tone (guitar-like partials) at `freq`, `sec` long, peak `amp`, 16-bit mono WAV. */
export function writeToneWav(path: string, freq: number, sec: number, sampleRate = 48000, amp = 0.25): void {
  const n = Math.round(sec * sampleRate);
  const partials = [0.6, 1, 0.5, 0.35, 0.2];
  const pcm = new Float64Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < partials.length; k++) v += partials[k] * Math.sin((2 * Math.PI * freq * (k + 1) * i) / sampleRate + k * 0.7);
    pcm[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round((pcm[i] / peak) * amp * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}
