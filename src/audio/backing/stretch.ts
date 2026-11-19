/**
 * Wrapper around the signalsmith-stretch 1.3.2 AudioWorklet node (WASM, registered from an inline
 * Blob by the library; types in `src/types/signalsmith-stretch.d.ts`). Every remote method of the
 * node returns a Promise that resolves once the worklet has handled the message.
 *
 * The node compensates its own latency: at output time `T` it plays the input position its time map
 * gives for `T`, provided the change for `T` arrived at least `latency()` before `T`
 * (see `plan.ts` for the posting rule that guarantees this).
 * @module
 */
import SignalsmithStretch from 'signalsmith-stretch';
import type { StretchEvent } from './plan';

/** What the backing player needs from a stretch node (a fake implements it in tests). */
export interface StretchNode {
  /** Connect this to the output chain. */
  readonly output: AudioNode;
  /** Latency the node compensates (s): changes must arrive at least this far ahead. */
  readonly latency: number;
  /** Post one time-map change; resolves when the worklet has applied it. */
  schedule(ev: StretchEvent): Promise<void>;
  /** Replace the input audio (null = none). Resolves when every chunk has been transferred. */
  setBuffer(buffer: AudioBuffer | null): Promise<void>;
  dispose(): void;
}

/** Create a stereo stretch node on `ctx` (loads the worklet module once per context). */
export async function createStretchNode(ctx: BaseAudioContext): Promise<StretchNode> {
  const node = await SignalsmithStretch(ctx, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  const latency = await node.latency();
  let generation = 0;
  return {
    output: node,
    latency,
    async schedule(ev) {
      await node.schedule({ output: ev.output, input: ev.input, rate: ev.rate, active: ev.active });
    },
    async setBuffer(buffer) {
      const gen = ++generation;
      await node.dropBuffers();
      if (!buffer || gen !== generation) return;
      // One buffer per file: the 1.3.2 worklet mis-reads windows that span two added buffers once
      // playback is past the first one (its copy loop throws), so chunked loading is not safe.
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
      await node.addBuffers(channels, channels.map((ch) => ch.buffer));
    },
    dispose() {
      generation++;
      node.disconnect();
      node.port.close();
    },
  };
}
