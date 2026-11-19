/**
 * Minimal RIFF/WAVE codec for the audio-pipeline fixtures (T-036): reads PCM 16/24/32-bit integer
 * and 32-bit float files (any channel count, `WAVE_FORMAT_EXTENSIBLE` included) and writes mono
 * 16-bit PCM. DOM-free and Node-free (works on a `Uint8Array`), so the Node tests, the browser
 * tests and `scripts/fetch-audio-fixtures.ts` share it.
 */

/** Decoded audio: one `Float32Array` per channel in −1…1. */
export interface PcmAudio {
  sampleRate: number;
  channels: Float32Array[];
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

function fourCC(view: DataView, at: number): string {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
}

/**
 * Decode a WAV file.
 * @throws Error when the bytes are not RIFF/WAVE or use an unsupported sample format.
 */
export function readWav(bytes: Uint8Array): PcmAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || fourCC(view, 0) !== 'RIFF' || fourCC(view, 8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let format = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: { at: number; size: number } | null = null;
  for (let at = 12; at + 8 <= bytes.byteLength; ) {
    const id = fourCC(view, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
      if (format === FORMAT_EXTENSIBLE && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      data = { at: body, size: Math.min(size, bytes.byteLength - body) };
    }
    at = body + size + (size & 1);
  }
  if (!data || channelCount === 0) throw new Error('WAV without fmt or data chunk');
  const isFloat = format === FORMAT_FLOAT && bits === 32;
  if (!isFloat && !(format === FORMAT_PCM && (bits === 16 || bits === 24 || bits === 32))) {
    throw new Error(`unsupported WAV sample format ${format}/${bits}-bit`);
  }
  const bytesPerSample = bits / 8;
  const frames = Math.floor(data.size / (bytesPerSample * channelCount));
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const at = data.at + (i * channelCount + c) * bytesPerSample;
      let v: number;
      if (isFloat) v = view.getFloat32(at, true);
      else if (bits === 16) v = view.getInt16(at, true) / 0x8000;
      else if (bits === 24) v = ((view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) / 0x800000);
      else v = view.getInt32(at, true) / 0x80000000;
      channels[c][i] = v;
    }
  }
  return { sampleRate, channels };
}

/**
 * Encode mono 16-bit PCM (samples clipped to −1…1, rounded to nearest; TPDF dither is deliberately
 * not used so the output is reproducible byte for byte).
 */
export function writeWavMono16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataSize = samples.length * 2;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string): void => {
    for (let i = 0; i < 4; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, FORMAT_PCM, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(v * 0x7fff), true);
  }
  return out;
}
