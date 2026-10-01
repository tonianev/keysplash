/**
 * Shared contracts for KeySplash.
 *
 * Every module codes against these types. Modules export concrete classes that
 * `implements` the interfaces below, so the orchestrator (src/game.ts) only
 * depends on this file. Change this file only with care: every module reads it.
 *
 * Units: screen positions are CSS pixels relative to the top-left of the
 * viewport. Times are milliseconds from `performance.now()` unless a name says
 * otherwise. `dt` in update loops is seconds.
 */

// ---------------------------------------------------------------------------
// Worlds (themes)
// ---------------------------------------------------------------------------

export type WorldId = 'space' | 'ocean' | 'garden' | 'party' | 'bubbles' | 'dino' | 'night';

/** Instrument voice the audio engine uses for key notes in a world. */
export type Timbre = 'bell' | 'marimba' | 'pluck' | 'bubble' | 'kalimba' | 'soft';

/** Animated backdrop the renderer draws behind everything. */
export type BackgroundKind = 'starfield' | 'underwater' | 'meadow' | 'party' | 'bubbles' | 'jungle' | 'night';

/** Look of the small particles in bursts. */
export type ParticleStyle = 'spark' | 'bubble' | 'petal' | 'confetti' | 'star' | 'leaf' | 'firefly';

/** Colour names a toddler can learn. Used for speech ("Blue star!"). */
export type ColorName = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'white';

export interface NamedColor {
  name: ColorName;
  /** CSS colour, e.g. '#ff5a5f'. Must read clearly against the world's sky. */
  hex: string;
}

export interface WordEntry {
  /** Lower-case word, e.g. 'apple'. */
  word: string;
  /** A single emoji that pictures the word, e.g. '🍎'. Widely supported (Unicode ≤ 13). */
  emoji: string;
}

export interface World {
  id: WorldId;
  /** Parent-facing name, e.g. 'Outer Space'. */
  label: string;
  /** Icon for the world picker. */
  icon: string;
  background: BackgroundKind;
  /** Backdrop gradient, top colour then bottom colour. */
  sky: [string, string];
  /** True when the sky is dark (renderer picks outline/shadow colours from this). */
  dark: boolean;
  /** 5–7 bright colours used for glyphs, shapes and particles. */
  palette: NamedColor[];
  particle: ParticleStyle;
  /** Particle/glyph gravity in px/s². Positive falls, negative floats up. */
  gravity: number;
  /** Motion multiplier (0.5 sleepy … 1.5 lively). */
  energy: number;
  timbre: Timbre;
  /** MIDI note of the world's pentatonic root (e.g. 60 = middle C). */
  rootMidi: number;
  /** Emoji that live in this world; used for taps, filler keys and idle play. */
  friends: string[];
  /** Optional per-letter word list overrides (keys are upper-case 'A'…'Z'). */
  words?: Partial<Record<string, WordEntry[]>>;
}

// ---------------------------------------------------------------------------
// Settings (parent controls) — persisted to localStorage
// ---------------------------------------------------------------------------

export type SpeechMode = 'off' | 'letter' | 'word';
export type LetterCase = 'upper' | 'lower' | 'both';
export type SizeLevel = 'normal' | 'big' | 'huge';
export type Intensity = 'calm' | 'normal' | 'wild';
export type MotionPref = 'system' | 'reduce' | 'full';

export interface Settings {
  world: WorldId;
  /** Switch to the next world every `rotateMinutes` minutes. */
  autoRotate: boolean;
  rotateMinutes: number; // 1..30
  /** Master volume 0..1 (the engine also hard-limits peaks). */
  volume: number;
  muted: boolean;
  /** Musical notes on key presses (otherwise only soft sound effects). */
  notes: boolean;
  /** What is spoken aloud on letter/number/shape keys. */
  speech: SpeechMode;
  /** `SpeechSynthesisVoice.voiceURI`, or null for automatic choice. */
  voiceURI: string | null;
  letterCase: LetterCase;
  /** Show the picture (emoji) that goes with a letter, e.g. A → 🍎. */
  pictures: boolean;
  size: SizeLevel;
  intensity: Intensity;
  motion: MotionPref;
  /** Sparkle trails that follow the mouse / finger. */
  trails: boolean;
  /** Shapes get cute blinking faces. */
  faces: boolean;
  /** Place each key's letter where that key sits on the keyboard (left keys → left of screen). */
  spatialKeys: boolean;
  /** Optional child's name; shown on the start screen and spoken now and then. '' = none. */
  childName: string;
  /** Wind down and show "All done!" after this many minutes. 0 = never. */
  sessionMinutes: number; // 0..120
  /** Typing this word opens the parent panel. Lower-case letters only, 4..16 chars. */
  secretWord: string;
  /** Ask the browser to capture system keys (Escape, Cmd+W…) while fullscreen. */
  lockKeyboard: boolean;
  /** Ask "Leave site?" if a tab-close shortcut slips through. */
  confirmExit: boolean;
}

export interface SettingsStore {
  get(): Settings;
  /** Merge, sanitise, persist, notify. Returns the new settings. */
  update(patch: Partial<Settings>): Settings;
  reset(): Settings;
  /** Called after every change. Returns an unsubscribe function. */
  subscribe(listener: (next: Settings, prev: Settings) => void): () => void;
}

// ---------------------------------------------------------------------------
// Content: what a key press *means*
// ---------------------------------------------------------------------------

export type ShapeKind =
  | 'circle' | 'square' | 'triangle' | 'star' | 'heart'
  | 'diamond' | 'moon' | 'flower' | 'hexagon' | 'cloud';

export type SpecialEffect =
  | 'rainbow'     // Space bar: a rainbow arc sweeps across with sparkles
  | 'fireworks'   // a few fireworks pop around the screen
  | 'sweep'       // Enter: a gentle wave washes everything off the screen
  | 'pop-all'     // Backspace/Delete: every object pops like a bubble
  | 'comet-up' | 'comet-down' | 'comet-left' | 'comet-right'; // arrow keys

export type KeyContent =
  | {
      kind: 'letter';
      /** Upper-case letter 'A'…'Z'. */
      letter: string;
      /** What to draw, already cased per settings, e.g. 'A', 'a' or 'Aa'. */
      display: string;
      word: WordEntry | null;
      color: NamedColor;
      /** Text to speak, or null for silence. */
      speak: string | null;
    }
  | {
      kind: 'digit';
      digit: number; // 0..9
      display: string; // '0'…'9'
      /** Emoji repeated `digit` times around the number (counting!). */
      countEmoji: string;
      color: NamedColor;
      speak: string | null; // e.g. 'three'
    }
  | {
      kind: 'shape';
      shape: ShapeKind;
      color: NamedColor;
      speak: string | null; // e.g. 'blue star'
    }
  | {
      kind: 'emoji';
      emoji: string;
      speak: string | null;
    }
  | {
      kind: 'special';
      effect: SpecialEffect;
      speak: string | null;
    };

export interface ContentContext {
  world: World;
  settings: Settings;
  /** Deterministic-in-tests random source returning [0, 1). */
  rng: () => number;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Normalised physical key position: x 0 (left) … 1 (right), y 0 (top row) … 1 (bottom row). */
export interface KeyPosition {
  x: number;
  y: number;
}

export interface KeyPress {
  /** `KeyboardEvent.code`, e.g. 'KeyA', 'Digit3', 'Space'. Layout independent. */
  code: string;
  /** `KeyboardEvent.key`, e.g. 'a', '3', ' '. */
  key: string;
  /** True for auto-repeat while a key is held. */
  repeat: boolean;
  /** Where the key physically sits on a keyboard, or null if unknown. */
  position: KeyPosition | null;
  time: number;
}

export interface SmashEvent {
  /** Distinct codes pressed within the smash window (≥ threshold). */
  codes: string[];
  /** Mean physical position of the smashed keys, or null. */
  center: KeyPosition | null;
  time: number;
}

export interface KeyboardHandlers {
  onKey(press: KeyPress): void;
  /** Fired once when many keys land almost together (a palm smash). */
  onSmash(smash: SmashEvent): void;
  /** The secret word was typed. */
  onSecret(): void;
}

export interface KeyboardInput {
  attach(): void;
  detach(): void;
  /** While disabled, keys are still swallowed (preventDefault) but no handlers fire. */
  setEnabled(enabled: boolean): void;
  setSecretWord(word: string): void;
}

export interface PointerHandlers {
  /** Finger/mouse went down. */
  onTap(x: number, y: number, pointerId: number): void;
  /** Pressed pointer moved. (dx, dy) are CSS px since the last event. */
  onDrag(x: number, y: number, dx: number, dy: number, pointerId: number): void;
  onRelease(x: number, y: number, pointerId: number): void;
  /** Mouse moved without a button pressed (no-op on touch). */
  onHover(x: number, y: number, dx: number, dy: number): void;
  /** A pointer was held still in the top-left corner zone for the configured time. */
  onCornerHold(): void;
  /** 0..1 progress of a corner hold in progress (0 when released). For a hint ring. */
  onCornerProgress?(progress: number): void;
}

export interface PointerInput {
  attach(): void;
  detach(): void;
  setEnabled(enabled: boolean): void;
}

export interface LockStatus {
  fullscreen: boolean;
  /** Keyboard Lock API active (Chromium only, fullscreen only). */
  keyboardLocked: boolean;
  /** Screen Wake Lock held. */
  wakeLock: boolean;
  /** True when running as an installed app (display-mode standalone/fullscreen). */
  installed: boolean;
}

export interface Lockdown {
  /** Must be called from a user gesture. Requests fullscreen, keyboard lock and wake lock. */
  enter(options: { lockKeyboard: boolean }): Promise<LockStatus>;
  exit(): Promise<void>;
  status(): LockStatus;
  /** Fires on any status change, notably fullscreen lost (toddler held Esc). */
  onChange(listener: (status: LockStatus) => void): () => void;
  setConfirmExit(enabled: boolean): void;
  /** Blocks context menu, text selection, drag, pinch/ctrl-wheel zoom, overscroll. Idempotent. */
  installGuards(): void;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export type SoundEffect =
  | 'pop' | 'bubble' | 'boing' | 'whoosh' | 'sparkle'
  | 'chime' | 'tada' | 'swoosh' | 'thud' | 'twinkle';

export interface NoteOptions {
  /** 0..1, default 0.8. */
  velocity?: number;
  /** Stereo position -1 (left) … 1 (right). */
  pan?: number;
  /** Seconds; the timbre decides a sensible default. */
  duration?: number;
}

export interface AudioEngine {
  /** Create/resume the AudioContext. Call from a user gesture. Safe to call repeatedly. */
  unlock(): Promise<void>;
  readonly ready: boolean;
  setVolume(volume: number): void; // 0..1
  setMuted(muted: boolean): void;
  setTimbre(timbre: Timbre): void;
  /**
   * Key the melodic effects (sparkle, twinkle, chime, tada) to the world's
   * major pentatonic scale rooted at `rootMidi`, so they never clash with key
   * notes. Only the pitch class matters (effects keep their own register).
   */
  setRoot(rootMidi: number): void;
  /** Play a MIDI note with the current timbre. */
  note(midi: number, options?: NoteOptions): void;
  /** Play notes as a quick rising arpeggio (smash, rainbow…). */
  chord(midis: number[], options?: NoteOptions & { spread?: number }): void;
  effect(name: SoundEffect, options?: NoteOptions): void;
  /** Smoothly scale output (wind-down). 1 = normal, 0 = silent. */
  fadeTo(level: number, seconds: number): void;
}

export interface VoiceInfo {
  uri: string;
  name: string;
  lang: string;
  /**
   * True for on-device voices. False for network voices (e.g. Chrome's
   * "Google …", Edge's "… Online (Natural)"), which send the text to a server
   * and fail offline.
   */
  local: boolean;
}

export interface Speaker {
  readonly supported: boolean;
  setEnabled(enabled: boolean): void;
  setVolume(volume: number): void; // 0..1
  setVoice(uri: string | null): void;
  /** English voices first, then the rest. May be empty until voices load. */
  voices(): VoiceInfo[];
  onVoicesChanged(listener: () => void): () => void;
  /**
   * 'low' (default): skip if something is being said or was said very recently.
   * 'high': cancel whatever is playing and say this now.
   */
  say(text: string, priority?: 'low' | 'high'): void;
  cancel(): void;
}

/** Maps physical keys to musical notes and screen positions. */
export interface KeyMap {
  position(code: string): KeyPosition | null;
  /** MIDI note for a key in a world rooted at `rootMidi` (pentatonic; higher rows play higher). */
  note(code: string, rootMidi: number): number;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface SceneOptions {
  reduceMotion: boolean;
  intensity: Intensity;
  size: SizeLevel;
  faces: boolean;
  /** CSS font-family for glyphs, e.g. '"Fredoka", system-ui, sans-serif'. */
  fontFamily: string;
}

export interface GlyphSpec {
  /** 1–3 characters, e.g. 'A', 'Aa', '7'. */
  text: string;
  x: number;
  y: number;
  color: NamedColor;
  /** Picture shown with the glyph (beside or above it), e.g. '🍎'. */
  emoji?: string | null;
  /** Small word under the glyph, e.g. 'apple'. */
  caption?: string | null;
  /** Count mode: draw `count` copies of `emoji` orbiting the glyph (digits). */
  count?: number;
  /** Extra size multiplier on top of settings. Default 1. */
  scale?: number;
}

export interface ShapeSpec {
  shape: ShapeKind;
  x: number;
  y: number;
  color: NamedColor;
  scale?: number;
}

export interface EmojiSpec {
  emoji: string;
  x: number;
  y: number;
  scale?: number;
}

export interface Scene {
  setWorld(world: World): void; // cross-fades the backdrop
  setOptions(options: SceneOptions): void;
  /**
   * 0 = normal … 1 = asleep. Used for the session wind-down: slows motion,
   * dims colours, thins particles. Changes should be eased by the scene.
   */
  setCalm(level: number): void;
  spawnGlyph(spec: GlyphSpec): void;
  spawnShape(spec: ShapeSpec): void;
  spawnEmoji(spec: EmojiSpec): void;
  /** Particle burst; power 0..2 (1 = a normal key press). */
  burst(x: number, y: number, color: NamedColor, power?: number): void;
  /** Expanding ring at a point (taps). */
  ripple(x: number, y: number, color: NamedColor): void;
  /** Add a point to a pointer's sparkle trail. */
  trail(x: number, y: number, color: NamedColor, pointerId: number): void;
  endTrail(pointerId: number): void;
  special(effect: SpecialEffect, at?: { x: number; y: number }): void;
  /**
   * If an object is under (x, y), make it react (jiggle/spin + small burst) and
   * return what it is so the game can replay its sound; otherwise null.
   */
  poke(x: number, y: number): PokeResult | null;
  /** Number of live big objects (glyphs/shapes/emoji), for caps and idle logic. */
  readonly objectCount: number;
  update(dt: number, now: number): void;
  draw(): void;
  resize(width: number, height: number, dpr: number): void;
}

export interface PokeResult {
  kind: 'glyph' | 'shape' | 'emoji';
  /** Glyph text, shape kind or emoji character. */
  value: string;
  color: NamedColor | null;
}

export interface Stage {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number; // CSS px
  readonly height: number; // CSS px
  readonly dpr: number;
  /** Starts the rAF loop. `dt` is clamped to ≤ 0.05 s. */
  start(frame: (dt: number, now: number) => void): void;
  stop(): void;
  onResize(listener: (width: number, height: number, dpr: number) => void): () => void;
}

// ---------------------------------------------------------------------------
// UI (DOM overlays)
// ---------------------------------------------------------------------------

export interface SessionStats {
  startedAt: number; // epoch ms
  keys: number;
  taps: number;
  smashes: number;
  /** Most pressed keys, as [display label, count], highest first, max 5. */
  topKeys: Array<[string, number]>;
  /** Milliseconds of active play. */
  playMs: number;
}

export interface ParentPanelDeps {
  store: SettingsStore;
  worlds: World[];
  speaker: Speaker;
  getStats(): SessionStats;
  getLockStatus(): LockStatus;
  /** True when the browser supports PWA install and it has been offered. */
  canInstall(): boolean;
  actions: {
    /** Close the panel and keep playing. */
    resume(): void;
    /** Close the panel, leave fullscreen, show the start screen. */
    stop(): void;
    /** Re-request fullscreen + locks (needs the click that triggers it). */
    relock(): void;
    testSound(): void;
    resetStats(): void;
    install(): void;
  };
}

export interface ParentPanel {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

export interface StartScreenDeps {
  store: SettingsStore;
  worlds: World[];
  /** Called from the user gesture (click/tap/key) that starts play. */
  onStart(): void;
  /** Optional: open the grown-up panel from the start screen (a small settings link). */
  onOpenControls?(): void;
}

export interface StartScreen {
  show(): void;
  hide(): void;
  readonly isVisible: boolean;
}

export interface Overlays {
  /** Wind-down finished: sleepy "All done!" card. Only a parent gesture resumes. */
  showAllDone(onParentResume: () => void): void;
  hideAllDone(): void;
  /** Fullscreen was lost mid-play: big friendly "Tap to keep playing". */
  showResume(onResume: () => void): void;
  hideResume(): void;
  /** Ring that fills while a parent holds the top-left corner. 0 hides it. */
  setCornerProgress(progress: number): void;
  /** Brief toast for parents, e.g. 'Keyboard locked 🔒'. */
  toast(message: string): void;
}
