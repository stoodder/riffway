/**
 * Minimal types for `signalsmith-stretch` 1.3.2 (ships none). From its README; extend via a
 * contract change request if T-027 needs more.
 */
declare module 'signalsmith-stretch' {
  export interface StretchSchedule {
    /** Context time of the change. */
    output?: number;
    active?: boolean;
    /** Position in the input buffer (s). */
    input?: number;
    rate?: number;
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
    loopStart?: number;
    loopEnd?: number;
  }

  export interface SignalsmithStretchNode extends AudioWorkletNode {
    readonly inputTime: number;
    setUpdateInterval(seconds: number, callback?: (inputTime: number) => void): void;
    schedule(change: StretchSchedule): void;
    start(when?: number, offset?: number, duration?: number, rate?: number, semitones?: number): void;
    stop(when?: number): void;
    addBuffers(channels: Float32Array[]): Promise<number>;
    dropBuffers(toSeconds?: number): Promise<{ start: number; end: number }>;
    latency(): number;
    configure(options: { blockMs?: number | null; intervalMs?: number; splitComputation?: boolean; preset?: 'default' | 'cheaper' }): void;
  }

  export default function SignalsmithStretch(
    context: BaseAudioContext,
    channelOptions?: AudioWorkletNodeOptions,
  ): Promise<SignalsmithStretchNode>;
}
