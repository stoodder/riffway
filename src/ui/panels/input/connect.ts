/**
 * "Connect guitar input" flow shared by the input and tuner panels: start the audio engine inside
 * the click's user activation (falling back to the shell's "Click to enable audio" overlay), then
 * open the input. Also maps `getUserMedia` errors to player-facing text.
 * @module
 */
import type { AudioEngine, InputService } from '@shared/services';
import type { AppContext } from '@shared/ui';

/** How long to wait for `resume()` inside the click before falling back to the overlay, ms. */
const RESUME_WAIT_MS = 400;

/**
 * Call from a click handler. Resumes the engine (the click counts as the gesture), opens the input
 * if it is not open yet, and resolves with the open result. Rejects with the shell's
 * `AudioGestureDismissedError` if the player dismisses the overlay, or with the `getUserMedia` error.
 */
export async function connectInput(ctx: AppContext, engine: AudioEngine, input: InputService): Promise<void> {
  if (!engine.running) {
    const resumed = engine.resume().then(
      () => true,
      () => false,
    );
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), RESUME_WAIT_MS));
    if (!(await Promise.race([resumed, timeout]))) await ctx.ui.requireAudioGesture();
  }
  if (!input.current) await input.open();
}

/** True for the shell's "Not now" rejection (`AudioGestureDismissedError`). */
export function isGestureDismissed(err: unknown): boolean {
  return err instanceof Error && err.name === 'AudioGestureDismissedError';
}

/** Player-facing text for an error from opening the input. */
export function describeOpenError(err: unknown): string {
  const name = err instanceof Error || (typeof err === 'object' && err !== null) ? (err as { name?: string }).name : undefined;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access is blocked. Allow it for this site in Chrome (the icon left of the address bar), then connect again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'That input is not connected. Plug in your guitar cable or pick another input.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The input is busy or failed to start. Close other apps using it (or unplug and re-plug the cable), then try again.';
    default:
      return err instanceof Error ? err.message : String(err);
  }
}
