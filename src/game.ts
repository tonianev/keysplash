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
import { LessonContent, praise, rainbowColors } from './content';
import { describeKeyLocation, pentatonic } from './keymap';
import { TIMING } from './types';
import type {
  AudioEngine,
  CardSpec,
  Challenge,
  ContentContext,
  KeyContent,
  KeyMap,
  ModeOutcome,
  KeyPosition,
  KeyPress,
  KeyboardHandlers,
  KeyboardInput,
  LearningGame,
  LockStatus,
  Lockdown,
  NamedColor,
  Overlays,
  ParentPanel,
  ParentPanelDeps,
  PokeResult,
  PointerHandlers,
  PointerInput,
  ProgressStore,
  PromptBar,
  Scene,
  SceneOptions,
  SessionStats,
  Settings,
  SettingsStore,
  SmashEvent,
  SoundEffect,
  Speaker,
  StartScreen,
  StartScreenDeps,
  World,
  WorldId,
} from './types';
import { WORLDS, WORLD_ORDER, nextWorld } from './worlds';

/** Card font: Andika (literacy letterforms) is bundled via @fontsource (no network). */
export const FONT_FAMILY = '"Andika", system-ui, sans-serif';

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
/** After a correct answer, the next prompt appears after at least this long. */
const NEXT_PROMPT_MS = 1400;
/** In a game, repeat the prompt once after this long without input. */
const IDLE_PROMPT_MS = 25_000;
/** Spoken lines take roughly this long per character (for scheduling). */
const SPEECH_MS_PER_CHAR = 65;
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
/** Pointer drag states kept at once (the pointer module tracks ≤ 16). */
const MAX_DRAGS = 16;
const HOVER_TRAIL_ID = -1;
/** A hover pause longer than this starts a new trail colour. */
const HOVER_STROKE_GAP_MS = 400;

const FALLBACK_COLOR: NamedColor = { name: 'blue', hex: '#4A86D8', container: '#DFEAFB', ink: '#1D4F99' };
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
    layout: settings.layout,
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
  createPromptBar(): PromptBar;
  progress: ProgressStore;
  games: LearningGame;
  lessons?: LessonContent;
  /** Called with true on dark worlds so the DOM chrome can switch theme. */
  setTheme?(dark: boolean): void;
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

/** What a card sounded like, so poking it replays the lesson. */
interface Memory {
  midi: number | null;
  speak: string | null;
  /** Digit cards replay their counting. */
  count: string[] | null;
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
  private readonly promptBar: PromptBar;
  private readonly progress: ProgressStore;
  private readonly games: LearningGame;
  private readonly lessons: LessonContent;
  private readonly setTheme: (dark: boolean) => void;
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
  private quietUntil = Number.NEGATIVE_INFINITY;
  private keysSinceCheer = 0;
  private nextCheerAt = NAME_CHEER_MIN;
  /** Pending timers for counting ticks, rainbow notes and the next prompt (bounded). */
  private readonly lessonTimers: Array<ReturnType<typeof setTimeout>> = [];
  private nextPromptTimer: ReturnType<typeof setTimeout> | null = null;
  private rainbowUntil = Number.NEGATIVE_INFINITY;
  /** The location hint has been spoken for the current challenge. */
  private hintSpoken = false;
  /**
   * Between a found answer and the next prompt appearing: keys are free play,
   * not judged against a target the child hasn't been shown yet.
   */
  private awaitingNext = false;
  /** The next prompt came due while the page was hidden: show it on return. */
  private promptOnVisible = false;
  /** Which physical key types each letter on this keyboard (AZERTY/QWERTZ aware). ≤ 26 entries. */
  private readonly letterCodes = new Map<string, string>();
  /** Clock time to repeat the game prompt when idle, or Infinity. */
  private idlePromptAt = Number.POSITIVE_INFINITY;
  private readonly recentX = new Float64Array(RECENT_SPOTS);
  private readonly recentY = new Float64Array(RECENT_SPOTS);
  private recentNext = 0;
  private recentCount = 0;
  private readonly memory = new Map<number, Memory>();

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
  private found = 0;
  private spelled = 0;
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
    this.progress = deps.progress;
    this.games = deps.games;
    this.lessons = deps.lessons ?? new LessonContent();
    this.setTheme = deps.setTheme ?? noop;

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
    this.promptBar = deps.createPromptBar();
    this.panel = deps.createParentPanel({
      store: this.store,
      progress: this.progress,
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
        resetProgress: () => this.progress.reset(),
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
    const greeting = name ? `Hi, ${name}!` : "Let's play!";
    const challenge = this.games.setMode(this.settings.mode, this.content);
    if (challenge) {
      this.showChallenge(challenge, false);
      // Greeting first, then the first prompt.
      this.speaker.sequence([greeting], 1300, challenge.prompt);
    } else {
      this.promptBar.hide();
      this.scene.setTopInset(0);
      this.speaker.say(greeting, 'high');
    }
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
    this.clearLessonTimers();
    this.promptBar.hide();
    this.scene.setTopInset(0);
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

    if (s.mode === 'explore') {
      if (now >= this.nextIdleAt) {
        this.spawnIdleFriend();
        this.nextIdleAt = now + IDLE_EVERY_MS + (this.rng() * 2 - 1) * IDLE_SPREAD_MS;
      }
    } else if (now >= this.idlePromptAt) {
      this.idlePromptAt = Number.POSITIVE_INFINITY; // once per quiet spell
      const challenge = this.games.current();
      if (challenge) this.speaker.say(challenge.prompt, 'low');
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
      found: this.found,
      spelled: this.spelled,
      topKeys: top.slice(0, 5),
      playMs: Math.round(this.playMs),
    };
  }

  resetStats(): void {
    this.startedAt = this.wallClock();
    this.keys = 0;
    this.taps = 0;
    this.smashes = 0;
    this.found = 0;
    this.spelled = 0;
    this.playMs = 0;
    this.labels.clear();
  }

  /** Removes every subscription and listener (tests / hot reload). */
  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.keyboard.detach();
    this.pointer.detach();
    this.clearLessonTimers();
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
    this.setTheme(this.world.dark);
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
      next.faces !== prev.faces ||
      next.layout !== prev.layout
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
    if (next.mode !== prev.mode || (next.letterCase !== prev.letterCase && next.mode !== 'explore')) this.applyMode();
    if (next.sessionMinutes !== prev.sessionMinutes && this.state === 'playing') {
      // A new limit counts from now; cancel a wind-down in progress.
      this.resetSession();
    }
  }

  /** Switch learning activity: start its first challenge (or hide the prompt for Explore). */
  private applyMode(): void {
    this.clearLessonTimers();
    const challenge = this.games.setMode(this.settings.mode, this.content);
    if (this.state === 'idle') return;
    if (challenge) {
      this.showChallenge(challenge, !this.panel.isOpen);
    } else {
      this.promptBar.hide();
      this.scene.setTopInset(0);
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
    return this.worlds[id] ?? this.worlds.paper ?? WORLDS.paper;
  }

  private setWorld(id: WorldId): void {
    const world = this.worldFor(id);
    if (world === this.world) return;
    this.world = world;
    this.content.world = world;
    this.scene.setWorld(world);
    this.audio.setTimbre(world.timbre);
    this.audio.setRoot(world.rootMidi);
    this.setTheme(world.dark);
    this.rotateMs = 0;
    this.hoverColor = null;
    // Keep the prompt's colour name but take the new world's tones.
    const challenge = this.games.current();
    if (challenge && this.state !== 'idle' && this.promptBar.isVisible) this.promptBar.show(this.retone(challenge));
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
    this.clearLessonTimers();
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
    // A game prompt may have been cut off by the panel: show and say it again.
    const challenge = this.games.current();
    if (challenge && this.settings.mode !== 'explore') this.showChallenge(challenge, true);
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
    if (this.promptOnVisible && this.state === 'playing' && !this.panel.isOpen) {
      const challenge = this.games.current();
      if (challenge) this.showChallenge(challenge, true);
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
    this.clearLessonTimers();
    this.promptBar.hide();
    this.scene.setTopInset(0);
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
    const challenge = this.games.current();
    if (challenge && this.settings.mode !== 'explore') this.showChallenge(challenge, true);
    // The hold button completes 3 s after pointerdown, still inside the browser's
    // activation window in Chromium/Firefox; elsewhere the resume screen takes over.
    this.reenterIfLost(true);
  }

  private spawnIdleFriend(): void {
    const friends = this.world.friends;
    if (friends.length === 0) return;
    const { width, height } = this.size();
    const fromLeft = this.rng() < 0.5;
    const emoji = friends[this.index(friends.length)];
    // Starts just off-screen so the scene drifts it slowly across.
    this.scene.spawnEmoji({ emoji, x: fromLeft ? -30 : width + 30, y: height * (0.2 + this.rng() * 0.5), scale: 0.7 });
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  private readonly onKey = (press: KeyPress): void => {
    if (this.state !== 'playing' || this.panel.isOpen) return;
    const now = this.now();
    this.markInput(now);
    // Holding a key teaches nothing new: stay calm.
    if (press.repeat) return;
    this.unlockAudio();

    if (/^[a-z]$/i.test(press.key) && press.code) this.letterCodes.set(press.key.toUpperCase(), press.code);
    const content = this.lessons.forKey(press, this.content);
    this.countKey(press, content);
    if (content.kind === 'letter') this.progress.markSeen(content.letter);
    else if (content.kind === 'digit') this.progress.markSeen(String(content.digit));

    const mashing = now - this.lastKeyAt < MASH_GAP_MS || now < this.quietUntil;
    this.lastKeyAt = now;

    // Learning games judge deliberate presses only — mashing is always free play.
    if (!mashing && this.settings.mode !== 'explore' && !this.awaitingNext) {
      const outcome = this.games.judge(content, this.content);
      if (outcome.result === 'correct') {
        this.onCorrect(content, outcome, press);
        return;
      }
      if (outcome.result === 'wrong') {
        this.onWrong(content, outcome, press);
        return;
      }
    }
    this.freePlay(content, press, mashing);
  };

  /** Explore (and non-game keys in games): one card, one soft note, one clear line. */
  private freePlay(content: KeyContent, press: KeyPress, mashing: boolean): void {
    const isClear = content.kind === 'special' && content.effect === 'clear';
    const speak = this.speechFor(content.speak, mashing, isClear);

    if (content.kind === 'special') {
      if (content.effect === 'rainbow') this.playRainbow();
      else if (content.effect === 'clear') {
        this.clearLessonTimers(false);
        this.scene.special('clear');
        this.audio.effect('swipe', { velocity: 0.6 });
        this.say(speak);
      }
      return;
    }

    const at = this.settings.layout === 'keyboard' ? this.spotFor(press.position) : null;
    const card = this.cardFor(content, mashing ? 'small' : 'normal', at);
    const id = this.scene.showCard(card);
    const x = at?.x ?? this.size().width / 2;
    const midi = this.keyMap.note(press.code, this.world.rootMidi);
    this.playNote(midi, x, mashing ? 0.3 : 0.5, 'tap');

    if (content.kind === 'digit') {
      this.remember(id, midi, content.speak, content.countWords);
      // In a game the prompt is the line that matters: count with ticks, not speech.
      if (!mashing) this.count(this.settings.mode === 'explore' ? content.countWords : [], this.settings.mode === 'explore' ? content.speak : null, content.countWords.length);
      return;
    }
    this.remember(id, midi, content.speak, null);
    this.say(speak);
  }

  /** The flashcard for what a key teaches. */
  private cardFor(content: KeyContent, emphasis: 'normal' | 'small', at: Spot | null): CardSpec {
    switch (content.kind) {
      case 'letter': {
        const word = content.word;
        const i = word.at ?? 0;
        return {
          kind: 'letter', text: content.display, picture: this.settings.pictures ? word.emoji : null,
          word: word.word, highlight: [i, i + 1], color: content.color, at, emphasis,
        };
      }
      case 'digit': {
        const label = String(content.digit);
        return {
          kind: 'digit', text: content.display, picture: content.countEmoji, count: content.digit,
          word: `${label} ${content.countNoun}`, highlight: [0, label.length], color: content.color, at, emphasis,
        };
      }
      case 'shape': {
        const name = content.color.name;
        return {
          kind: 'shape', shape: content.shape, word: `${name} ${content.label}`, highlight: [0, name.length],
          color: content.color, at, emphasis,
        };
      }
      case 'direction':
        return { kind: 'direction', direction: content.direction, word: content.direction, color: content.color, at, emphasis };
      case 'picture':
        return { kind: 'picture', picture: content.emoji, word: content.word, at, emphasis };
      default:
        return { kind: 'picture', picture: '⭐', word: null, at, emphasis };
    }
  }

  /** Count out loud in step with the pictures appearing on the digit card. */
  private count(words: string[], then: string | null, ticks = words.length): void {
    this.clearLessonTimers(false);
    if (words.length > 0) this.speaker.sequence(words, TIMING.countStepMs, then);
    else this.say(then);
    for (let i = 0; i < ticks; i++) {
      this.later(i * TIMING.countStepMs, () => this.audio.effect('count', { velocity: 0.35, step: i }));
    }
  }

  /** Space: paint the rainbow band by band while naming each colour. */
  private playRainbow(): void {
    const now = this.now();
    if (now < this.rainbowUntil) return; // let the current rainbow finish
    const colors = rainbowColors(this.world);
    this.rainbowUntil = now + colors.length * TIMING.rainbowBandMs + 1500;
    this.clearLessonTimers(false);
    this.scene.special('rainbow', { colors });
    // Name the colours in free play; in a game, don't talk over the prompt.
    const quiet = this.settings.speech === 'off' || this.settings.mode !== 'explore' || now < this.quietUntil;
    if (!quiet) this.speaker.sequence(colors.map((c) => c.name), TIMING.rainbowBandMs);
    const root = this.world.rootMidi;
    for (let i = 0; i < colors.length; i++) {
      this.later(i * TIMING.rainbowBandMs, () => {
        if (this.settings.notes) this.audio.note(pentatonic(root, i), { velocity: 0.35 });
      });
    }
  }

  // -------------------------------------------------------------------------
  // Learning games
  // -------------------------------------------------------------------------

  /** Show a challenge in the prompt bar (and optionally say its prompt). */
  private showChallenge(challenge: Challenge, speak: boolean): void {
    this.hintSpoken = false;
    this.awaitingNext = false;
    this.promptOnVisible = false;
    this.promptBar.show(this.retone(challenge));
    this.syncInset();
    this.idlePromptAt = this.now() + IDLE_PROMPT_MS;
    if (speak) this.speaker.say(challenge.prompt, 'high');
  }

  /** Tell the scene how much of the top the prompt (and its hint keyboard) covers. */
  private syncInset(): void {
    this.scene.setTopInset(this.promptBar.isVisible ? this.promptBar.reservedBottom() : 0);
  }

  /** The physical key a challenge wants next: learned from this keyboard, else US-QWERTY. */
  private targetCode(challenge: Challenge): string | null {
    if (challenge.kind === 'find-number') return `Digit${challenge.target}`;
    const letter = challenge.kind === 'find-letter' ? challenge.target : challenge.letters[challenge.index];
    if (!letter) return null;
    return this.letterCodes.get(letter) ?? `Key${letter}`;
  }

  /** A challenge made in another world keeps its colour name but takes this world's tones. */
  private retone(challenge: Challenge): Challenge {
    const color = this.world.palette.find((c) => c.name === challenge.color.name) ?? challenge.color;
    return color === challenge.color ? challenge : ({ ...challenge, color } as Challenge);
  }

  private onCorrect(content: KeyContent, outcome: Extract<ModeOutcome, { result: 'correct' }>, press: KeyPress): void {
    const at = this.settings.layout === 'keyboard' ? this.spotFor(press.position) : null;
    const id = this.scene.showCard(this.cardFor(content, 'normal', at));
    this.remember(id, this.keyMap.note(press.code, this.world.rootMidi), content.speak, null);
    this.hintSpoken = false;
    this.clearLessonTimers();
    this.speaker.say(outcome.say, 'high');

    const ch = outcome.challenge;
    // Fill the slot (spell) / clear the hint — also for the last letter of a word.
    this.promptBar.update(ch, 0, this.targetCode(ch));
    this.syncInset();
    if (!outcome.complete) {
      this.audio.effect('chime', { velocity: 0.45 });
      return;
    }

    this.audio.effect(ch.kind === 'spell' ? 'complete' : 'success', { velocity: 0.55 });
    this.scene.special('celebrate');
    this.promptBar.celebrate();
    if (ch.kind === 'spell') {
      this.progress.markSpelled(ch.word.word);
      this.spelled++;
    } else {
      this.progress.markFound(String(ch.target));
      this.found++;
    }
    const next = outcome.next;
    if (!next) return;
    this.awaitingNext = true;
    const delay = Math.max(NEXT_PROMPT_MS, outcome.say.length * SPEECH_MS_PER_CHAR);
    this.nextPromptTimer = setTimeout(() => {
      this.nextPromptTimer = null;
      if (this.state !== 'playing' || this.panel.isOpen) return; // resume shows it
      if (!this.visibility.isVisible()) {
        this.promptOnVisible = true;
        return;
      }
      this.showChallenge(next, true);
    }, delay);
  }

  private onWrong(content: KeyContent, outcome: Extract<ModeOutcome, { result: 'wrong' }>, press: KeyPress): void {
    // Still show what they pressed (small, on the shelf) — every key teaches something.
    this.scene.showCard(this.cardFor(content, 'small', this.settings.layout === 'keyboard' ? this.spotFor(press.position) : null));
    this.audio.effect('retry', { velocity: 0.35 });
    this.promptBar.update(outcome.challenge, outcome.hint, this.targetCode(outcome.challenge));
    this.syncInset();
    this.idlePromptAt = this.now() + IDLE_PROMPT_MS;
    let line = outcome.say;
    if (outcome.hint >= 2 && !this.hintSpoken) {
      const code = this.targetCode(outcome.challenge);
      if (code) {
        line = `${line ?? ''} ${describeKeyLocation(code)}`.trim();
        this.hintSpoken = true;
      }
    }
    if (line) this.speaker.say(line, 'high');
  }

  private readonly onSmash = (smash: SmashEvent): void => {
    if (this.state !== 'playing' || this.panel.isOpen) return;
    const now = this.now();
    this.markInput(now);
    this.unlockAudio();
    this.smashes++;
    void smash;
    // A palm smash is celebrated gently in every mode, never judged as wrong.
    this.scene.special('celebrate');
    if (this.settings.notes) {
      const root = this.world.rootMidi;
      this.audio.chord([pentatonic(root, 0), pentatonic(root, 2), pentatonic(root, 4)], { velocity: 0.4, spread: 0.09 });
    }
    // The first keys of a palm fire onKey before the smash is known; 'high' cuts them off.
    this.speaker.say(praise(this.rng, this.settings.childName), 'high');
    this.quietUntil = now + SMASH_QUIET_MS;
    this.lastKeyAt = now;
  };

  private readonly onSecret = (): void => {
    if (this.state === 'idle') return;
    this.openPanel();
  };

  /**
   * What to say for a key press: nothing while mashing, sometimes the child's
   * name instead (every ~40 presses, or on Enter), otherwise the content's line.
   */
  private speechFor(text: string | null, mashing: boolean, isClear: boolean): string | null {
    this.keysSinceCheer++;
    const name = this.settings.childName;
    if (name && !mashing && (isClear || this.keysSinceCheer >= this.nextCheerAt)) {
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

  private later(ms: number, fn: () => void): void {
    if (this.lessonTimers.length >= 32) return; // never more than a counting run + a rainbow
    this.lessonTimers.push(setTimeout(fn, ms));
  }

  /** Cancel counting ticks / rainbow notes (and, unless told otherwise, a pending next prompt). */
  private clearLessonTimers(includePrompt = true): void {
    for (const t of this.lessonTimers) clearTimeout(t);
    this.lessonTimers.length = 0;
    if (includePrompt && this.nextPromptTimer !== null) {
      clearTimeout(this.nextPromptTimer);
      this.nextPromptTimer = null;
    }
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

    const content = this.lessons.forTap(this.content);
    const midi = this.noteForX(x);
    if (content.kind === 'shape') {
      this.scene.spawnShape({ shape: content.shape, x, y, color: content.color });
      this.scene.ripple(x, y, content.color);
      this.say(content.speak);
    } else {
      this.scene.ripple(x, y, this.randomColor());
    }
    this.playNote(midi, x, 0.45, 'tap');
  };

  /** A poke hit something: replay its lesson (word, counting) or name the shape. */
  private replay(hit: PokeResult, x: number): void {
    const mem = hit.cardId !== null ? this.memory.get(hit.cardId) : undefined;
    if (mem) {
      if (mem.midi !== null) this.playNote(mem.midi, x, 0.5, 'tap');
      if (mem.count) this.count(mem.count, mem.speak);
      else if (mem.speak) this.speaker.say(mem.speak, 'high');
      return;
    }
    if (hit.kind === 'shape' && hit.color) {
      this.playNote(this.noteForX(x), x, 0.45, 'tap');
      if (this.settings.speech !== 'off') this.speaker.say(`${hit.color.name} ${hit.value}`);
      return;
    }
    this.audio.effect('pop', { velocity: 0.5, pan: this.panFor(x) });
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
      this.playNote(this.noteForY(y), x, 0.35, 'tap');
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
    const mapped = this.mapToSafe(pos);
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

  private remember(cardId: number, midi: number | null, speak: string | null, count: string[] | null): void {
    this.memory.delete(cardId); // re-insert as the newest
    this.memory.set(cardId, { midi, speak, count });
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
