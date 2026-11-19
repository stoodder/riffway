/**
 * Game input helpers (T-031): keyboard mode (D6) and pitch `expect` hints for the guitar input.
 * Both feed the one judge path in `src/game/session/`.
 * @module
 */
export {
  attachKeyboard,
  keyLabel,
  laneForCode,
  laneIndex,
  laneMidi,
  openStringMidi,
  type KeyboardHandlers,
  type LaneIndex,
  type LanePress,
} from './keyboard';
export { EXPECT_LOOKAHEAD_SEC, EXPECT_LOOKBACK_SEC, expectedRange, expectedRangeAt, sameRange, type MidiRange } from './expect';
