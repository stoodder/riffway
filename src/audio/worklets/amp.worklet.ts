/**
 * Amp worklet (T-023): wraps `@core/dsp/amp` (oversampled clipper + tone stack); params via
 * `AmpCommand` messages. **Stub (T-010):** pass-through.
 */
import { PROCESSOR_NAMES, type AmpCommand } from '@shared/audio-events';

class AmpProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<AmpCommand>) => {
      void e.data;
    };
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

registerProcessor(PROCESSOR_NAMES.amp, AmpProcessor);
