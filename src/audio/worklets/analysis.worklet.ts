/**
 * Analysis worklet (T-022): thin shell around `@core/dsp` (T-015) posting `AnalysisEvent`s and
 * receiving `AnalysisCommand`s (`@shared/audio-events`). No allocation in `process()` beyond message
 * objects. **Stub (T-010):** registers the processor and posts `ready`; analyses nothing.
 */
import { PROCESSOR_NAMES, type AnalysisCommand, type AnalysisEvent } from '@shared/audio-events';

class AnalysisProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<AnalysisCommand>) => {
      void e.data;
    };
    const ready: AnalysisEvent = { type: 'ready', sampleRate };
    this.port.postMessage(ready);
  }

  process(): boolean {
    return true;
  }
}

registerProcessor(PROCESSOR_NAMES.analysis, AnalysisProcessor);
