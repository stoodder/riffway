/**
 * Pass-through processor proving the worklet toolchain (Vite `?worker&url` + alias imports +
 * `addModule`). Used by `tests/foundation/audio.browser.test.ts`. Owned by T-010.
 */
import { PROCESSOR_NAMES } from '@shared/audio-events';

class NoopProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.postMessage({ type: 'ready', sampleRate });
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (input && output) {
      for (let ch = 0; ch < output.length; ch++) {
        const src = input[ch] ?? input[0];
        if (src) output[ch]?.set(src);
      }
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAMES.noop, NoopProcessor);
