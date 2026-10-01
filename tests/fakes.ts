/**
 * Test doubles for Game and integration tests (v2 contracts): every dependency
 * records what it was asked to do.
 */
import type { MediaQueryListLike, VisibilitySource } from '../src/game';
import type {
  AudioEngine,
  CardSpec,
  Challenge,
  EmojiSpec,
  HintLevel,
  KeyboardHandlers,
  KeyboardInput,
  LearningProgress,
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
  ProgressStore,
  PromptBar,
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

export interface SpecialCall {
  effect: SpecialEffect;
  options?: { at?: { x: number; y: number }; colors?: NamedColor[] };
}

export class FakeScene implements Scene {
  objectCount = 0;
  worlds: World[] = [];
  options: SceneOptions[] = [];
  calm: number[] = [];
  cards: Array<CardSpec & { id: number }> = [];
  shapes: ShapeSpec[] = [];
  emoji: EmojiSpec[] = [];
  bursts: Array<{ x: number; y: number; color: NamedColor; power?: number }> = [];
  ripples: Array<{ x: number; y: number; color: NamedColor }> = [];
  trails: Array<{ x: number; y: number; color: NamedColor; pointerId: number }> = [];
  endedTrails: number[] = [];
  specials: SpecialCall[] = [];
  pulses: number[] = [];
  pokes: Array<{ x: number; y: number }> = [];
  /** What poke() returns: a fixed result, or a function of the point. */
  pokeResult: PokeResult | null | ((x: number, y: number) => PokeResult | null) = null;
  private nextId = 1;

  setWorld(world: World): void {
    this.worlds.push(world);
  }
  setOptions(options: SceneOptions): void {
    this.options.push(options);
  }
  setCalm(level: number): void {
    this.calm.push(level);
  }
  showCard(spec: CardSpec): number {
    const id = this.nextId++;
    this.cards.push({ ...spec, id });
    return id;
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
  ripple(x: number, y: number, color: NamedColor): void {
    this.ripples.push({ x, y, color });
  }
  trail(x: number, y: number, color: NamedColor, pointerId: number): void {
    this.trails.push({ x, y, color, pointerId });
  }
  endTrail(pointerId: number): void {
    this.endedTrails.push(pointerId);
  }
  special(effect: SpecialEffect, options?: SpecialCall['options']): void {
    this.specials.push(options === undefined ? { effect } : { effect, options });
  }
  pulseCard(id: number): void {
    this.pulses.push(id);
  }
  poke(x: number, y: number): PokeResult | null {
    this.pokes.push({ x, y });
    return typeof this.pokeResult === 'function' ? this.pokeResult(x, y) : this.pokeResult;
  }
  update(): void {}
  draw(): void {}
  resize(): void {}

  get lastCard(): (CardSpec & { id: number }) | undefined {
    return this.cards[this.cards.length - 1];
  }
  get lastOptions(): SceneOptions {
    return this.options[this.options.length - 1];
  }
  get lastCalm(): number {
    return this.calm[this.calm.length - 1];
  }
  specialCount(effect: SpecialEffect): number {
    return this.specials.filter((s) => s.effect === effect).length;
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
  chords: Array<{ midis: number[]; options?: NoteOptions & { spread?: number } }> = [];
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
  chord(midis: number[], options?: NoteOptions & { spread?: number }): void {
    this.chords.push({ midis, options });
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

export interface SequenceCall {
  parts: string[];
  stepMs: number;
  then: string | null | undefined;
}

export class FakeSpeaker implements Speaker {
  readonly supported = true;
  enabled = true;
  volume = 1;
  voice: string | null = null;
  cancels = 0;
  /** Set by tests to simulate a sequence still running. */
  sequencing = false;
  said: Array<{ text: string; priority: 'low' | 'high' }> = [];
  sequences: SequenceCall[] = [];

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
  sequence(parts: string[], stepMs: number, then?: string | null): void {
    this.sequences.push({ parts: [...parts], stepMs, then });
  }
  cancel(): void {
    this.cancels++;
  }
  get texts(): string[] {
    return this.said.map((s) => s.text);
  }
  get lastSaid(): { text: string; priority: 'low' | 'high' } | undefined {
    return this.said[this.said.length - 1];
  }
  get lastSequence(): SequenceCall | undefined {
    return this.sequences[this.sequences.length - 1];
  }
}

export type PromptCall =
  | { op: 'show'; challenge: Challenge }
  | { op: 'update'; challenge: Challenge; hint: HintLevel }
  | { op: 'celebrate' }
  | { op: 'hide' };

export class FakePromptBar implements PromptBar {
  isVisible = false;
  calls: PromptCall[] = [];
  show(challenge: Challenge): void {
    this.isVisible = true;
    this.calls.push({ op: 'show', challenge });
  }
  update(challenge: Challenge, hint: HintLevel): void {
    this.calls.push({ op: 'update', challenge, hint });
  }
  celebrate(): void {
    this.calls.push({ op: 'celebrate' });
  }
  hide(): void {
    this.isVisible = false;
    this.calls.push({ op: 'hide' });
  }
  ops(op: PromptCall['op']): PromptCall[] {
    return this.calls.filter((c) => c.op === op);
  }
  get shown(): Challenge[] {
    return this.calls.flatMap((c) => (c.op === 'show' ? [c.challenge] : []));
  }
  get lastShown(): Challenge | undefined {
    const s = this.shown;
    return s[s.length - 1];
  }
  get updates(): Array<{ challenge: Challenge; hint: HintLevel }> {
    return this.calls.flatMap((c) => (c.op === 'update' ? [{ challenge: c.challenge, hint: c.hint }] : []));
  }
}

export class FakeProgress implements ProgressStore {
  data: LearningProgress = { seen: {}, found: {}, spelled: {}, since: null };
  resets = 0;
  private readonly listeners = new Set<(p: LearningProgress) => void>();
  get(): LearningProgress {
    return { seen: { ...this.data.seen }, found: { ...this.data.found }, spelled: { ...this.data.spelled }, since: this.data.since };
  }
  markSeen(symbol: string): void {
    this.bump(this.data.seen, symbol);
  }
  markFound(symbol: string): void {
    this.bump(this.data.found, symbol);
  }
  markSpelled(word: string): void {
    this.bump(this.data.spelled, word);
  }
  reset(): void {
    this.resets++;
    this.data = { seen: {}, found: {}, spelled: {}, since: null };
    this.notify();
  }
  subscribe(listener: (p: LearningProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private bump(map: Record<string, number>, key: string): void {
    map[key] = (map[key] ?? 0) + 1;
    if (this.data.since === null) this.data.since = 1;
    this.notify();
  }
  private notify(): void {
    for (const l of [...this.listeners]) l(this.get());
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
  get listenerCount(): number {
    return this.listeners.size;
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
  get listenerCount(): number {
    return this.listeners.size;
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
  get hasListener(): boolean {
    return this.listener !== null;
  }
}

/** Lets pending promise callbacks run. Works with real and fake timers (microtasks only). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Deterministic LCG in [0, 1). */
export function seeded(seed = 7): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
