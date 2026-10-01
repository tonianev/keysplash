/**
 * Test doubles for Game and integration tests: every dependency records what
 * it was asked to do.
 */
import type { MediaQueryListLike, VisibilitySource } from '../src/game';
import type {
  AudioEngine,
  EmojiSpec,
  GlyphSpec,
  KeyboardHandlers,
  KeyboardInput,
  LockStatus,
  Lockdown,
  NamedColor,
  NoteOptions,
  Overlays,
  ParentPanel,
  ParentPanelDeps,
  PokeResult,
  PointerHandlers,
  PointerInput,
  Scene,
  SceneOptions,
  ShapeSpec,
  SoundEffect,
  Speaker,
  SpecialEffect,
  StartScreen,
  StartScreenDeps,
  Timbre,
  VoiceInfo,
  World,
} from '../src/types';

export class FakeScene implements Scene {
  objectCount = 0;
  worlds: World[] = [];
  options: SceneOptions[] = [];
  calm: number[] = [];
  glyphs: GlyphSpec[] = [];
  shapes: ShapeSpec[] = [];
  emoji: EmojiSpec[] = [];
  bursts: Array<{ x: number; y: number; color: NamedColor; power?: number }> = [];
  ripples: Array<{ x: number; y: number }> = [];
  trails: Array<{ x: number; y: number; pointerId: number }> = [];
  endedTrails: number[] = [];
  specials: Array<{ effect: SpecialEffect; at?: { x: number; y: number } }> = [];
  pokeResult: PokeResult | null = null;

  setWorld(world: World): void {
    this.worlds.push(world);
  }
  setOptions(options: SceneOptions): void {
    this.options.push(options);
  }
  setCalm(level: number): void {
    this.calm.push(level);
  }
  spawnGlyph(spec: GlyphSpec): void {
    this.glyphs.push(spec);
  }
  spawnShape(spec: ShapeSpec): void {
    this.shapes.push(spec);
  }
  spawnEmoji(spec: EmojiSpec): void {
    this.emoji.push(spec);
  }
  burst(x: number, y: number, color: NamedColor, power?: number): void {
    this.bursts.push({ x, y, color, power });
  }
  ripple(x: number, y: number): void {
    this.ripples.push({ x, y });
  }
  trail(x: number, y: number, _color: NamedColor, pointerId: number): void {
    this.trails.push({ x, y, pointerId });
  }
  endTrail(pointerId: number): void {
    this.endedTrails.push(pointerId);
  }
  special(effect: SpecialEffect, at?: { x: number; y: number }): void {
    this.specials.push({ effect, at });
  }
  poke(): PokeResult | null {
    return this.pokeResult;
  }
  update(): void {}
  draw(): void {}
  resize(): void {}

  get lastOptions(): SceneOptions {
    return this.options[this.options.length - 1];
  }
  get lastCalm(): number {
    return this.calm[this.calm.length - 1];
  }
}

export class FakeAudio implements AudioEngine {
  ready = true;
  unlocks = 0;
  volume = -1;
  muted = false;
  timbre: Timbre | null = null;
  root: number | null = null;
  notes: Array<{ midi: number; options?: NoteOptions }> = [];
  chords: number[][] = [];
  effects: Array<{ name: SoundEffect; options?: NoteOptions }> = [];
  fades: Array<[number, number]> = [];

  unlock(): Promise<void> {
    this.unlocks++;
    return Promise.resolve();
  }
  setVolume(volume: number): void {
    this.volume = volume;
  }
  setMuted(muted: boolean): void {
    this.muted = muted;
  }
  setTimbre(timbre: Timbre): void {
    this.timbre = timbre;
  }
  setRoot(rootMidi: number): void {
    this.root = rootMidi;
  }
  note(midi: number, options?: NoteOptions): void {
    this.notes.push({ midi, options });
  }
  chord(midis: number[]): void {
    this.chords.push(midis);
  }
  effect(name: SoundEffect, options?: NoteOptions): void {
    this.effects.push({ name, options });
  }
  fadeTo(level: number, seconds: number): void {
    this.fades.push([level, seconds]);
  }

  effectCount(name: SoundEffect): number {
    return this.effects.filter((e) => e.name === name).length;
  }
  get lastFade(): [number, number] {
    return this.fades[this.fades.length - 1];
  }
}

export class FakeSpeaker implements Speaker {
  readonly supported = true;
  enabled = true;
  volume = 1;
  voice: string | null = null;
  cancels = 0;
  said: Array<{ text: string; priority: 'low' | 'high' }> = [];

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
  setVolume(volume: number): void {
    this.volume = volume;
  }
  setVoice(uri: string | null): void {
    this.voice = uri;
  }
  voices(): VoiceInfo[] {
    return [];
  }
  onVoicesChanged(): () => void {
    return () => {};
  }
  say(text: string, priority: 'low' | 'high' = 'low'): void {
    this.said.push({ text, priority });
  }
  cancel(): void {
    this.cancels++;
  }
  get texts(): string[] {
    return this.said.map((s) => s.text);
  }
}

export const NO_LOCK: LockStatus = { fullscreen: false, keyboardLocked: false, wakeLock: false, installed: false };

export class FakeLockdown implements Lockdown {
  current: LockStatus = { ...NO_LOCK };
  /** What enter() grants. */
  grant: Partial<LockStatus> = { fullscreen: true, keyboardLocked: true, wakeLock: true };
  enters: Array<{ lockKeyboard: boolean }> = [];
  exits = 0;
  confirmExit: boolean[] = [];
  guards = 0;
  private readonly listeners = new Set<(s: LockStatus) => void>();

  enter(options: { lockKeyboard: boolean }): Promise<LockStatus> {
    this.enters.push(options);
    const next = { ...this.current, ...this.grant };
    return Promise.resolve().then(() => {
      this.set(next);
      return this.status();
    });
  }
  exit(): Promise<void> {
    this.exits++;
    this.set({ ...this.current, fullscreen: false, keyboardLocked: false, wakeLock: false });
    return Promise.resolve();
  }
  status(): LockStatus {
    return { ...this.current };
  }
  onChange(listener: (status: LockStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  setConfirmExit(enabled: boolean): void {
    this.confirmExit.push(enabled);
  }
  installGuards(): void {
    this.guards++;
  }
  /** Simulates a browser-side change (e.g. the toddler held Escape). */
  set(next: LockStatus): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.current);
    this.current = { ...next };
    if (changed) for (const l of [...this.listeners]) l(this.status());
  }
}

export class FakeKeyboard implements KeyboardInput {
  attached = false;
  enabled = true;
  secretWords: string[] = [];
  constructor(
    readonly handlers: KeyboardHandlers,
    secretWord: string,
  ) {
    this.secretWords.push(secretWord);
  }
  attach(): void {
    this.attached = true;
  }
  detach(): void {
    this.attached = false;
  }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
  setSecretWord(word: string): void {
    this.secretWords.push(word);
  }
}

export class FakePointer implements PointerInput {
  attached = false;
  enabled = true;
  constructor(readonly handlers: PointerHandlers) {}
  attach(): void {
    this.attached = true;
  }
  detach(): void {
    this.attached = false;
  }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

export class FakeStartScreen implements StartScreen {
  isVisible = true;
  constructor(readonly deps: StartScreenDeps) {}
  show(): void {
    this.isVisible = true;
  }
  hide(): void {
    this.isVisible = false;
  }
}

export class FakePanel implements ParentPanel {
  isOpen = false;
  opens = 0;
  constructor(readonly deps: ParentPanelDeps) {}
  open(): void {
    this.isOpen = true;
    this.opens++;
  }
  close(): void {
    this.isOpen = false;
  }
}

export class FakeOverlays implements Overlays {
  allDone: (() => void) | null = null;
  resume: (() => void) | null = null;
  resumeShows = 0;
  corner: number[] = [];
  toasts: string[] = [];
  showAllDone(onParentResume: () => void): void {
    this.allDone = onParentResume;
  }
  hideAllDone(): void {
    this.allDone = null;
  }
  showResume(onResume: () => void): void {
    this.resume = onResume;
    this.resumeShows++;
  }
  hideResume(): void {
    this.resume = null;
  }
  setCornerProgress(progress: number): void {
    this.corner.push(progress);
  }
  toast(message: string): void {
    this.toasts.push(message);
  }
}

export class FakeVisibility implements VisibilitySource {
  visible = true;
  private readonly listeners = new Set<() => void>();
  isVisible(): boolean {
    return this.visible;
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  set(visible: boolean): void {
    this.visible = visible;
    for (const l of [...this.listeners]) l();
  }
}

export class FakeQuery implements MediaQueryListLike {
  matches = false;
  private listener: (() => void) | null = null;
  addEventListener(_type: 'change', listener: () => void): void {
    this.listener = listener;
  }
  removeEventListener(): void {
    this.listener = null;
  }
  set(matches: boolean): void {
    this.matches = matches;
    this.listener?.();
  }
}

/** Lets pending promise callbacks run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Deterministic LCG in [0, 1). */
export function seeded(seed = 7): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
