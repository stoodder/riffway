/**
 * Types for `signalsmith-stretch` 1.3.2 (the package ships none), checked against its README and
 * `SignalsmithStretch.mjs`. Every remote method posts a message to the worklet and returns a
 * Promise for the worklet's answer. A remote method takes one optional extra argument beyond its
 * declared ones: the `postMessage` transfer list (e.g. the channel `ArrayBuffer`s for `addBuffers`).
 *
 * Behaviour that the types cannot express (see docs/timing.md § Backing audio alignment):
 * - `schedule` drops every queued change at or after the worklet's **current time** (not after the
 *   new change's `output`), so only one future change can be pending at a time.
 * - Windows that span two added buffers are mis-read once playback is past the first, so load a
 *   file as one buffer per channel.
 */
declare module 'signalsmith-stretch' {
  /** One time-map change (all fields optional; unspecified ones carry over from the previous change). */
  export interface StretchSchedule {
    /** Context time of the change (default: now). The node compensates its own latency. */
    output?: number;
    /** Processing on/off. */
    active?: boolean;
    /** Position in the input buffer at `output` (s). */
    input?: number;
    /** Input seconds per output second (0.5 = half speed). */
    rate?: number;
    /** Pitch shift. */
    semitones?: number;
    /** Tonality limit (default 8000 Hz). */
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    /** Rough fundamental for formant analysis; 0 = track pitch. */
    formantBaseHz?: number;
    /** Auto-loop a section of the input buffer (disabled when equal). */
    loopStart?: number;
    loopEnd?: number;
  }

  /** A time-map change as stored by the worklet (every field resolved). */
  export type StretchSegment = Required<Pick<StretchSchedule, 'output' | 'active' | 'input' | 'rate'>> & StretchSchedule;

  /** Block configuration (`blockMs` 0/null selects a `preset`). */
  export interface StretchConfig {
    blockMs?: number | null;
    intervalMs?: number;
    splitComputation?: boolean;
    preset?: 'default' | 'cheaper';
  }

  /** The stretch `AudioWorkletNode` with its remote methods. */
  export interface SignalsmithStretchNode extends AudioWorkletNode {
    /** Current playback position within the input buffers (s), updated from the worklet. */
    inputTime: number;
    /** How often `inputTime` is refreshed (s), with an optional callback per update. */
    setUpdateInterval(seconds: number, callback?: (inputTime: number) => void): Promise<void>;
    /**
     * Add a time-map change. `adjustPrevious` re-slopes the previous change so it lands exactly at
     * this one. Resolves with the stored change.
     */
    schedule(change: StretchSchedule, adjustPrevious?: boolean, transfer?: Transferable[]): Promise<StretchSegment>;
    /** `schedule({active: true, …})` at `when` (default now + output latency). */
    start(when?: number | StretchSchedule, offset?: number, duration?: number, rate?: number, semitones?: number, transfer?: Transferable[]): Promise<StretchSegment>;
    /** `schedule({active: false, output: when})` (default now). */
    stop(when?: number, transfer?: Transferable[]): Promise<StretchSegment>;
    /** Append one buffer per channel (equal lengths); resolves with the new input end time (s). */
    addBuffers(channels: Float32Array[], transfer?: Transferable[]): Promise<number>;
    /**
     * Without `toSeconds`: drop every buffer and reset the end to 0. With it: drop buffers that end
     * before `toSeconds`. Resolves with the remaining extent (s).
     */
    dropBuffers(toSeconds?: number, transfer?: Transferable[]): Promise<{ start: number; end: number }>;
    /** Input + output latency (s): schedule changes at least this far ahead. */
    latency(): Promise<number>;
    configure(options: StretchConfig, transfer?: Transferable[]): Promise<void>;
  }

  /** Create the node on `context` (registers the worklet module once per context). */
  export default function SignalsmithStretch(
    context: BaseAudioContext,
    channelOptions?: AudioWorkletNodeOptions,
  ): Promise<SignalsmithStretchNode>;
}
