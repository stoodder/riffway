/**
 * UI contracts: screen/panel mount contract, registries, the `AppContext` handed to every screen and
 * panel, the lazy service registry, and the e2e test hook. **Browser-only.**
 *
 * - Screens live in `src/ui/screens/<id>/index.ts` and export `mount: ScreenMount`; they are
 *   registered (with route and nav entry) in `src/ui/screens/index.ts` — already done for every
 *   planned screen, so tasks only fill in their own folder.
 * - Panels live in `src/ui/panels/<id>/index.ts` and export `mount: PanelMount<PanelPropsMap[id]>`;
 *   registered in `src/ui/panels/index.ts`. Screens embed panels with `mountPanel()` from that file.
 * - Services are created lazily with `ctx.services.get(id)` (factories in `src/app/services.ts`).
 * @module
 */
import type { ApiClient } from './api';
import type { Unsubscribe } from './clock';
import type { Judgement, JudgeState } from './judge';
import type {
  AudioEngine,
  BackingService,
  GameSession,
  GuideService,
  InputService,
  MonitorService,
  SessionState,
  SongLoader,
} from './services';
import type { SettingsStore } from './settings';
import type { Song, StringNumber } from './song';
import type { StorageService } from './storage';

// ---------------------------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------------------------

/** Lazily created singletons, keyed by id. */
export interface ServiceMap {
  engine: AudioEngine;
  input: InputService;
  monitor: MonitorService;
  guide: GuideService;
  songLoader: SongLoader;
  backing: BackingService;
}

export type ServiceId = keyof ServiceMap;

/** Creates a service; may `await ctx.services.get(...)` for its dependencies. */
export type ServiceFactory<K extends ServiceId> = (ctx: AppContext) => Promise<ServiceMap[K]>;

/** Service registry (`src/app/services.ts`). `get` creates once and caches the promise. */
export interface ServiceRegistry {
  get<K extends ServiceId>(id: K): Promise<ServiceMap[K]>;
  /** The instance if already created, else null (never creates). */
  peek<K extends ServiceId>(id: K): ServiceMap[K] | null;
}

// ---------------------------------------------------------------------------------------------
// Router, UI helpers, AppContext
// ---------------------------------------------------------------------------------------------

/** Path + query params of the current route (all strings, already URL-decoded). */
export type RouteParams = Record<string, string>;

/** A resolved route. */
export interface RouteMatch {
  screen: ScreenId;
  /** The hash path without `#`, e.g. `/song/local%3Aab12`. */
  path: string;
  params: RouteParams;
}

/** Hash router (`#/library?q=…`), implemented by `src/ui/router.ts` (T-018). */
export interface RouterApi {
  /** Navigate to a hash path (`'/library'`) or a full `#/…` href. */
  navigate(path: string, opts?: { replace?: boolean }): void;
  /** Build an href (`#/song/local%3Aab12?arr=0`) for a screen; extra params go to the query. */
  href(screen: ScreenId, params?: RouteParams): string;
  current(): RouteMatch | null;
  back(): void;
  onChange(cb: (route: RouteMatch) => void): Unsubscribe;
}

/** Toast kinds. */
export type ToastKind = 'info' | 'success' | 'warning' | 'error';

/** Global UI affordances provided by the shell (T-018). */
export interface UiApi {
  toast(message: string, opts?: { kind?: ToastKind; timeoutMs?: number }): void;
  confirm(message: string, opts?: { title?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>;
  /** Show the "Click to enable audio" gesture overlay until the engine is running. */
  requireAudioGesture(): Promise<void>;
}

/** Runtime flags from the URL / build. */
export interface AppFlags {
  /** `?e2e=1`: install `window.__riffwayTest`, disable animations that slow tests. */
  e2e: boolean;
  /** Vite dev mode (dev screens visible). */
  dev: boolean;
}

/** Handed to every screen and panel. */
export interface AppContext {
  readonly api: ApiClient;
  readonly settings: SettingsStore;
  readonly storage: StorageService;
  readonly services: ServiceRegistry;
  readonly router: RouterApi;
  readonly ui: UiApi;
  readonly flags: AppFlags;
}

// ---------------------------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------------------------

/** Every screen (one owner each; see TASKS.md). */
export type ScreenId =
  | 'home'
  | 'library'
  | 'import'
  | 'song'
  | 'game'
  | 'results'
  | 'settings'
  | 'audio-setup'
  | 'dev-components'
  | 'dev-highway';

/** Returned by a mount; `unmount` must remove listeners, timers, rAF loops and child panels. */
export interface MountHandle {
  unmount(): void;
}

/** A mounted screen. `update` (optional) handles param changes without remounting. */
export interface ScreenHandle extends MountHandle {
  update?(params: RouteParams): void;
}

/** Screen entry point: render into `el` (the shell's main region, already empty). */
export type ScreenMount = (el: HTMLElement, ctx: AppContext, params: RouteParams) => ScreenHandle | Promise<ScreenHandle>;

/** What `src/ui/screens/<id>/index.ts` exports. */
export interface ScreenModule {
  mount: ScreenMount;
}

/** One registry row (`src/ui/screens/index.ts`). */
export interface ScreenRegistration {
  id: ScreenId;
  /** Route pattern with `:params`, e.g. `/song/:id`. Query params are passed through. */
  path: string;
  title: string;
  /** Top-nav entry (Home, Library, Import, Audio setup, Settings). */
  nav?: { label: string; order: number };
  /** Hidden from nav; reachable in dev builds and e2e. */
  dev?: boolean;
  /** Owning task (for placeholders). */
  owner: string;
  load(): Promise<ScreenModule>;
}

// ---------------------------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------------------------

/** Every panel. */
export type PanelId = 'input' | 'tuner' | 'monitor' | 'calibration' | 'backing' | 'practice' | 'mixer';

/** Props per panel. */
export interface PanelPropsMap {
  /** Device select, level meter (T-022). */
  input: Record<string, never>;
  /** Tuner; defaults to the current song's tuning or standard (T-022). */
  tuner: { tuning?: number[] };
  /** Monitoring, amp presets, latency display, guards (T-023). */
  monitor: Record<string, never>;
  /** Latency calibration wizard (T-033). */
  calibration: { mode?: 'guitar' | 'keyboard' | 'visual' };
  /** Backing-audio attach + alignment (T-027). */
  backing: { songId: string; arrangement: number; song: Song };
  /** Speed, A/B loop, trainer, count-in, metronome (T-032). */
  practice: { session: GameSession };
  /** Mixer sliders; with a session also guide/backing toggles (T-032). */
  mixer: { session?: GameSession };
}

/** A mounted panel; `update` receives prop changes. */
export interface PanelHandle<P> extends MountHandle {
  update?(props: Partial<P>): void;
}

/** Panel entry point. */
export type PanelMount<P> = (el: HTMLElement, ctx: AppContext, props: P) => PanelHandle<P> | Promise<PanelHandle<P>>;

/** What `src/ui/panels/<id>/index.ts` exports. */
export interface PanelModule<K extends PanelId> {
  mount: PanelMount<PanelPropsMap[K]>;
}

/** One registry row (`src/ui/panels/index.ts`). */
export interface PanelRegistration<K extends PanelId> {
  id: K;
  title: string;
  owner: string;
  load(): Promise<PanelModule<K>>;
}

// ---------------------------------------------------------------------------------------------
// e2e test hook (`?e2e=1`, D6) — installed by src/test-hooks (stub now, filled by T-031)
// ---------------------------------------------------------------------------------------------

/** `window.__riffwayTest.inject()` argument: a keyboard-style event at an exact song time. */
export interface TestInjectArgs {
  /** String lane, 1 = high e. */
  lane: StringNumber;
  /** Song time (s at 100%) at which the event happens. */
  songTime: number;
  /** +1 semitone (deliberate WrongNote), like Shift in keyboard mode. */
  wrongPitch?: boolean;
}

/** Snapshot returned by `getState()`. */
export interface TestHookState {
  route: RouteMatch | null;
  session: {
    songId: string;
    arrangement: number;
    state: SessionState;
    songTime: number;
    speed: number;
    judge: JudgeState;
  } | null;
}

/** `window.__riffwayTest`. Methods that need a session reject/throw when none is active. */
export interface RiffwayTestHook {
  readonly version: 1;
  /** True once a game session is ready. */
  ready(): boolean;
  inject(args: TestInjectArgs): void;
  getState(): TestHookState;
  getJudgements(): Judgement[];
  setSpeed(speed: number): Promise<void>;
  seek(songTime: number): void;
}

declare global {
  interface Window {
    __riffwayTest?: RiffwayTestHook;
  }
}
