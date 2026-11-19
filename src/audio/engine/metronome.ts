/**
 * Metronome / count-in click voice. Each click is a short pre-rendered buffer (a decaying cosine that
 * starts at full amplitude) played by an `AudioBufferSourceNode` started at the exact context time,
 * so its onset lands on `ceil(when × sampleRate)`: sample-accurate and cheap. Downbeats use the
 * higher, louder accent buffer. Which beats click (grid, count-in, pre-roll) is decided by the
 * transport; this module only plays them.
 * @module
 */
import type { ClickHandle, ClickSink } from './transport';

/** Click voice parameters. */
export const CLICK_VOICE = {
  /** Total length (s). */
  durationSec: 0.03,
  /** Amplitude decay time constant (s). */
  decaySec: 0.005,
  /** Linear fade-out at the tail (s), so the buffer ends at exactly 0. */
  fadeSec: 0.002,
  accent: { freqHz: 2000, gain: 1 },
  beat: { freqHz: 1300, gain: 0.6 },
} as const;

/** Render one click into a mono buffer. */
function renderClick(ctx: BaseAudioContext, freqHz: number, gain: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.round(CLICK_VOICE.durationSec * sr);
  const fadeN = Math.round(CLICK_VOICE.fadeSec * sr);
  const buf = ctx.createBuffer(1, n, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const fade = i >= n - fadeN ? (n - 1 - i) / fadeN : 1;
    data[i] = gain * Math.cos(2 * Math.PI * freqHz * t) * Math.exp(-t / CLICK_VOICE.decaySec) * fade;
  }
  return buf;
}

/** A {@link ClickSink} on one context, plus cleanup. */
export interface ClickPlayer extends ClickSink {
  /** Stop and disconnect every click that has not finished. */
  dispose(): void;
}

/** Create the click voice on `ctx`, playing into `destination` (the metronome bus). */
export function createClickPlayer(ctx: BaseAudioContext, destination: AudioNode): ClickPlayer {
  const accent = renderClick(ctx, CLICK_VOICE.accent.freqHz, CLICK_VOICE.accent.gain);
  const beat = renderClick(ctx, CLICK_VOICE.beat.freqHz, CLICK_VOICE.beat.gain);
  const live = new Set<AudioBufferSourceNode>();

  const kill = (node: AudioBufferSourceNode): void => {
    node.onended = null;
    try {
      node.stop();
    } catch {
      // Already stopped.
    }
    node.disconnect();
    live.delete(node);
  };

  return {
    schedule(when: number, isAccent: boolean): ClickHandle {
      const node = new AudioBufferSourceNode(ctx, { buffer: isAccent ? accent : beat });
      node.connect(destination);
      node.onended = () => {
        node.disconnect();
        live.delete(node);
      };
      node.start(Math.max(0, when));
      live.add(node);
      return { cancel: () => kill(node) };
    },
    dispose() {
      for (const node of [...live]) kill(node);
    },
  };
}
