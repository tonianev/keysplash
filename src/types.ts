/**
 * Shared contracts for KeySplash (v2 — "learn through play", matte design).
 *
 * Every module codes against these types. Modules export concrete classes that
 * `implements` the interfaces below, so the orchestrator (src/game.ts) only
 * depends on this file. See DESIGN.md for the visual language and the
 * education model these contracts serve.
 *
 * Units: screen positions are CSS pixels relative to the top-left of the
 * viewport. Times are milliseconds from `performance.now()` unless a name says
 * otherwise. `dt` in update loops is seconds.
 */

// ---------------------------------------------------------------------------
// Shared timing (scene animation and speech must stay in step)
// ---------------------------------------------------------------------------

export const TIMING = {
  /** A digit card reveals one counted picture every step, while the number is spoken. */
  countStepMs: 700,
  /** The rainbow paints one band every step while its colour name is spoken. */
  rainbowBandMs: 600,
} as const;

// ---------------------------------------------------------------------------
// Worlds (themes)
// ---------------------------------------------------------------------------

export type WorldId = 'paper' | 'garden' | 'ocean' | 'space' | 'jungle' | 'snow' | 'night';

/** Soft, warm instrument the audio engine uses for key notes in a world. */
export type Timbre = 'felt' | 'marimba' | 'kalimba' | 'celesta' | 'harp' | 'soft';

/** Matte, flat illustrated backdrop. One per world. */
export type BackgroundKind = 'paper' | 'meadow' | 'ocean' | 'space' | 'jungle' | 'snow' | 'night';

/** Small matte pieces used for gentle celebrations (never glowing). */
export type ParticleStyle = 'confetti' | 'dots' | 'petals' | 'bubbles' | 'leaves' | 'snow' | 'stars';

/** Basic colour words a toddler can learn. Spoken aloud ("blue circle"). */
export type ColorName = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'brown';

/**
 * A learnable colour with matte tonal variants (Material-3 style tones).
 * Light worlds: `container` is a pale tint, `ink` a deep tone.
 * Dark worlds: `container` is a deep tone, `ink` a light tone.
 */
export interface NamedColor {
  name: ColorName;
  /** The colour itself — a matte, mid-saturation swatch. Shapes, confetti, rainbow bands, paint. */
  hex: string;
  /** Card surface tinted with this colour. */
  container: string;
  /** Text/glyph colour on `container` (contrast ≥ 4.5:1 with it). */
  ink: string;
}

export interface WordEntry {
  /** Lower-case word, e.g. 'apple'. Must contain the featured letter. */
  word: string;
  /** A single emoji that pictures the word, e.g. '🍎'. Unicode ≤ 13, no ZWJ sequences. */
  emoji: string;
  /** Index of the featured letter inside `word` (default 0 — the first letter). e.g. 'fox' for X → 2. */
  at?: number;
}

export interface World {
  id: WorldId;
  /** Parent-facing name, e.g. 'Paper', 'Under the Sea'. */
  label: string;
  /** Emoji icon for pickers. */
  icon: string;
  background: BackgroundKind;
  /** Backdrop base colours, top then bottom (matte; the backdrop may add flat layers). */
  sky: [string, string];
  /** True when the backdrop is dark (cards/ink use dark-mode tones). */
  dark: boolean;
  /** Neutral card surface for cards that teach no colour (pictures, directions) and UI chrome. */
  surface: string;
  /** Neutral text colour on `surface`. */
  onSurface: string;
  /** 6–8 learnable colours. Must include red, orange, yellow, green, blue, purple (the rainbow). */
  palette: NamedColor[];
  particle: ParticleStyle;
  /** Gentle drift in px/s² for particles/idle friends. Positive falls, negative floats up. */
  gravity: number;
  /** Motion multiplier (0.6 sleepy … 1.2 lively). */
  energy: number;
  timbre: Timbre;
  /** MIDI note of the world's pentatonic root (e.g. 60 = middle C). */
  rootMidi: number;
  /** Emoji that live in this world; used for taps and idle friends. */
  friends: string[];
  /** Optional per-letter word list overrides (keys are upper-case 'A'…'Z'). */
  words?: Partial<Record<string, WordEntry[]>>;
}

// ---------------------------------------------------------------------------
// Settings (parent controls) — persisted to localStorage
// ---------------------------------------------------------------------------

/** What the voice says on a letter key. (Whether it speaks at all is `Settings.voice`.) */
export type SpeechMode = 'letter' | 'word';
/** natural = the built-in recorded neural voice; device = this computer's speech voices. */
export type VoiceStyle = 'natural' | 'device';
export type LetterCase = 'upper' | 'lower' | 'both';
export type SizeLevel = 'normal' | 'big' | 'huge';
export type Intensity = 'calm' | 'normal' | 'lively';
export type MotionPref = 'system' | 'reduce' | 'full';
/** explore = free play; the others are gentle learning games (see DESIGN.md). */
export type PlayMode = 'explore' | 'find-letters' | 'find-numbers' | 'spell';
/** focus = one flashcard centre-stage, recent ones on a shelf; keyboard = cards appear where the key sits. */
export type Layout = 'focus' | 'keyboard';

export interface Settings {
  world: WorldId;
  mode: PlayMode;
  layout: Layout;
  /** Switch to the next world every `rotateMinutes` minutes. */
  autoRotate: boolean;
  rotateMinutes: number; // 1..30
  /** Master volume 0..1 (the engine also hard-limits peaks). */
  volume: number;
  muted: boolean;
  /** Soft musical note under each key press (otherwise a quiet tap sound). */
  notes: boolean;
  /** The clear on/off switch for the voice (start screen + grown-up panel). */
  voice: boolean;
  /** Built-in natural voice (default) or this device's speech voices. */
  voiceStyle: VoiceStyle;
  /** 'letter' → "B"; 'word' → "B… B is for ball". */
  speech: SpeechMode;
  /** Device style only: `SpeechSynthesisVoice.voiceURI`, or null for automatic choice. */
  voiceURI: string | null;
  letterCase: LetterCase;
  /** Show the picture (emoji) that goes with a letter, e.g. B → ⚽. */
  pictures: boolean;
  size: SizeLevel;
  intensity: Intensity;
  motion: MotionPref;
  /** Finger/mouse painting with soft matte strokes. */
  trails: boolean;
  /** Tap shapes get simple friendly faces. */
  faces: boolean;
  /** Optional child's name; greeted on start, used in praise ("Great job, Mia!"). '' = none. */
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
  /** Merge, sanitise, persist, notify. Invalid fields keep their current value. Returns the new settings. */
  update(patch: Partial<Settings>): Settings;
  reset(): Settings;
  /** Called after every change. Returns an unsubscribe function. */
  subscribe(listener: (next: Settings, prev: Settings) => void): () => void;
}

// ---------------------------------------------------------------------------
// Learning progress — persisted to localStorage, shown to parents
// ---------------------------------------------------------------------------

export interface LearningProgress {
  /** How often each symbol was shown in play. Keys: 'A'…'Z', '0'…'9'. */
  seen: Record<string, number>;
  /** How often each symbol was found in a Find game. */
  found: Record<string, number>;
  /** How often each word was spelled in Spell. Keys: lower-case words. */
  spelled: Record<string, number>;
  /** Epoch ms of the first recorded activity, or null. */
  since: number | null;
}

export interface ProgressStore {
  get(): LearningProgress;
  markSeen(symbol: string): void;
  markFound(symbol: string): void;
  markSpelled(word: string): void;
  reset(): void;
  /** Called after changes (may be batched). Returns an unsubscribe function. */
  subscribe(listener: (progress: LearningProgress) => void): () => void;
}

// ---------------------------------------------------------------------------
// Content: what a key press *teaches*
// ---------------------------------------------------------------------------

export type ShapeKind =
  | 'circle' | 'square' | 'triangle' | 'star' | 'heart'
  | 'diamond' | 'moon' | 'oval' | 'hexagon' | 'rectangle';

export type DirectionName = 'up' | 'down' | 'left' | 'right';

export type SpecialEffect =
  | 'rainbow'    // Space: bands paint in one by one while each colour is named
  | 'clear'      // Enter/Backspace/Delete: cards glide away, "All clean!"
  | 'celebrate'; // correct answers and palm smashes: soft matte confetti + the current card hops

export type KeyContent =
  | {
      kind: 'letter';
      /** Upper-case letter 'A'…'Z'. */
      letter: string;
      /** What to draw, already cased per settings: 'B', 'b' or 'Bb'. */
      display: string;
      word: WordEntry;
      color: NamedColor;
      /** Text to speak, or null for silence. 'word' mode: "bee… bee is for ball". */
      speak: string | null;
    }
  | {
      kind: 'digit';
      digit: number; // 0..9
      display: string; // '0'…'9'
      /** Picture counted out on the card, e.g. '⭐'. */
      countEmoji: string;
      /** Plural noun for the picture, e.g. 'stars' ('star' when digit is 1). */
      countNoun: string;
      color: NamedColor;
      /** Spoken one per TIMING.countStepMs as pictures appear: ['one','two','three']. Empty for 0. */
      countWords: string[];
      /** Spoken after counting: 'three stars!' / 'zero — none!'. Null when speech is off. */
      speak: string | null;
    }
  | {
      kind: 'shape';
      shape: ShapeKind;
      color: NamedColor;
      /** 'circle', 'star'… */
      label: string;
      /** 'blue circle', or null. */
      speak: string | null;
    }
  | {
      kind: 'picture';
      /** Always the same picture for the same key (no randomness). */
      emoji: string;
      /** 'cow', 'duck'… */
      word: string;
      speak: string | null;
    }
  | {
      kind: 'direction';
      direction: DirectionName;
      color: NamedColor;
      speak: string | null; // 'up!'
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
// Learning games
// ---------------------------------------------------------------------------

export type Challenge =
  | {
      kind: 'find-letter';
      /** Upper-case target 'A'…'Z'. */
      target: string;
      /** Cased per settings, e.g. 'B' or 'Bb'. */
      display: string;
      word: WordEntry;
      color: NamedColor;
      /** Spoken prompt: 'Can you find bee?' */
      prompt: string;
    }
  | {
      kind: 'find-number';
      target: number; // 0..9
      display: string;
      color: NamedColor;
      prompt: string; // 'Can you find three?'
    }
  | {
      kind: 'spell';
      word: WordEntry;
      /** Upper-case letters of the word, e.g. ['C','A','T']. */
      letters: string[];
      /** Index of the next letter to press (0..letters.length). */
      index: number;
      color: NamedColor;
      prompt: string; // "Let's spell cat. Find see."
    };

export type HintLevel = 0 | 1 | 2;

export type ModeOutcome =
  /** Explore mode, or this key is not part of the game (arrows, Space…): free-play it. */
  | { result: 'free' }
  | {
      result: 'correct';
      /** The challenge as it is after this press. */
      challenge: Challenge;
      /** True when the whole challenge is complete (find: always; spell: last letter). */
      complete: boolean;
      /** The next challenge when complete (already current), else null. */
      next: Challenge | null;
      /** Praise or next-letter prompt to speak, e.g. 'Yes! That is bee!' / 'Now find ay.' */
      say: string;
    }
  | {
      result: 'wrong';
      challenge: Challenge;
      /** Wrong presses on this challenge so far. */
      attempts: number;
      /** 0 none, 1 show where the key is on the mini keyboard, 2 also pulse it and say where. */
      hint: HintLevel;
      /** Gentle redirect to speak (never negative), e.g. 'That is em. Can you find bee?' — null to stay quiet (rate-limited). */
      say: string | null;
    };

export interface LearningGame {
  readonly mode: PlayMode;
  setMode(mode: PlayMode, ctx: ContentContext): Challenge | null;
  current(): Challenge | null;
  /** Start a fresh round for the current mode (null in explore). */
  begin(ctx: ContentContext): Challenge | null;
  /** Judge what a key press means. */
  judge(content: KeyContent, ctx: ContentContext): ModeOutcome;
  /** Replace the current challenge (parent skip / long idle). */
  skip(ctx: ContentContext): Challenge | null;
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

/** Quiet, warm, non-cartoon effects. Nothing harsh, nothing that sounds like "wrong". */
export type SoundEffect =
  | 'tap'      // soft wooden tick (taps, quiet key feedback when notes are off)
  | 'pop'      // soft round pop (a card pressed, a bubble)
  | 'swipe'    // airy page-turn (clear, cards gliding)
  | 'chime'    // gentle two-note chime (prompt appears)
  | 'success'  // warm rising three-note phrase (found it!)
  | 'retry'    // neutral soft two-note "hmm?" — encouraging, never a buzzer
  | 'count'    // soft tick that pitches up per counted item
  | 'complete';// fuller warm phrase (a word spelled, a round finished)

export interface NoteOptions {
  /** 0..1, default 0.7. */
  velocity?: number;
  /** Stereo position -1 (left) … 1 (right). */
  pan?: number;
  /** Seconds; the timbre decides a sensible default. */
  duration?: number;
  /** For 'count': which item (0-based) — pitches climb the scale. */
  step?: number;
}

export interface AudioEngine extends VoiceOutput {
  /** Create/resume the AudioContext. Call from a user gesture. Safe to call repeatedly. */
  unlock(): Promise<void>;
  readonly ready: boolean;
  setVolume(volume: number): void; // 0..1
  setMuted(muted: boolean): void;
  setTimbre(timbre: Timbre): void;
  /** Key melodic effects to the world's major pentatonic scale rooted at `rootMidi`. */
  setRoot(rootMidi: number): void;
  /** Play a MIDI note with the current timbre. */
  note(midi: number, options?: NoteOptions): void;
  /** Play notes as a gentle rising arpeggio. */
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
   * 'high': cancel whatever is playing (and any running sequence) and say this now.
   */
  say(text: string, priority?: 'low' | 'high'): void;
  /**
   * Say `parts` one after another, starting part i at i × stepMs (counting
   * "one… two… three…", naming rainbow colours). Cancels anything playing and
   * any previous sequence. `then` (optional) is spoken right after the last part.
   */
  sequence(parts: string[], stepMs: number, then?: string | null): void;
  /** True while a sequence is still running. */
  readonly sequencing: boolean;
  /** Stops speech and any pending sequence. Always safe. */
  cancel(): void;
  /** Switch between the built-in natural voice and device voices (router only). */
  setStyle?(style: VoiceStyle): void;
  /** Prefetch/decode the most common lines after audio unlock (natural voice). */
  warm?(): void;
}

/** One playing (or scheduled) voice clip. */
export interface VoicePlayback {
  /** AudioContext time (s) when the clip ends. */
  readonly endTime: number;
  stop(): void;
  /** Resolves when the clip ends or is stopped. */
  readonly ended: Promise<void>;
}

/**
 * Voice-clip output provided by the audio engine, so recorded speech goes
 * through the same master volume, fade (hidden tab / wind-down) and limiter
 * as everything else, and soft notes duck underneath it.
 */
export interface VoiceOutput {
  /** AudioContext time in seconds, or null before unlock. */
  currentTime(): number | null;
  /** Decode an encoded clip (mp3); null before unlock or on failure. Never throws. */
  decodeAudio(data: ArrayBuffer): Promise<AudioBuffer | null>;
  /** Play a decoded clip at context time `when` (default: now). Null before unlock. */
  playVoice(buffer: AudioBuffer, when?: number): VoicePlayback | null;
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
  layout: Layout;
  /** CSS font-family for letters, numbers and words on cards (Andika — literacy letterforms). */
  fontFamily: string;
}

/** Card kinds mirror what a press teaches. */
export type CardKind = 'letter' | 'digit' | 'shape' | 'picture' | 'direction';

export interface CardSpec {
  kind: CardKind;
  /** Big glyph(s) for letter/digit cards: 'Bb', 'b', '3'. */
  text?: string | null;
  /** Picture: the letter's word picture, the counted picture (digits) or the picture itself. */
  picture?: string | null;
  /** Word shown on the card's bottom line: 'ball', 'blue circle', 'up', 'cow'. */
  word?: string | null;
  /** [start, end) range inside `word` drawn in the card colour's ink (the featured letter, or the colour word). */
  highlight?: [number, number] | null;
  shape?: ShapeKind | null;
  direction?: DirectionName | null;
  /** Digit cards: reveal `count` pictures one by one, one every TIMING.countStepMs, in a ten-frame (rows of 5). */
  count?: number | null;
  /** Colour the card teaches (letters/digits/shapes/directions). Pictures use the world's neutral surface when absent. */
  color?: NamedColor | null;
  /** Keyboard layout only: card centre. Focus layout ignores it. */
  at?: { x: number; y: number } | null;
  /** 'small' for secondary cards (wrong answers in games, extra keys of a smash). */
  emphasis?: 'normal' | 'small';
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

export interface PokeResult {
  kind: CardKind | 'shape' | 'emoji';
  /** The card id when a card was poked, else null. */
  cardId: number | null;
  /** Card text/word, shape kind or emoji character. */
  value: string;
  color: NamedColor | null;
}

export interface Scene {
  setWorld(world: World): void; // cross-fades the backdrop
  setOptions(options: SceneOptions): void;
  /**
   * 0 = normal … 1 = asleep. Used for the session wind-down: slows motion,
   * dims gently, thins particles. Changes are eased by the scene.
   */
  setCalm(level: number): void;
  /**
   * Show a flashcard. Focus layout: it becomes the centre card and the previous
   * centre card glides to the shelf. Keyboard layout: it appears at `spec.at`.
   * Returns the card id.
   */
  showCard(spec: CardSpec): number;
  /** Small matte shape at a point (taps). */
  spawnShape(spec: ShapeSpec): void;
  /** A friend drifting gently (idle) or a picture at a tap point. */
  spawnEmoji(spec: EmojiSpec): void;
  /** A few matte pieces (world particle style); power 0..2. Subtle — never a firework. */
  burst(x: number, y: number, color: NamedColor, power?: number): void;
  /** Soft expanding ring at a point (taps). */
  ripple(x: number, y: number, color: NamedColor): void;
  /** Finger painting: add a point to a pointer's matte brush stroke. */
  trail(x: number, y: number, color: NamedColor, pointerId: number): void;
  endTrail(pointerId: number): void;
  /**
   * rainbow: paints `colors` as bands one per TIMING.rainbowBandMs (game names them in step).
   * clear: every card glides away gently. celebrate: soft matte confetti falls and the centre card hops.
   */
  special(effect: SpecialEffect, options?: { at?: { x: number; y: number }; colors?: NamedColor[] }): void;
  /** Gentle pulse on a card (e.g. replaying it). No-op for unknown ids. */
  pulseCard(id: number): void;
  /**
   * Keep the centre card below this many CSS px from the top (the game prompt,
   * and its hint keyboard when shown). 0 = default layout.
   */
  setTopInset(px: number): void;
  /**
   * If something is under (x, y), make it react (a small press-in bounce) and
   * return what it is so the game can replay its sound/word; otherwise null.
   */
  poke(x: number, y: number): PokeResult | null;
  /** Number of live objects (cards, shapes, emoji), for caps and idle logic. */
  readonly objectCount: number;
  update(dt: number, now: number): void;
  draw(): void;
  resize(width: number, height: number, dpr: number): void;
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
  /** Learning-game answers this session. */
  found: number;
  /** Words spelled this session. */
  spelled: number;
  /** Most pressed keys, as [display label, count], highest first, max 5. */
  topKeys: Array<[string, number]>;
  /** Milliseconds of active play. */
  playMs: number;
}

export interface ParentPanelDeps {
  store: SettingsStore;
  progress: ProgressStore;
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
    resetProgress(): void;
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
  /** Open the grown-up panel from the start screen (a small settings link). */
  onOpenControls?(): void;
}

export interface StartScreen {
  show(): void;
  hide(): void;
  readonly isVisible: boolean;
}

/**
 * Learning-game prompt: a compact card at the top centre ("Find  B  ⚽"), with a
 * mini keyboard that appears as a hint and highlights where the key is.
 */
export interface PromptBar {
  /** Show/replace the prompt for a challenge (spell: word letters with done ones filled). */
  show(challenge: Challenge): void;
  /**
   * Update the spell progress or hint state without re-animating the card.
   * `targetCode` is the physical key to highlight (layout-aware); default US-QWERTY.
   */
  update(challenge: Challenge, hint: HintLevel, targetCode?: string | null): void;
  /** Brief success state (check + colour fill), ~900 ms; the game shows the next challenge after. */
  celebrate(): void;
  hide(): void;
  /** Bottom edge (CSS px from the viewport top) of what the prompt covers now; 0 when hidden. */
  reservedBottom(): number;
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
