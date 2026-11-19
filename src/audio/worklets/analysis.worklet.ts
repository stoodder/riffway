/**
 * Analysis worklet (T-022): a thin shell around {@link AnalysisCore} (`src/audio/input/analysis-core.ts`,
 * which wraps the T-015 DSP in `@core/dsp`). Posts `AnalysisEvent`s and receives `AnalysisCommand`s
 * (`@shared/audio-events`); `processorOptions` are `AnalysisProcessorOptions`. Frames are context
 * frames (`currentFrame`). No allocation in `process()` beyond the posted message objects. A node
 * whose input stays disconnected for {@link RETIRE_AFTER_SEC} after having had one stops (`process()`
 * returns false), so retired graphs do not keep analysing silence on the audio thread.
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
/**
 * A node whose input has had no connection for this long after having had one is retired (its
 * graph was disposed: the source is disconnected) and stops processing (R2-I-08). The shared
 * `AnalysisCommand` contract has no `stop` command, so the disconnect itself is the signal.
 */
const RETIRE_AFTER_SEC = 0.5;

class AnalysisProcessor extends AudioWorkletProcessor {
  private readonly core: AnalysisCore;
  private readonly retireAfter = Math.ceil((RETIRE_AFTER_SEC * sampleRate) / 128);
  private sawInput = false;
  private idleQuanta = 0;

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
    const input = inputs[0] ?? NO_CHANNELS;
    // No channels = nothing connected (before the source is connected, or after a disconnect).
    if (input.length > 0) {
      this.sawInput = true;
      this.idleQuanta = 0;
    } else if (this.sawInput && ++this.idleQuanta >= this.retireAfter) {
      return false;
    }
    this.core.process(input, currentFrame);
    return true;
  }
}

registerProcessor(PROCESSOR_NAMES.analysis, AnalysisProcessor);
