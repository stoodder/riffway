/**
 * Guitar input (T-022): device listing/persistence/re-matching, `getUserMedia` constraints exactly
 * per docs/audio-input.md, analysis worklet bridge (frames → ctx seconds, `inputOffsetMs` applied).
 * Signature frozen by T-010; reached via `ctx.services.get('input')`.
 *
 * Pieces: `./devices` (listing + matching rules), `./constraints` (constraints + read-back),
 * `./analysis-core` (the worklet's DSP state machine), `./service` (the service logic). The panels
 * live in `src/ui/panels/input/` and `src/ui/panels/tuner/`.
 * @module
 */
import { PROCESSOR_NAMES, type AnalysisProcessorOptions } from '@shared/audio-events';
import type { AudioEngine, InputService } from '@shared/services';
import type { SettingsStore } from '@shared/settings';
import { WORKLET_URLS } from '../worklet-urls';
import { createInputServiceWith, type AnalysisGraph } from './service';

export { createInputServiceWith, type AnalysisGraph, type InputServiceDeps } from './service';

/** `addModule` once per context. */
const workletLoads = new WeakMap<BaseAudioContext, Promise<void>>();

function loadAnalysisWorklet(ctx: BaseAudioContext): Promise<void> {
  let p = workletLoads.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(WORKLET_URLS.analysis);
    workletLoads.set(ctx, p);
    p.catch(() => workletLoads.delete(ctx));
  }
  return p;
}

/**
 * Create the analysis node on `ctx` with its input fixed to two discrete channels (channel select
 * happens in the worklet) and no outputs (Chrome pulls output-less worklet nodes on its own).
 */
export async function createAnalysisNode(ctx: BaseAudioContext, opts: AnalysisProcessorOptions): Promise<AudioWorkletNode> {
  await loadAnalysisWorklet(ctx);
  return new AudioWorkletNode(ctx, PROCESSOR_NAMES.analysis, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete',
    processorOptions: opts,
  });
}

async function createGraph(ctx: AudioContext, stream: MediaStream, opts: AnalysisProcessorOptions): Promise<AnalysisGraph> {
  const node = await createAnalysisNode(ctx, opts);
  const source = ctx.createMediaStreamSource(stream);
  source.connect(node);
  return {
    source,
    port: node.port,
    dispose() {
      source.disconnect();
      node.port.onmessage = null;
      node.port.close();
    },
  };
}

/** Create the input service for the app's engine and settings. */
export async function createInputService(engine: AudioEngine, settings: SettingsStore): Promise<InputService> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
    throw new Error('This browser cannot access audio inputs (navigator.mediaDevices is missing).');
  }
  return createInputServiceWith(engine, settings, { mediaDevices: navigator.mediaDevices, createGraph });
}
