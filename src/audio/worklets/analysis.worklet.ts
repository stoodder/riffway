/**
 * Analysis worklet (T-022): a thin shell around {@link AnalysisCore} (`src/audio/input/analysis-core.ts`,
 * which wraps the T-015 DSP in `@core/dsp`). Posts `AnalysisEvent`s and receives `AnalysisCommand`s
 * (`@shared/audio-events`); `processorOptions` are `AnalysisProcessorOptions`. Frames are context
 * frames (`currentFrame`). No allocation in `process()` beyond the posted message objects.
 */
import {
  PROCESSOR_NAMES,
  type AnalysisCommand,
  type AnalysisEvent,
  type AnalysisProcessorOptions,
} from '@shared/audio-events';
import { AnalysisCore } from '../input/analysis-core';

/** Options passed to the processor constructor (`AudioWorkletNodeOptions` is not in the worklet lib). */
interface ProcessorConstructorOptions {
  processorOptions?: Partial<AnalysisProcessorOptions>;
}

const NO_CHANNELS: Float32Array[] = [];

class AnalysisProcessor extends AudioWorkletProcessor {
  private readonly core: AnalysisCore;

  constructor(options?: ProcessorConstructorOptions) {
    super();
    const opts = options?.processorOptions ?? {};
    this.core = new AnalysisCore({ sampleRate, channel: opts.channel ?? 0, tuner: opts.tuner ?? false }, (ev) =>
      this.port.postMessage(ev),
    );
    this.port.onmessage = (e: MessageEvent<AnalysisCommand>) => this.core.command(e.data);
    const ready: AnalysisEvent = { type: 'ready', sampleRate };
    this.port.postMessage(ready);
  }

  process(inputs: Float32Array[][]): boolean {
    this.core.process(inputs[0] ?? NO_CHANNELS, currentFrame);
    return true;
  }
}

registerProcessor(PROCESSOR_NAMES.analysis, AnalysisProcessor);
