/**
 * Amp worklet messages (main thread ⇄ `src/audio/worklets/amp.worklet.ts`).
 * @module
 */
import type { AmpCommand } from '@shared/audio-events';
import type { AmpConfig } from './config';
import type { GuardTrip } from './guard';

/**
 * Main thread → amp worklet. Extends the shared {@link AmpCommand} (params without a gate keep the
 * current gate) with the full config and the guard reset.
 */
export type AmpWorkletCommand =
  | AmpCommand
  /** Full config including the preset's gate threshold. */
  | { type: 'config'; config: AmpConfig }
  /** Clear a guard trip and release the duck (the player re-enabled monitoring). */
  | { type: 'guard-reset' };

/** Amp worklet → main thread: the feedback guard tripped and the worklet ducked its output. */
export type AmpWorkletEvent = { type: 'guard'; reason: GuardTrip; frame: number };

/** `processorOptions` for the amp worklet: the initial config (applied before the first block). */
export interface AmpProcessorOptions {
  config: AmpConfig;
}
