/**
 * Device listing and matching (docs/audio-input.md § Device selection and persistence). Pure
 * functions over `MediaDeviceInfo`-like records, so the rules are unit-tested in Node:
 *
 * - Chrome hides labels (`''`) until microphone permission is granted; {@link displayLabel} gives
 *   such devices a stable placeholder name.
 * - Chrome on macOS lists aliases (`default`, `communications`) next to the real devices, with labels
 *   like `Default - USB Audio CODEC (0d8c:0014)`. Aliases are never preselected when a real device
 *   matches, and labels are compared without the alias prefix and the `(vid:pid)` suffix.
 * - A saved choice is re-matched by `deviceId`, then by label (Chrome may rotate ids), else the input
 *   falls back (USB-looking label, else the system default) and the caller warns the player.
 * @module
 */
import type { AudioDeviceInfo } from '@shared/services';

/** Labels that look like a guitar interface or USB cable (Cubilux, class-compliant USB codecs). */
export const USB_LABEL_RE = /usb|cubilux|guitar|audio codec/i;

/** Chrome's alias device ids (they follow the OS default rather than a physical device). */
const ALIAS_IDS = new Set(['default', 'communications']);

/** The `MediaDeviceInfo` fields we use. */
export type DeviceLike = Pick<MediaDeviceInfo, 'deviceId' | 'label' | 'groupId' | 'kind'>;

/** Plain {@link AudioDeviceInfo}s of `kind`, in enumeration order. */
export function toDeviceInfos(devices: readonly DeviceLike[], kind: AudioDeviceInfo['kind']): AudioDeviceInfo[] {
  return devices
    .filter((d) => d.kind === kind)
    .map((d) => ({ deviceId: d.deviceId, label: d.label, groupId: d.groupId, kind }));
}

/** True when the browser is hiding device labels (no microphone permission yet). */
export function labelsHidden(devices: readonly AudioDeviceInfo[]): boolean {
  return devices.length > 0 && devices.every((d) => d.label === '');
}

/** True for Chrome's `default` / `communications` alias entries. */
export function isAlias(device: Pick<AudioDeviceInfo, 'deviceId'>): boolean {
  return ALIAS_IDS.has(device.deviceId);
}

/**
 * Label without Chrome's alias prefix (`Default - `, `Communications - `) and USB id suffix
 * (` (0d8c:0014)`), trimmed and lower-cased: the part that survives re-plugging.
 */
export function normalizeLabel(label: string): string {
  return label
    .replace(/^(default|communications)\s+-\s+/i, '')
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
    .trim()
    .toLowerCase();
}

/**
 * Name to show for a device: its label, or `Input 2` / `Output 1` (position among devices of its
 * kind) while labels are hidden. The `default` alias reads `System default`.
 */
export function displayLabel(device: AudioDeviceInfo, index: number): string {
  if (device.label) return device.label;
  if (device.deviceId === 'default') return 'System default';
  return `${device.kind === 'audioinput' ? 'Input' : 'Output'} ${index + 1}`;
}

/** How {@link chooseInput} picked its device. */
export type MatchReason = 'requested' | 'id' | 'label' | 'usb' | 'default';

/** Result of {@link chooseInput}. */
export interface InputChoice {
  device: AudioDeviceInfo;
  by: MatchReason;
  /** A saved choice existed but is not connected ("Your guitar input wasn't found"). */
  fellBack: boolean;
}

/** The saved choice (`settings.input`). */
export interface SavedInput {
  deviceId: string | null;
  label: string | null;
}

/**
 * Pick the input to open from the current device list (docs/audio-input.md § Device selection):
 * the saved `deviceId`; else the saved label (exact, then {@link normalizeLabel}-equal, preferring
 * a physical device over an alias); else — flagged `fellBack` when something was saved — the first
 * physical device whose label matches {@link USB_LABEL_RE}; else the `default` alias; else the first
 * input. Returns null when there are no inputs.
 */
export function chooseInput(inputs: readonly AudioDeviceInfo[], saved: SavedInput): InputChoice | null {
  if (inputs.length === 0) return null;
  const hasSaved = Boolean(saved.deviceId || saved.label);
  if (saved.deviceId) {
    const byId = inputs.find((d) => d.deviceId === saved.deviceId);
    if (byId) return { device: byId, by: 'id', fellBack: false };
  }
  if (saved.label) {
    const byLabel = findByLabel(inputs, saved.label);
    if (byLabel) return { device: byLabel, by: 'label', fellBack: false };
  }
  const usb = inputs.find((d) => !isAlias(d) && USB_LABEL_RE.test(d.label));
  if (usb) return { device: usb, by: 'usb', fellBack: hasSaved };
  const def = inputs.find((d) => d.deviceId === 'default') ?? inputs[0];
  return { device: def, by: 'default', fellBack: hasSaved };
}

/** Exact label match, else normalized match; physical devices win over aliases. */
export function findByLabel(devices: readonly AudioDeviceInfo[], label: string): AudioDeviceInfo | null {
  const ordered = [...devices.filter((d) => !isAlias(d)), ...devices.filter(isAlias)];
  const exact = ordered.find((d) => d.label !== '' && d.label === label);
  if (exact) return exact;
  const wanted = normalizeLabel(label);
  if (!wanted) return null;
  return ordered.find((d) => d.label !== '' && normalizeLabel(d.label) === wanted) ?? null;
}

/**
 * Whether the saved device is present in `inputs` (by id or label), i.e. whether a fallback input
 * or a disconnected one should be re-opened on the saved choice after a `devicechange`.
 */
export function savedDevicePresent(inputs: readonly AudioDeviceInfo[], saved: SavedInput): AudioDeviceInfo | null {
  if (saved.deviceId) {
    const byId = inputs.find((d) => d.deviceId === saved.deviceId);
    if (byId) return byId;
  }
  return saved.label ? findByLabel(inputs, saved.label) : null;
}
