/**
 * Game: the orchestrator. Owns play state and wires every module together per
 * the "Behaviour spec" in SPEC.md:
 *
 *   keyboard / pointer → content → scene (+ burst) · audio (note, pan by x) · speech
 *
 * plus the start screen, grown-up panel, overlays, session timer with its
 * wind-down, idle attract, world auto-rotation, fullscreen-loss recovery,
 * stats, and live settings.
 *
 * Game only depends on the contracts in types.ts. Inputs and UI are built
 * through factories (they need Game's handlers), and the clock, random source,
 * page visibility and reduced-motion query are injectable for tests. Nothing
 * here runs per frame except `update()`, which does a handful of comparisons.
 */
import { cheer, contentForKey, contentForTap, shapeLabel } from './content';
import { pentatonic } from './keymap';
import type {
  AudioEngine,
  ContentContext,
  KeyContent,
  KeyMap,
  KeyPosition,
  KeyPress,
  KeyboardHandlers,
  KeyboardInput,
  LockStatus,
  Lockdown,
  NamedColor,
  Overlays,
  ParentPanel,
  ParentPanelDeps,
  PokeResult,
  PointerHandlers,
  PointerInput,
  Scene,
  SceneOptions,
  SessionStats,
  Settings,
  SettingsStore,
  SmashEvent,
  SoundEffect,
  Speaker,
  SpecialEffect,
  StartScreen,
  StartScreenDeps,
  World,
  WorldId,
} from './types';
import { WORLDS, WORLD_ORDER, nextWorld } from './worlds';

/** Glyph font: Fredoka is bundled via @fontsource (no network). */
export const FONT_FAMILY = '"Fredoka", system-ui, sans-serif';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Spawn spots keep this fraction of the viewport clear on every side. */
const SAFE_MARGIN = 0.1;
/** Spatial keys wobble by up to ±4% of the viewport so repeats don't stack exactly. */
const JITTER = 0.04;
/** Random spots avoid this many previous spots. */
const RECENT_SPOTS = 3;
const SPOT_TRIES = 8;
/** Held keys sparkle at most 8 times a second. */
const REPEAT_INTERVAL_MS = 125;
/** Keys closer together than this are a mash (or the start of a palm smash): no speech. */
const MASH_GAP_MS = 90;
/** After a smash, stay quiet this long so the cheer isn't cut off. */
const SMASH_QUIET_MS = 450;
/** Drag distance between trail notes. */
const DRAG_NOTE_PX = 90;
const IDLE_AFTER_MS = 20_000;
const IDLE_EVERY_MS = 4_000;
/** ± spread on the idle cadence so it doesn't feel mechanical. */
const IDLE_SPREAD_MS = 1_000;
const WIND_DOWN_MS = 45_000;
const WIND_DOWN_LEVEL = 0.25;
/** A frame gap longer than this (tab hidden, debugger) is not counted as play. */
const MAX_TICK_MS = 250;
/** "Yay, {name}!" every 35–45 key presses. */
const NAME_CHEER_MIN = 35;
const NAME_CHEER_SPREAD = 11;
/** Objects remembered for poke replay (by kind + value). */
const MEMORY_SIZE = 64;
/** Distinct key labels counted for stats (a keyboard has ~110). */
const MAX_LABELS = 200;
/** Remembered spawn spots for repeats (one per physical key). */
const MAX_KEY_SPOTS = 160;
/** Pointer drag states kept at once (the pointer module tracks ≤ 16). */
const MAX_DRAGS = 16;
const HOVER_TRAIL_ID = -1;
/** A hover pause longer than this starts a new trail colour. */
const HOVER_STROKE_GAP_MS = 400;

const FALLBACK_COLOR: NamedColor = { name: 'blue', hex: '#5cc8ff' };
const ARROW_LABELS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };

// ---------------------------------------------------------------------------
// Helpers shared with main.ts
// ---------------------------------------------------------------------------

/** The subset of MediaQueryList Game uses (old Safari only has addListener). */
export interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener?(type: 'change', listener: () => void): void;
  removeEventListener?(type: 'change', listener: () => void): void;
  addListener?(listener: () => void): void;
  removeListener?(listener: () => void): void;
}

/** Page visibility, injectable for tests. */
export interface VisibilitySource {
  isVisible(): boolean;
  onChange(listener: () => void): () => void;
}

/** `(prefers-reduced-motion: reduce)` or null where matchMedia is unavailable. */
export function reducedMotionQuery(): MediaQueryListLike | null {
  try {
    return typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  } catch {
    return null;
  }
}

export function resolveReducedMotion(pref: Settings['motion'], systemReduce: boolean): boolean {
  return pref === 'reduce' ? true : pref === 'full' ? false : systemReduce;
}

export function sceneOptionsFor(settings: Settings, systemReduce: boolean, fontFamily: string = FONT_FAMILY): SceneOptions {
  return {
    reduceMotion: resolveReducedMotion(settings.motion, systemReduce),
    intensity: settings.intensity,
    size: settings.size,
    faces: settings.faces,
    fontFamily,
  };
}

function documentVisibility(): VisibilitySource {
  return {
    isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
    onChange: (listener) => {
      if (typeof document === 'undefined') return noop;
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

function noop(): void {
  // Intentionally empty.
}

function speechOn(s: Settings): boolean {
  return s.speech !== 'off' && !s.muted;
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

export interface GameDeps {
  store: SettingsStore;
  scene: Scene;
  audio: AudioEngine;
  speaker: Speaker;
  lockdown: Lockdown;
  keyMap: KeyMap;
  overlays: Overlays;
  /** Current play-surface size in CSS px (the stage's width/height). */
  viewport(): { width: number; height: number };
  createKeyboard(handlers: KeyboardHandlers, secretWord: string): KeyboardInput;
  createPointer(handlers: PointerHandlers): PointerInput;
  createStartScreen(deps: StartScreenDeps): StartScreen;
  createParentPanel(deps: ParentPanelDeps): ParentPanel;
  worlds?: Record<WorldId, World>;
  install?: { canInstall(): boolean; prompt(): void };
  fontFamily?: string;
  /** Random source in [0, 1). Default Math.random. */
  rng?: () => number;
  /** Monotonic clock in ms (same origin as the frame loop's `now`). Default performance.now. */
  now?: () => number;
  /** Wall clock (epoch ms) for SessionStats.startedAt. Default Date.now. */
  wallClock?: () => number;
  /** Default: matchMedia('(prefers-reduced-motion: reduce)'). null = never reduce for 'system'. */
  reducedMotion?: MediaQueryListLike | null;
  /** Default: document.visibilityState. */
  visibility?: VisibilitySource;
}

export type PlayState = 'idle' | 'playing' | 'alldone';

interface Spot {
  x: number;
  y: number;
}

interface KeySpot extends Spot {
  color: NamedColor;
}

/** What an object on screen sounded like, so a poke can replay it. */
interface Memory {
  midi: number | null;
  effect: SoundEffect | null;
  speak: string | null;
}

interface DragState {
  dist: number;
  color: NamedColor;
}

type EnterReason = 'start' | 'resume' | 'relock' | 'setting';

export class Game {
  private readonly store: SettingsStore;
  private readonly scene: Scene;
  private readonly audio: AudioEngine;
  private readonly speaker: Speaker;
  private readonly lockdown: Lockdown;
  private readonly keyMap: KeyMap;
  private readonly overlays: Overlays;
  private readonly viewport: () => { width: number; height: number };
  private readonly worlds: Record<WorldId, World>;
  private readonly install: GameDeps['install'];
  private readonly fontFamily: string;
  private readonly rng: () => number;
  private readonly now: () => number;
  private readonly wallClock: () => number;
  private readonly visibility: VisibilitySource;
  private readonly reduceQuery: MediaQueryListLike | null;

  private readonly keyboard: KeyboardInput;
  private readonly pointer: PointerInput;
  private readonly startScreen: StartScreen;
  private readonly panel: ParentPanel;
  private readonly unsubscribers: Array<() => void> = [];

  private state: PlayState = 'idle';
  private settings: Settings;
  private world: World;
  private readonly content: ContentContext;
  private systemReduce = false;

  // Lockdown
  /** Fullscreen was granted during this play session (so losing it shows the resume screen). */
  private fullscreenGranted = false;
  private enterToken = 0;

  // Timers (all in ms of active play unless noted)
  private lastTick: number | null = null;
  private sessionMs = 0;
  private rotateMs = 0;
  /** sessionMs when the wind-down began, or -1. */
  private windDownAt = -1;
  /** Clock time (not play time) of the next idle friend. */
  private nextIdleAt = 0;

  // Keys
  private lastKeyAt = Number.NEGATIVE_INFINITY;
  private lastRepeatAt = Number.NEGATIVE_INFINITY;
  private quietUntil = Number.NEGATIVE_INFINITY;
  private keysSinceCheer = 0;
  private nextCheerAt = NAME_CHEER_MIN;
  private readonly keySpots = new Map<string, KeySpot>();
  private readonly recentX = new Float64Array(RECENT_SPOTS);
  private readonly recentY = new Float64Array(RECENT_SPOTS);
  private recentNext = 0;
  private recentCount = 0;
  private readonly memory = new Map<string, Memory>();

  // Pointers
  private readonly drags = new Map<number, DragState>();
  private hoverColor: NamedColor | null = null;
  private lastHoverAt = Number.NEGATIVE_INFINITY;
  private trailColorIndex = 0;

  // Stats
  private startedAt = 0;
  private keys = 0;
  private taps = 0;
  private smashes = 0;
  private playMs = 0;
  private readonly labels = new Map<string, number>();

  constructor(deps: GameDeps) {
    this.store = deps.store;
    this.scene = deps.scene;
    this.audio = deps.audio;
    this.speaker = deps.speaker;
    this.lockdown = deps.lockdown;
    this.keyMap = deps.keyMap;
    this.overlays = deps.overlays;
    this.viewport = deps.viewport;
    this.worlds = deps.worlds ?? WORLDS;
    this.install = deps.install;
    this.fontFamily = deps.fontFamily ?? FONT_FAMILY;
    this.rng = deps.rng ?? Math.random;
    this.now = deps.now ?? (() => performance.now());
    this.wallClock = deps.wallClock ?? Date.now;
    this.visibility = deps.visibility ?? documentVisibility();
    this.reduceQuery = deps.reducedMotion !== undefined ? deps.reducedMotion : reducedMotionQuery();
    this.systemReduce = !!this.reduceQuery?.matches;

    this.settings = this.store.get();
    this.world = this.worldFor(this.settings.world);
    this.content = { world: this.world, settings: this.settings, rng: this.rng };
    this.nextCheerAt = this.cheerInterval();

    const worldList = WORLD_ORDER.map((id) => this.worlds[id]).filter((w): w is World => !!w);

    this.keyboard = deps.createKeyboard(
      { onKey: this.onKey, onSmash: this.onSmash, onSecret: this.onSecret },
      this.settings.secretWord,
    );
    this.pointer = deps.createPointer({
      onTap: this.onTap,
      onDrag: this.onDrag,
      onRelease: this.onRelease,
      onHover: this.onHover,
      onCornerHold: this.onCornerHold,
      onCornerProgress: this.onCornerProgress,
    });
    this.panel = deps.createParentPanel({
      store: this.store,
      worlds: worldList,
      speaker: this.speaker,
      getStats: () => this.getStats(),
      getLockStatus: () => this.lockStatus(),
      canInstall: () => this.install?.canInstall() ?? false,
      actions: {
        resume: () => this.resumeFromPanel(),
        stop: () => this.stop(),
        relock: () => this.relock(),
        testSound: () => this.testSound(),
        resetStats: () => this.resetStats(),
        install: () => this.install?.prompt(),
      },
    });
    this.startScreen = deps.createStartScreen({
      store: this.store,
      worlds: worldList,
      onStart: () => this.start(),
      onOpenControls: () => this.openPanel(),
    });

    this.unsubscribers.push(
      this.store.subscribe((next, prev) => this.applySettings(next, prev)),
      this.lockdown.onChange((status) => this.onLockChange(status)),
      this.visibility.onChange(() => this.onVisibilityChange()),
    );
    this.watchReducedMotion();
    this.applyAll();
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  get playState(): PlayState {
    return this.state;
  }

  /** On the start screen with no panel open: safe to reload (e.g. for an app update). */
  get isIdle(): boolean {
    return this.state === 'idle' && !this.panel.isOpen;
  }

  /** Called from the user gesture that starts play (the start screen's click/tap/key). */
  start(): void {
    if (this.state !== 'idle') return;
    // Fullscreen must be requested synchronously inside the gesture: first.
    this.enterLockdown('start', false);
    this.unlockAudio();

    this.state = 'playing';
    this.startScreen.hide();
    this.overlays.hideAllDone();
    this.overlays.hideResume();
    this.fullscreenGranted = this.lockStatus().fullscreen;
    this.lockdown.setConfirmExit(this.settings.confirmExit);

    this.resetSession();
    this.rotateMs = 0;
    this.lastTick = null;
    this.keysSinceCheer = 0;
    this.lastKeyAt = Number.NEGATIVE_INFINITY;
    this.quietUntil = Number.NEGATIVE_INFINITY;
    this.markInput(this.now());
    if (this.startedAt === 0) this.startedAt = this.wallClock();

    this.keyboard.attach();
    this.keyboard.setEnabled(true);
    this.pointer.attach();
    this.pointer.setEnabled(true);

    const name = this.settings.childName;
    this.speaker.say(name ? `Hi, ${name}!` : "Let's play!", 'high');
  }

  /** Leave play: exit fullscreen and locks, show the start screen. */
  stop(): void {
    this.panel.close();
    if (this.state === 'idle') return;
    // State first: the fullscreen exit below must not look like a toddler escape.
    this.state = 'idle';
    this.fullscreenGranted = false;
    this.overlays.hideAllDone();
    this.overlays.hideResume();
    this.overlays.setCornerProgress(0);
    this.keyboard.setEnabled(false);
    this.keyboard.detach();
    this.pointer.setEnabled(false);
    this.pointer.detach();
    this.endAllTrails();
    this.speaker.cancel();
    this.resetSession();
    this.lockdown.setConfirmExit(false);
    this.exitLockdown();
    this.startScreen.show();
  }

  /**
   * Per-frame tick (call before scene.update). Advances the session timer,
   * wind-down, auto-rotation, idle attract and play-time stats. Only active,
   * visible play counts; long gaps are capped.
   */
  update(_dt: number, now: number = this.now()): void {
    const last = this.lastTick;
    this.lastTick = now;
    if (last === null) return;
    let elapsed = now - last;
    if (!(elapsed > 0)) return;
    if (elapsed > MAX_TICK_MS) elapsed = MAX_TICK_MS;
    if (this.state !== 'playing' || this.panel.isOpen || !this.visibility.isVisible()) return;

    this.playMs += elapsed;
    const s = this.settings;

    if (s.sessionMinutes > 0) {
      this.sessionMs += elapsed;
      if (this.windDownAt < 0 && this.sessionMs >= s.sessionMinutes * 60_000) this.beginWindDown();
    }
    if (this.windDownAt >= 0) {
      const progress = Math.min(1, (this.sessionMs - this.windDownAt) / WIND_DOWN_MS);
      this.scene.setCalm(progress);
      if (progress >= 1) this.finishSession();
      return; // no rotation or idle friends while drifting off to sleep
    }

    if (s.autoRotate) {
      this.rotateMs += elapsed;
      if (this.rotateMs >= s.rotateMinutes * 60_000) {
        this.rotateMs = 0;
        // Through the store, so the panel and the next launch agree on the world.
        this.store.update({ world: nextWorld(this.world.id) });
      }
    }

    if (now >= this.nextIdleAt) {
      this.spawnIdleFriend();
      this.nextIdleAt = now + IDLE_EVERY_MS + (this.rng() * 2 - 1) * IDLE_SPREAD_MS;
    }
  }

  getStats(): SessionStats {
    const top = Array.from(this.labels.entries());
    top.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return {
      startedAt: this.startedAt || this.wallClock(),
      keys: this.keys,
      taps: this.taps,
      smashes: this.smashes,
      topKeys: top.slice(0, 5),
      playMs: Math.round(this.playMs),
    };
  }

  resetStats(): void {
    this.startedAt = this.wallClock();
    this.keys = 0;
    this.taps = 0;
    this.smashes = 0;
    this.playMs = 0;
    this.labels.clear();
  }

  /** Removes every subscription and listener (tests / hot reload). */
  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.keyboard.detach();
    this.pointer.detach();
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  private applyAll(): void {
    const s = this.settings;
    this.audio.setVolume(s.volume);
    this.audio.setMuted(s.muted);
    this.audio.setTimbre(this.world.timbre);
    this.audio.setRoot(this.world.rootMidi);
    this.speaker.setVolume(s.volume);
    this.speaker.setVoice(s.voiceURI);
    this.speaker.setEnabled(speechOn(s));
    this.scene.setOptions(this.sceneOptions());
    this.scene.setWorld(this.world);
    this.keyboard.setSecretWord(s.secretWord);
  }

  private applySettings(next: Settings, prev: Settings): void {
    this.settings = next;
    this.content.settings = next;

    if (next.world !== prev.world) this.setWorld(next.world);
    if (next.volume !== prev.volume || next.muted !== prev.muted) {
      this.audio.setVolume(next.volume);
      this.audio.setMuted(next.muted);
      this.speaker.setVolume(next.volume);
    }
    if (next.speech !== prev.speech || next.muted !== prev.muted) this.speaker.setEnabled(speechOn(next));
    if (next.voiceURI !== prev.voiceURI) this.speaker.setVoice(next.voiceURI);
    if (
      next.motion !== prev.motion ||
      next.intensity !== prev.intensity ||
      next.size !== prev.size ||
      next.faces !== prev.faces
    ) {
      this.scene.setOptions(this.sceneOptions());
    }
    if (next.secretWord !== prev.secretWord) this.keyboard.setSecretWord(next.secretWord);
    if (next.confirmExit !== prev.confirmExit && this.state !== 'idle') this.lockdown.setConfirmExit(next.confirmExit);
    // Toggling the lock switch is a click in the panel: a user gesture, so apply it now.
    if (next.lockKeyboard !== prev.lockKeyboard && this.state !== 'idle' && this.lockStatus().fullscreen) {
      this.enterLockdown('setting', false);
    }
    if (next.autoRotate !== prev.autoRotate || next.rotateMinutes !== prev.rotateMinutes) this.rotateMs = 0;
    if (!next.trails && prev.trails) this.endAllTrails();
    if (next.sessionMinutes !== prev.sessionMinutes && this.state === 'playing') {
      // A new limit counts from now; cancel a wind-down in progress.
      this.resetSession();
    }
  }

  private sceneOptions(): SceneOptions {
    return sceneOptionsFor(this.settings, this.systemReduce, this.fontFamily);
  }

  private watchReducedMotion(): void {
    const q = this.reduceQuery;
    if (!q) return;
    const onChange = (): void => {
      this.systemReduce = !!q.matches;
      if (this.settings.motion === 'system') this.scene.setOptions(this.sceneOptions());
    };
    if (typeof q.addEventListener === 'function') {
      q.addEventListener('change', onChange);
      this.unsubscribers.push(() => q.removeEventListener?.('change', onChange));
    } else if (typeof q.addListener === 'function') {
      q.addListener(onChange);
      this.unsubscribers.push(() => q.removeListener?.(onChange));
    }
  }

  private worldFor(id: WorldId): World {
    return this.worlds[id] ?? this.worlds.space ?? WORLDS.space;
  }

  private setWorld(id: WorldId): void {
    const world = this.worldFor(id);
    if (world === this.world) return;
    this.world = world;
    this.content.world = world;
    this.scene.setWorld(world);
    this.audio.setTimbre(world.timbre);
    this.audio.setRoot(world.rootMidi);
    this.rotateMs = 0;
    this.hoverColor = null;
  }

  // -------------------------------------------------------------------------
  // Lockdown, panel, overlays
  // -------------------------------------------------------------------------

  private lockStatus(): LockStatus {
    try {
      return this.lockdown.status();
    } catch {
      return { fullscreen: false, keyboardLocked: false, wakeLock: false, installed: false };
    }
  }

  /** Requests fullscreen + locks. Call synchronously inside a user gesture when there is one. */
  private enterLockdown(reason: EnterReason, showResumeOnFail: boolean): void {
    const token = ++this.enterToken;
    let request: Promise<LockStatus>;
    try {
      request = this.lockdown.enter({ lockKeyboard: this.settings.lockKeyboard });
    } catch {
      request = Promise.resolve(this.lockStatus());
    }
    request.then(
      (status) => this.afterEnter(token, reason, status, showResumeOnFail),
      () => this.afterEnter(token, reason, this.lockStatus(), showResumeOnFail),
    );
  }

  private afterEnter(token: number, reason: EnterReason, status: LockStatus, showResumeOnFail: boolean): void {
    if (this.state === 'idle') {
      // Stopped while the request was pending: don't leave the start screen in fullscreen.
      if (status.fullscreen) this.exitLockdown();
      return;
    }
    if (token !== this.enterToken) return; // superseded by a newer request
    if (status.fullscreen) this.fullscreenGranted = true;
    if (reason === 'start' || reason === 'relock') this.toastLockStatus(status);
    if (!status.fullscreen && showResumeOnFail && this.fullscreenGranted && this.state === 'playing' && !this.panel.isOpen) {
      this.showResume();
    }
  }

  private exitLockdown(): void {
    try {
      this.lockdown.exit().catch(noop);
    } catch {
      // Nothing to undo.
    }
  }

  /** Tells the grown-up how to get out, in terms of what the browser actually granted. */
  private toastLockStatus(status: LockStatus): void {
    const word = this.settings.secretWord;
    let message: string;
    if (status.keyboardLocked) message = `🔒 Keyboard locked — hold Esc to exit · type “${word}” for grown-up controls`;
    else if (status.fullscreen) message = `Fullscreen — type “${word}” for grown-up controls`;
    else message = `Type “${word}” or hold the top-left corner for grown-up controls`;
    this.overlays.toast(message);
  }

  private onLockChange(status: LockStatus): void {
    if (status.fullscreen) {
      if (this.state !== 'idle') {
        this.fullscreenGranted = true;
        this.overlays.hideResume();
      }
      return;
    }
    if (this.state === 'idle' || !this.fullscreenGranted) return;
    // Fullscreen lost mid-play (a held Escape, an OS gesture…). With the panel open
    // or on the All-done screen, the grown-up's resume re-requests it instead.
    if (this.state === 'playing' && !this.panel.isOpen) this.showResume();
  }

  private showResume(): void {
    this.overlays.showResume(() => {
      // Runs inside the overlay's click/keydown: a user gesture.
      this.unlockAudio();
      this.enterLockdown('resume', false);
      this.markInput(this.now());
    });
  }

  /** Re-request fullscreen if it was granted this session and has since been lost. */
  private reenterIfLost(showResumeOnFail: boolean): void {
    if (this.fullscreenGranted && !this.lockStatus().fullscreen) this.enterLockdown('resume', showResumeOnFail);
  }

  private openPanel(): void {
    if (this.panel.isOpen) return;
    this.speaker.cancel();
    if (this.state !== 'idle') {
      this.disableInputs();
      this.overlays.hideResume(); // the panel's resume re-requests fullscreen
    }
    this.panel.open();
  }

  /** "Keep playing" (or Escape / close) in the panel. Usually runs inside a click. */
  private resumeFromPanel(): void {
    this.panel.close();
    if (this.state === 'idle') return; // opened from the start screen: stay there
    if (this.state === 'alldone') {
      this.resumeFromAllDone();
      return;
    }
    this.enableInputs();
    this.markInput(this.now());
    this.unlockAudio();
    // Escape is not a user activation, so this may fail: then show the resume screen.
    this.reenterIfLost(true);
  }

  private relock(): void {
    if (this.state === 'idle') {
      this.overlays.toast('Fullscreen and locks start when play starts.');
      return;
    }
    this.enterLockdown('relock', false);
  }

  private testSound(): void {
    this.unlockAudio();
    const root = this.world.rootMidi;
    this.audio.chord([pentatonic(root, 0), pentatonic(root, 2), pentatonic(root, 4)], { velocity: 0.7 });
    const name = this.settings.childName;
    this.speaker.say(name ? `Hi, ${name}!` : 'Hello!', 'high');
  }

  private enableInputs(): void {
    this.keyboard.setEnabled(true);
    this.pointer.setEnabled(true);
  }

  private disableInputs(): void {
    this.keyboard.setEnabled(false);
    // Disabling drops active pointers without onRelease: end their trails here.
    this.pointer.setEnabled(false);
    this.endAllTrails();
    this.overlays.setCornerProgress(0);
  }

  private onVisibilityChange(): void {
    this.lastTick = null;
    if (!this.visibility.isVisible()) {
      this.speaker.cancel();
      this.audio.fadeTo(0, 0.15);
      this.endAllTrails();
      return;
    }
    if (this.state === 'alldone') this.audio.fadeTo(WIND_DOWN_LEVEL, 0.4);
    else if (this.windDownAt >= 0) {
      const remaining = Math.max(0.4, (WIND_DOWN_MS - (this.sessionMs - this.windDownAt)) / 1000);
      this.audio.fadeTo(WIND_DOWN_LEVEL, remaining);
    } else this.audio.fadeTo(1, 0.4);
  }

  // -------------------------------------------------------------------------
  // Session timer
  // -------------------------------------------------------------------------

  /** Session timer back to zero: no wind-down, normal colours, full volume. */
  private resetSession(): void {
    const wasQuiet = this.windDownAt >= 0 || this.state === 'alldone';
    this.sessionMs = 0;
    this.windDownAt = -1;
    this.scene.setCalm(0);
    this.audio.fadeTo(1, wasQuiet ? 1 : 0.3);
  }

  private beginWindDown(): void {
    this.windDownAt = this.sessionMs;
    this.audio.fadeTo(WIND_DOWN_LEVEL, WIND_DOWN_MS / 1000);
  }

  private finishSession(): void {
    this.state = 'alldone';
    this.scene.setCalm(1);
    this.speaker.cancel();
    // Pointer off; the keyboard stays on so the secret word still opens the panel
    // (onKey / onSmash ignore everything else in this state).
    this.pointer.setEnabled(false);
    this.endAllTrails();
    this.overlays.setCornerProgress(0);
    this.overlays.hideResume();
    this.overlays.showAllDone(() => this.resumeFromAllDone());
  }

  /** A grown-up resumed after "All done!" (the hold button, or the panel). */
  private resumeFromAllDone(): void {
    if (this.state !== 'alldone') return;
    this.resetSession(); // while still 'alldone', so the volume comes back gently
    this.state = 'playing';
    this.overlays.hideAllDone();
    this.enableInputs();
    this.markInput(this.now());
    this.unlockAudio();
    // The hold button completes 3 s after pointerdown, still inside the browser's
    // activation window in Chromium/Firefox; elsewhere the resume screen takes over.
    this.reenterIfLost(true);
  }

  private spawnIdleFriend(): void {
    const friends = this.world.friends;
    if (friends.length === 0) return;
    const { width, height } = this.size();
    const spot = this.randomSpot(width, height);
    const emoji = friends[this.index(friends.length)];
    this.scene.spawnEmoji({ emoji, x: spot.x, y: spot.y, scale: 0.6 });
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  private readonly onKey = (press: KeyPress): void => {
    if (this.state !== 'playing' || this.panel.isOpen) return;
    const now = this.now();
    this.markInput(now);
    if (press.repeat) {
      this.onRepeat(press, now);
      return;
    }
    this.unlockAudio();

    const content = contentForKey(press, this.content);
    this.countKey(press, content);
    const isEnter = content.kind === 'special' && content.effect === 'sweep';
    const speak = this.speechFor(content.speak, now, isEnter);
    this.lastKeyAt = now;

    if (content.kind === 'special') {
      this.playSpecial(content.effect);
      this.say(speak);
      return;
    }

    const spot = this.spotFor(press.position);
    const { x, y } = spot;
    const root = this.world.rootMidi;
    switch (content.kind) {
      case 'letter': {
        const s = this.settings;
        const word = content.word;
        this.scene.spawnGlyph({
          text: content.display,
          x,
          y,
          color: content.color,
          emoji: s.pictures && word ? word.emoji : null,
          caption: s.speech === 'word' && word ? word.word : null,
        });
        this.scene.burst(x, y, content.color, 1);
        const midi = this.keyMap.note(press.code, root);
        this.playNote(midi, x, 0.8, 'pop');
        this.remember('glyph', content.display, midi, null, content.speak);
        this.rememberSpot(press.code, x, y, content.color);
        break;
      }
      case 'digit': {
        this.scene.spawnGlyph({ text: content.display, x, y, color: content.color, emoji: content.countEmoji, count: content.digit });
        this.scene.burst(x, y, content.color, 1);
        const midi = this.keyMap.note(press.code, root);
        this.playNote(midi, x, 0.8, 'pop');
        this.remember('glyph', content.display, midi, null, content.speak);
        this.rememberSpot(press.code, x, y, content.color);
        break;
      }
      case 'shape': {
        this.scene.spawnShape({ shape: content.shape, x, y, color: content.color });
        this.scene.burst(x, y, content.color, 1);
        const midi = this.keyMap.note(press.code, root);
        this.playNote(midi, x, 0.8, 'pop');
        this.remember('shape', content.shape, midi, null, content.speak);
        this.rememberSpot(press.code, x, y, content.color);
        break;
      }
      case 'emoji': {
        const color = this.randomColor();
        this.scene.spawnEmoji({ emoji: content.emoji, x, y });
        this.scene.burst(x, y, color, 0.6);
        this.audio.effect('boing', { velocity: 0.7, pan: this.panFor(x) });
        this.remember('emoji', content.emoji, null, 'boing', content.speak);
        this.rememberSpot(press.code, x, y, color);
        break;
      }
    }
    this.say(speak);
  };

  /** Held key: a small sparkle and a quiet twinkle at the key's spot, ≤ 8/s. No glyph, no speech. */
  private onRepeat(press: KeyPress, now: number): void {
    if (now - this.lastRepeatAt < REPEAT_INTERVAL_MS) return;
    this.lastRepeatAt = now;
    const known = this.keySpots.get(press.code);
    let x: number;
    let y: number;
    let color: NamedColor;
    if (known) {
      x = known.x;
      y = known.y;
      color = known.color;
    } else {
      const spot = this.mapToSafe(press.position) ?? this.centre();
      x = spot.x;
      y = spot.y;
      color = this.randomColor();
    }
    this.scene.burst(x, y, color, 0.35);
    this.audio.effect('twinkle', { velocity: 0.35, pan: this.panFor(x) });
  }

  private readonly onSmash = (smash: SmashEvent): void => {
    if (this.state !== 'playing' || this.panel.isOpen) return;
    const now = this.now();
    this.markInput(now);
    this.unlockAudio();
    this.smashes++;

    const at = this.mapToSafe(smash.center) ?? this.centre();
    const pan = this.panFor(at.x);
    this.scene.special('fireworks', at);
    this.scene.burst(at.x, at.y, this.randomColor(), 1.5);
    if (this.settings.notes) {
      const root = this.world.rootMidi;
      const chord = [pentatonic(root, 0), pentatonic(root, 2), pentatonic(root, 4), pentatonic(root, 5), pentatonic(root, 7)];
      this.audio.chord(chord, { velocity: 0.75, spread: 0.07, pan });
    }
    this.audio.effect('sparkle', { velocity: 0.6, pan });
    // The first keys of a palm fire onKey before the smash is known; 'high' cuts
    // their speech off, and the quiet window keeps stragglers from talking over it.
    this.speaker.say(cheer(this.rng), 'high');
    this.quietUntil = now + SMASH_QUIET_MS;
    this.lastKeyAt = now;
  };

  private readonly onSecret = (): void => {
    if (this.state === 'idle') return;
    this.openPanel();
  };

  private playSpecial(effect: SpecialEffect): void {
    this.scene.special(effect);
    const root = this.world.rootMidi;
    switch (effect) {
      case 'rainbow':
        if (this.settings.notes) {
          const scale: number[] = [];
          for (let step = 0; step <= 5; step++) scale.push(pentatonic(root, step));
          this.audio.chord(scale, { velocity: 0.55, spread: 0.08 });
        }
        this.audio.effect('sparkle', { velocity: 0.6 });
        break;
      case 'sweep':
        this.audio.effect('whoosh', { velocity: 0.8 });
        break;
      case 'pop-all':
        this.audio.effect('pop', { velocity: 0.8 });
        break;
      case 'fireworks':
        this.audio.effect('tada', { velocity: 0.7 });
        break;
      case 'comet-left':
        this.audio.effect('swoosh', { velocity: 0.7, pan: -0.6 });
        break;
      case 'comet-right':
        this.audio.effect('swoosh', { velocity: 0.7, pan: 0.6 });
        break;
      case 'comet-up':
      case 'comet-down':
        this.audio.effect('swoosh', { velocity: 0.7 });
        break;
    }
  }

  /**
   * What to say for a key press: nothing while mashing, sometimes the child's
   * name instead (every ~40 presses, or on Enter), otherwise the content's line.
   */
  private speechFor(text: string | null, now: number, isEnter: boolean): string | null {
    const mashing = now - this.lastKeyAt < MASH_GAP_MS || now < this.quietUntil;
    this.keysSinceCheer++;
    const name = this.settings.childName;
    if (name && !mashing && (isEnter || this.keysSinceCheer >= this.nextCheerAt)) {
      this.keysSinceCheer = 0;
      this.nextCheerAt = this.cheerInterval();
      return `Yay, ${name}!`;
    }
    return mashing ? null : text;
  }

  private cheerInterval(): number {
    return NAME_CHEER_MIN + Math.floor(this.rng() * NAME_CHEER_SPREAD);
  }

  private countKey(press: KeyPress, content: KeyContent): void {
    this.keys++;
    let label: string;
    if (content.kind === 'letter') label = content.letter;
    else if (content.kind === 'digit') label = content.display;
    else {
      const key = press.key;
      if (key === ' ') label = 'Space';
      else if (ARROW_LABELS[key]) label = ARROW_LABELS[key];
      else if (key.length === 1) label = key.toUpperCase();
      else label = key || press.code || '?';
    }
    const count = this.labels.get(label);
    if (count !== undefined) this.labels.set(label, count + 1);
    else if (this.labels.size < MAX_LABELS) this.labels.set(label, 1);
  }

  // -------------------------------------------------------------------------
  // Pointer
  // -------------------------------------------------------------------------

  private readonly onTap = (x: number, y: number, pointerId: number): void => {
    if (this.state !== 'playing' || this.panel.isOpen) return;
    this.markInput(this.now());
    this.unlockAudio();
    this.taps++;
    this.trackDrag(pointerId);

    const hit = this.scene.poke(x, y);
    if (hit) {
      this.replay(hit, x);
      return;
    }

    const content = contentForTap(this.content);
    const midi = this.noteForX(x);
    if (content.kind === 'shape') {
      this.scene.spawnShape({ shape: content.shape, x, y, color: content.color });
      this.scene.ripple(x, y, content.color);
      const name = this.settings.speech === 'off' ? null : `${content.color.name} ${shapeLabel(content.shape)}`;
      this.remember('shape', content.shape, midi, null, content.speak ?? name);
      this.say(content.speak);
    } else if (content.kind === 'emoji') {
      this.scene.spawnEmoji({ emoji: content.emoji, x, y });
      this.scene.ripple(x, y, this.randomColor());
      this.remember('emoji', content.emoji, midi, null, null);
    } else {
      this.scene.ripple(x, y, this.randomColor());
    }
    this.playNote(midi, x, 0.7, 'bubble');
  };

  /** A poke hit something: replay that object's sound (and word). */
  private replay(hit: PokeResult, x: number): void {
    const mem = this.memory.get(`${hit.kind}:${hit.value}`);
    if (mem) {
      if (mem.midi !== null) this.playNote(mem.midi, x, 0.75, 'pop');
      else if (mem.effect) this.audio.effect(mem.effect, { velocity: 0.7, pan: this.panFor(x) });
      this.say(mem.speak);
      return;
    }
    // Not remembered (idle friends, evicted): something sensible for its kind.
    if (hit.kind === 'emoji') this.audio.effect('boing', { velocity: 0.6, pan: this.panFor(x) });
    else this.playNote(this.noteForX(x), x, 0.75, 'pop');
  }

  private readonly onDrag = (x: number, y: number, dx: number, dy: number, pointerId: number): void => {
    if (this.state !== 'playing' || this.panel.isOpen) return;
    this.markInput(this.now());
    const drag = this.trackDrag(pointerId);
    if (this.settings.trails) this.scene.trail(x, y, drag.color, pointerId);
    const moved = Math.hypot(dx, dy);
    if (Number.isFinite(moved)) drag.dist += moved;
    if (drag.dist >= DRAG_NOTE_PX) {
      drag.dist %= DRAG_NOTE_PX; // one note per event, however far it jumped
      this.playNote(this.noteForY(y), x, 0.5, 'bubble');
      this.scene.burst(x, y, drag.color, 0.25);
    }
  };

  private readonly onRelease = (_x: number, _y: number, pointerId: number): void => {
    this.scene.endTrail(pointerId);
    this.drags.delete(pointerId);
  };

  /** Mouse moving with no button: a silent trail (when trails are on). */
  private readonly onHover = (x: number, y: number): void => {
    if (this.state !== 'playing' || this.panel.isOpen) return;
    const now = this.now();
    this.markInput(now);
    if (!this.settings.trails) return;
    if (!this.hoverColor || now - this.lastHoverAt > HOVER_STROKE_GAP_MS) this.hoverColor = this.nextTrailColor();
    this.lastHoverAt = now;
    this.scene.trail(x, y, this.hoverColor, HOVER_TRAIL_ID);
  };

  private readonly onCornerHold = (): void => {
    if (this.state === 'idle') return;
    this.openPanel();
  };

  private readonly onCornerProgress = (progress: number): void => {
    this.overlays.setCornerProgress(progress);
  };

  private trackDrag(pointerId: number): DragState {
    let drag = this.drags.get(pointerId);
    if (!drag) {
      if (this.drags.size >= MAX_DRAGS) {
        const oldest = this.drags.keys().next();
        if (!oldest.done) {
          this.scene.endTrail(oldest.value);
          this.drags.delete(oldest.value);
        }
      }
      drag = { dist: 0, color: this.nextTrailColor() };
      this.drags.set(pointerId, drag);
    }
    return drag;
  }

  private endAllTrails(): void {
    for (const id of this.drags.keys()) this.scene.endTrail(id);
    this.drags.clear();
    this.scene.endTrail(HOVER_TRAIL_ID);
    this.hoverColor = null;
  }

  // -------------------------------------------------------------------------
  // Placement, sound and memory helpers
  // -------------------------------------------------------------------------

  private size(): { width: number; height: number } {
    const v = this.viewport();
    return { width: v.width > 0 ? v.width : 1, height: v.height > 0 ? v.height : 1 };
  }

  private centre(): Spot {
    const { width, height } = this.size();
    return { x: width / 2, y: height / 2 };
  }

  /** A physical key position mapped into the safe area (no jitter), or null. */
  private mapToSafe(pos: KeyPosition | null): Spot | null {
    if (!pos) return null;
    const { width, height } = this.size();
    const span = 1 - 2 * SAFE_MARGIN;
    return { x: width * (SAFE_MARGIN + span * pos.x), y: height * (SAFE_MARGIN + span * pos.y) };
  }

  /**
   * Where a key's object appears: its keyboard position (spatial keys) with a
   * little jitter, otherwise a random spot away from the last few.
   */
  private spotFor(pos: KeyPosition | null): Spot {
    const { width, height } = this.size();
    let spot: Spot;
    const mapped = this.settings.spatialKeys ? this.mapToSafe(pos) : null;
    if (mapped) {
      spot = {
        x: mapped.x + (this.rng() * 2 - 1) * JITTER * width,
        y: mapped.y + (this.rng() * 2 - 1) * JITTER * height,
      };
    } else {
      spot = this.randomSpot(width, height);
    }
    this.recentX[this.recentNext] = spot.x;
    this.recentY[this.recentNext] = spot.y;
    this.recentNext = (this.recentNext + 1) % RECENT_SPOTS;
    if (this.recentCount < RECENT_SPOTS) this.recentCount++;
    return spot;
  }

  private randomSpot(width: number, height: number): Spot {
    const span = 1 - 2 * SAFE_MARGIN;
    const minDistance = 0.2 * Math.min(width, height);
    let bestX = width / 2;
    let bestY = height / 2;
    let bestDistance = -1;
    for (let i = 0; i < SPOT_TRIES; i++) {
      const x = width * (SAFE_MARGIN + span * this.rng());
      const y = height * (SAFE_MARGIN + span * this.rng());
      let nearest = Number.POSITIVE_INFINITY;
      for (let j = 0; j < this.recentCount; j++) {
        const d = Math.hypot(x - this.recentX[j], y - this.recentY[j]);
        if (d < nearest) nearest = d;
      }
      if (nearest >= minDistance) return { x, y };
      if (nearest > bestDistance) {
        bestDistance = nearest;
        bestX = x;
        bestY = y;
      }
    }
    return { x: bestX, y: bestY };
  }

  private rememberSpot(code: string, x: number, y: number, color: NamedColor): void {
    if (!this.keySpots.has(code) && this.keySpots.size >= MAX_KEY_SPOTS) {
      const oldest = this.keySpots.keys().next();
      if (!oldest.done) this.keySpots.delete(oldest.value);
    }
    this.keySpots.set(code, { x, y, color });
  }

  private remember(kind: PokeResult['kind'], value: string, midi: number | null, effect: SoundEffect | null, speak: string | null): void {
    const key = `${kind}:${value}`;
    this.memory.delete(key); // re-insert as the newest
    this.memory.set(key, { midi, effect, speak });
    if (this.memory.size > MEMORY_SIZE) {
      const oldest = this.memory.keys().next();
      if (!oldest.done) this.memory.delete(oldest.value);
    }
  }

  private panFor(x: number): number {
    const { width } = this.size();
    const pan = (x / width) * 2 - 1;
    return Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0;
  }

  /** Taps: left → low, right → high. */
  private noteForX(x: number): number {
    const { width } = this.size();
    const t = Math.max(0, Math.min(1, x / width));
    return pentatonic(this.world.rootMidi, Math.round(t * 10) - 2);
  }

  /** Drags: higher on screen → higher note. */
  private noteForY(y: number): number {
    const { height } = this.size();
    const t = Math.max(0, Math.min(1, 1 - y / height));
    return pentatonic(this.world.rootMidi, Math.round(t * 12) - 3);
  }

  /** A musical note, or a soft effect when the parent turned notes off. */
  private playNote(midi: number, x: number, velocity: number, fallback: SoundEffect): void {
    const pan = this.panFor(x);
    if (this.settings.notes) this.audio.note(midi, { velocity, pan });
    else this.audio.effect(fallback, { velocity: velocity * 0.6, pan });
  }

  private say(text: string | null): void {
    if (text) this.speaker.say(text);
  }

  private unlockAudio(): void {
    try {
      this.audio.unlock().catch(noop);
    } catch {
      // Audio is optional.
    }
  }

  private markInput(now: number): void {
    this.nextIdleAt = now + IDLE_AFTER_MS;
  }

  private index(length: number): number {
    const i = Math.floor(this.rng() * length);
    return i >= 0 && i < length ? i : 0;
  }

  private randomColor(): NamedColor {
    const palette = this.world.palette;
    return palette.length > 0 ? palette[this.index(palette.length)] : FALLBACK_COLOR;
  }

  private nextTrailColor(): NamedColor {
    const palette = this.world.palette;
    if (palette.length === 0) return FALLBACK_COLOR;
    this.trailColorIndex = (this.trailColorIndex + 1) % palette.length;
    return palette[this.trailColorIndex];
  }
}
