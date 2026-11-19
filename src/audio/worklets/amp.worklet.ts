/**
 * Amp worklet (T-023): wraps `@core/dsp/amp` — noise gate, 4× oversampled ADAA soft clipper, tone
 * stack — and runs the feedback guard on its input, ducking its own output on the audio thread when
 * the guard trips (docs/monitoring.md). Mono in, mono out. Initial config via `processorOptions`
 * ({@link AmpProcessorOptions}); updates via {@link AmpWorkletCommand} messages; guard trips are
 * posted as {@link AmpWorkletEvent}s.
 */
import { PROCESSOR_NAMES } from '@shared/audio-events';
// Submodules, not the `@core/dsp/amp` index: the index's presets pull in `@shared/settings`.
import { AmpEngine } from '@core/dsp/amp/amp';
import { BYPASS_CONFIG, type AmpConfig } from '@core/dsp/amp/config';
import { RunawayGuard } from '@core/dsp/amp/guard';
import type { AmpProcessorOptions, AmpWorkletCommand, AmpWorkletEvent } from '@core/dsp/amp/messages';

class AmpProcessor extends AudioWorkletProcessor {
  private readonly amp: AmpEngine;
  private readonly guard: RunawayGuard;

  constructor(options?: { processorOptions?: Partial<AmpProcessorOptions> }) {
    super();
    // Without options (never the case from MonitorChain) the amp starts as a pass-through.
    this.amp = new AmpEngine(sampleRate, options?.processorOptions?.config ?? BYPASS_CONFIG);
    this.guard = new RunawayGuard(sampleRate);
    this.port.onmessage = (e: MessageEvent<AmpWorkletCommand>) => this.command(e.data);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const input = inputs[0]?.[0];
    if (!input) {
      // Disconnected input: keep running the amp on silence so filter tails decay cleanly.
      out.fill(0);
      this.amp.process(out, out, out.length);
      return true;
    }
    const trip = this.guard.process(input, input.length);
    if (trip) {
      this.amp.setDucked(true);
      const ev: AmpWorkletEvent = { type: 'guard', reason: trip, frame: currentFrame };
      this.port.postMessage(ev);
    }
    this.amp.process(input, out, input.length);
    for (let ch = 1; ch < (outputs[0]?.length ?? 0); ch++) outputs[0]![ch]!.set(out);
    return true;
  }

  private command(cmd: AmpWorkletCommand): void {
    switch (cmd.type) {
      case 'params': {
        const next: AmpConfig = { ...cmd.params, gateDb: this.amp.current.gateDb };
        this.amp.configure(next);
        break;
      }
      case 'config':
        this.amp.configure(cmd.config);
        break;
      case 'guard-reset':
        this.guard.reset();
        this.amp.setDucked(false);
        break;
    }
  }
}

registerProcessor(PROCESSOR_NAMES.amp, AmpProcessor);
