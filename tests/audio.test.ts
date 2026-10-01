import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_VOICES,
  OnsetWindow,
  WebAudioEngine,
  chooseVoiceSlot,
  keyShift,
  midiToFrequency,
  onsetScale,
  pentatonicOffset,
  scaledVelocity,
  volumeToGain,
} from '../src/audio/engine';
import { WebSpeaker, isNoveltyVoice, pickAutoVoice, rankVoices } from '../src/audio/speech';
import type { VoiceLike } from '../src/audio/speech';
import type { SoundEffect, Timbre } from '../src/types';

const TIMBRES: Timbre[] = ['felt', 'marimba', 'kalimba', 'celesta', 'harp', 'soft'];
const EFFECTS: SoundEffect[] = ['tap', 'pop', 'swipe', 'chime', 'success', 'retry', 'count', 'complete'];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('audio helpers', () => {
  it('maps a root note to the nearest key shift from C', () => {
    expect([60, 62, 64, 65, 67, 57, 59, 72, 66].map(keyShift)).toEqual([0, 2, 4, 5, -5, -3, -1, 0, 6]);
    expect(keyShift(Number.NaN)).toBe(0);
  });

  it('converts MIDI to frequency', () => {
    expect(midiToFrequency(69)).toBe(440);
    expect(midiToFrequency(60)).toBeCloseTo(261.63, 2);
    expect(midiToFrequency(81)).toBeCloseTo(880, 6);
  });

  it('scales velocity by 1/sqrt(simultaneous onsets)', () => {
    expect(onsetScale(0)).toBe(1);
    expect(onsetScale(1)).toBe(1);
    expect(onsetScale(4)).toBe(0.5);
    expect(scaledVelocity(0.8, 1)).toBeCloseTo(0.8);
    expect(scaledVelocity(0.8, 4)).toBeCloseTo(0.4);
    expect(scaledVelocity(5, 1)).toBe(1);
    expect(scaledVelocity(-1, 1)).toBe(0);
    expect(scaledVelocity(Number.NaN, 1)).toBe(0);
    // Ten equal notes at once carry the power of one note.
    const tenPower = 10 * scaledVelocity(1, 10) ** 2;
    expect(tenPower).toBeCloseTo(1);
  });

  it('counts onsets within the 40 ms window in a bounded ring', () => {
    const w = new OnsetWindow(8, 0.04);
    expect(w.push(1)).toBe(1);
    expect(w.push(1.01)).toBe(2);
    expect(w.push(1.03)).toBe(3);
    expect(w.push(1.2)).toBe(1); // far from the others
    // More onsets than capacity: the count saturates at capacity.
    let last = 0;
    for (let i = 0; i < 50; i++) last = w.push(5);
    expect(last).toBe(8);
  });

  it('uses a perceptual volume curve', () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(0.5)).toBe(0.25);
    expect(volumeToGain(1)).toBe(1);
    expect(volumeToGain(3)).toBe(1);
  });

  it('walks the major pentatonic scale across octaves', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(pentatonicOffset)).toEqual([0, 2, 4, 7, 9, 12, 14]);
  });

  it('picks a free voice slot, else the oldest', () => {
    expect(chooseVoiceSlot([null, null], 0)).toBe(0);
    expect(chooseVoiceSlot([{ start: 0, end: 5 }, null], 1)).toBe(1);
    expect(chooseVoiceSlot([{ start: 0, end: 5 }, { start: 0, end: 0.5 }], 1)).toBe(1);
    expect(chooseVoiceSlot([{ start: 0.3, end: 5 }, { start: 0.1, end: 5 }, { start: 0.2, end: 5 }], 1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fake Web Audio
// ---------------------------------------------------------------------------

/** Records misuse the real API would reject (the engine swallows exceptions, so we check this list). */
let audioErrors: string[] = [];

function fail(message: string): never {
  audioErrors.push(message);
  throw new RangeError(message);
}

class FakeParam {
  value: number;
  ramps: Array<{ kind: string; value: number; time: number }> = [];
  /** Values set with setValueAtTime, in order. */
  sets: number[] = [];
  constructor(value: number) {
    this.value = value;
  }
  private check(value: number, time: number): void {
    if (!Number.isFinite(value) || !Number.isFinite(time) || time < 0) fail(`non-finite automation ${value}@${time}`);
  }
  setValueAtTime(value: number, time: number): this {
    this.check(value, time);
    this.sets.push(value);
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.check(value, time);
    this.ramps.push({ kind: 'linear', value, time });
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number): this {
    this.check(value, time);
    if (value <= 0) fail('exponential ramp to a non-positive value');
    this.ramps.push({ kind: 'exp', value, time });
    return this;
  }
  setTargetAtTime(value: number, time: number, constant: number): this {
    this.check(value, time);
    if (!(constant > 0)) fail('bad time constant');
    return this;
  }
  cancelScheduledValues(time: number): this {
    this.check(0, time);
    return this;
  }
}

class FakeNode {
  readonly outputs = new Set<unknown>();
  constructor(readonly ctx: FakeAudioContext) {
    ctx.nodes.push(this);
  }
  connect<T>(dest: T): T {
    this.outputs.add(dest);
    return dest;
  }
  disconnect(): void {
    this.outputs.clear();
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}
class FakePanner extends FakeNode {
  pan = new FakeParam(0);
}
class FakeFilter extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
}
class FakeCompressor extends FakeNode {
  threshold = new FakeParam(-24);
  knee = new FakeParam(30);
  ratio = new FakeParam(12);
  attack = new FakeParam(0.003);
  release = new FakeParam(0.25);
}
class FakeConvolver extends FakeNode {
  buffer: unknown = null;
  normalize = true;
}

class FakeSource extends FakeNode {
  onended: (() => void) | null = null;
  startTime = -1;
  stopTime = Infinity;
  ended = false;
  start(time = 0): void {
    if (this.startTime >= 0) fail('started twice');
    this.startTime = time;
    this.ctx.sources.push(this);
  }
  stop(time = 0): void {
    if (this.startTime < 0) fail('stop before start');
    this.stopTime = time;
  }
}
class FakeOscillator extends FakeSource {
  type = 'sine';
  frequency = new FakeParam(440);
  detune = new FakeParam(0);
}
class FakeBufferSource extends FakeSource {
  buffer: FakeBuffer | null = null;
  loop = false;
  override start(time = 0): void {
    super.start(time);
    // A one-shot buffer ends on its own (e.g. the silent iOS unlock blip).
    if (!this.loop && this.buffer) this.stopTime = time + this.buffer.duration;
  }
}

class FakeBuffer {
  readonly duration: number;
  private readonly channels: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(i: number): Float32Array {
    return this.channels[i];
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  readonly sampleRate = 22050;
  currentTime = 0;
  state: string = 'suspended';
  readonly nodes: FakeNode[] = [];
  readonly sources: FakeSource[] = [];
  readonly destination: FakeNode;
  constructor(readonly options?: unknown) {
    this.destination = new FakeNode(this);
    FakeAudioContext.instances.push(this);
  }
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  createGain() { return new FakeGain(this); }
  createStereoPanner() { return new FakePanner(this); }
  createBiquadFilter() { return new FakeFilter(this); }
  createDynamicsCompressor() { return new FakeCompressor(this); }
  createConvolver() { return new FakeConvolver(this); }
  createOscillator() { return new FakeOscillator(this); }
  createBufferSource() { return new FakeBufferSource(this); }
  createBuffer(channels: number, length: number, rate: number) {
    if (length < 1) fail('empty buffer');
    return new FakeBuffer(channels, length, rate);
  }
  /** Moves time forward and fires `ended` on every source that has stopped. */
  advance(seconds: number): void {
    this.currentTime += seconds;
    for (const s of this.sources) {
      if (!s.ended && s.stopTime <= this.currentTime) {
        s.ended = true;
        s.onended?.();
      }
    }
  }
  /** Sources started but not yet ended. */
  liveSources(): number {
    return this.sources.filter((s) => !s.ended).length;
  }
  /** Walks back from the destination: ceiling ← compressor ← warmth lowpass ← fade ← master. */
  chain() {
    const feeding = (target: unknown) => this.nodes.find((n) => n.outputs.has(target));
    const ceiling = feeding(this.destination) as FakeGain;
    const compressor = feeding(ceiling) as FakeCompressor;
    const warmth = feeding(compressor) as FakeFilter;
    const fade = feeding(warmth) as FakeGain;
    const master = feeding(fade) as FakeGain;
    return { ceiling, compressor, warmth, fade, master };
  }
}

function lastRamp(param: FakeParam) {
  return param.ramps[param.ramps.length - 1];
}

// ---------------------------------------------------------------------------
// WebAudioEngine
// ---------------------------------------------------------------------------

describe('WebAudioEngine without Web Audio', () => {
  beforeEach(() => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('never throws and stays silent', async () => {
    const engine = new WebAudioEngine();
    const callEverything = () => {
      engine.setVolume(0.5);
      engine.setMuted(true);
      engine.setMuted(false);
      engine.setTimbre('marimba');
      engine.note(60, { velocity: 1, pan: -1, duration: 1 });
      engine.chord([60, 64, 67]);
      for (const fx of EFFECTS) engine.effect(fx);
      engine.fadeTo(0.25, 45);
    };
    expect(callEverything).not.toThrow();
    await expect(engine.unlock()).resolves.toBeUndefined();
    expect(engine.ready).toBe(false);
    expect(callEverything).not.toThrow();
  });
});

describe('WebAudioEngine with a fake AudioContext', () => {
  beforeEach(() => {
    audioErrors = [];
    FakeAudioContext.instances = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function unlocked(): Promise<{ engine: WebAudioEngine; ctx: FakeAudioContext }> {
    const engine = new WebAudioEngine();
    await engine.unlock();
    return { engine, ctx: FakeAudioContext.instances[0] };
  }

  it('is a no-op before unlock and creates no context', () => {
    const engine = new WebAudioEngine();
    engine.note(60);
    engine.effect('pop');
    engine.chord([60, 62]);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(engine.ready).toBe(false);
  });

  it('builds the limiter chain once and resumes on every unlock', async () => {
    const { engine, ctx } = await unlocked();
    expect(engine.ready).toBe(true);
    expect(ctx.options).toEqual({ latencyHint: 'interactive' });
    const { ceiling, compressor, fade, master } = ctx.chain();
    expect(ceiling.gain.value).toBe(0.8);
    expect(compressor.threshold.value).toBe(-20);
    expect(compressor.knee.value).toBe(10);
    expect(compressor.ratio.value).toBe(10);
    expect(compressor.attack.value).toBeCloseTo(0.003);
    expect(compressor.release.value).toBeCloseTo(0.25);
    const { warmth } = ctx.chain();
    expect(warmth).toBeInstanceOf(FakeFilter);
    expect(warmth.type).toBe('lowpass');
    expect(warmth.frequency.value).toBe(6000); // gentle master lowpass (DESIGN.md §5)
    expect(fade.gain.value).toBe(1);
    expect(master.gain.value).toBeCloseTo(0.64); // default volume 0.8, squared

    ctx.state = 'suspended';
    expect(engine.ready).toBe(false);
    await engine.unlock();
    expect(engine.ready).toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(audioErrors).toEqual([]);
  });

  it('applies settings made before unlock', async () => {
    const engine = new WebAudioEngine();
    engine.setVolume(0.5);
    engine.setMuted(true);
    engine.fadeTo(0.3, 2);
    await engine.unlock();
    const { fade, master } = FakeAudioContext.instances[0].chain();
    expect(master.gain.value).toBe(0);
    expect(fade.gain.value).toBeCloseTo(0.3);
  });

  it('ramps volume, mute and fade', async () => {
    const { engine, ctx } = await unlocked();
    const { fade, master } = ctx.chain();
    engine.setVolume(0.5);
    expect(lastRamp(master.gain)).toMatchObject({ kind: 'linear', value: 0.25 });
    expect(lastRamp(master.gain).time).toBeCloseTo(0.05);
    engine.setMuted(true);
    expect(lastRamp(master.gain).value).toBe(0);
    engine.setMuted(false);
    expect(lastRamp(master.gain).value).toBe(0.25);
    engine.fadeTo(0.25, 45);
    expect(lastRamp(fade.gain)).toMatchObject({ value: 0.25, time: 45 });
    engine.fadeTo(Number.NaN, 1);
    engine.setVolume(Number.NaN);
    expect(lastRamp(master.gain).value).toBe(0.25);
    expect(audioErrors).toEqual([]);
  });

  it('plays every timbre and effect with valid, click-free automation', async () => {
    const { engine, ctx } = await unlocked();
    for (const timbre of TIMBRES) {
      engine.setTimbre(timbre);
      for (const midi of [24, 48, 60, 72, 96, 108, 130, -5]) {
        engine.note(midi, { velocity: 0.9, pan: midi % 2 ? -0.5 : 0.5 });
        ctx.advance(0.5);
      }
      engine.note(60, { duration: 3 });
      engine.chord([60, 64, 67, 72], { spread: 0.08 });
      engine.effect('complete');
      ctx.advance(5);
    }
    for (const fx of EFFECTS) {
      engine.effect(fx, { pan: 0.3 });
      ctx.advance(2);
    }
    expect(audioErrors).toEqual([]);
    // Every source that started has finished and the voice table is empty.
    ctx.advance(10);
    expect(ctx.liveSources()).toBe(0);
    expect(engine.activeVoices).toBe(0);
  });

  it('keys melodic effects to the world root (setRoot)', async () => {
    const { engine, ctx } = await unlocked();
    const chimeFrequencies = (): number[] => {
      const before = ctx.sources.length;
      engine.effect('chime');
      const started = ctx.sources.slice(before).filter((s): s is FakeOscillator => s instanceof FakeOscillator);
      ctx.advance(3);
      // Chime uses the celesta: 3 partials per voice (1, 4, 2); take the fundamental.
      return started.filter((_, i) => i % 3 === 0).map((o) => o.frequency.sets[0]);
    };
    const inC = chimeFrequencies();
    expect(inC.map((f) => Math.round(f))).toEqual([76, 81].map((m) => Math.round(midiToFrequency(m))));
    engine.setRoot(65); // F: +5 semitones
    const inF = chimeFrequencies();
    expect(inF.map((f) => Math.round(f))).toEqual([81, 86].map((m) => Math.round(midiToFrequency(m))));
    engine.setRoot(Number.NaN); // ignored
    expect(chimeFrequencies().map((f) => Math.round(f))).toEqual(inF.map((f) => Math.round(f)));
    expect(audioErrors).toEqual([]);
  });

  it('ignores bad input without throwing', async () => {
    const { engine, ctx } = await unlocked();
    expect(() => {
      engine.note(Number.NaN);
      engine.note(Infinity);
      engine.note(60, { velocity: Number.NaN, pan: Number.NaN, duration: -1 });
      engine.note(60, { velocity: 0 });
      engine.chord([]);
      engine.chord([Number.NaN, 60, Infinity]);
      engine.chord(null as unknown as number[]);
      engine.effect('nope' as SoundEffect);
      engine.setTimbre('nope' as Timbre);
      engine.note(60, null as unknown as undefined);
    }).not.toThrow();
    expect(audioErrors).toEqual([]);
    // Sounding: velocity NaN → default, the one finite chord note, and null options → defaults.
    expect(engine.activeVoices).toBe(3);
    ctx.advance(5);
  });

  it('caps concurrent voices at 18 and fast-fades the oldest', async () => {
    const { engine, ctx } = await unlocked();
    engine.setTimbre('felt');
    // A toddler mashing 10 keys at 20 Hz for 3 seconds.
    for (let tick = 0; tick < 60; tick++) {
      for (let k = 0; k < 10; k++) engine.note(60 + k);
      expect(engine.activeVoices).toBeLessThanOrEqual(MAX_VOICES);
      ctx.advance(0.05);
    }
    expect(audioErrors).toEqual([]);
    // Stolen voices' sources were stopped early, so few sources are left running.
    const perVoice = 3; // felt: sine + triangle + hammer noise
    expect(ctx.liveSources()).toBeLessThanOrEqual(MAX_VOICES * perVoice);
    ctx.advance(10);
    expect(ctx.liveSources()).toBe(0);
    expect(engine.activeVoices).toBe(0);
  });

  it('disconnects every voice node after it finishes', async () => {
    const { engine, ctx } = await unlocked();
    const before = ctx.nodes.length;
    engine.note(60, { pan: 0.5 });
    engine.effect('swipe');
    const voiceNodes = ctx.nodes.slice(before);
    expect(voiceNodes.length).toBeGreaterThan(0);
    ctx.advance(5);
    expect(voiceNodes.every((n) => n.outputs.size === 0)).toBe(true);
  });

  it('turns a 10-key smash quieter per note', async () => {
    const { engine, ctx } = await unlocked();
    const before = ctx.nodes.length;
    engine.note(60);
    const single = (ctx.nodes[before] as FakeGain).gain.value; // voice out gain is created first
    ctx.advance(1);
    const marks: number[] = [];
    for (let k = 0; k < 10; k++) {
      marks.push(ctx.nodes.length);
      engine.note(60 + k);
    }
    const levels = marks.map((i) => (ctx.nodes[i] as FakeGain).gain.value);
    expect(levels[0]).toBeCloseTo(single);
    expect(levels[9]).toBeCloseTo(single / Math.sqrt(10));
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeLessThan(levels[i - 1]);
    ctx.advance(5);
  });

  it('settles unlock() even if resume() never resolves, without piling up waits', async () => {
    vi.useFakeTimers();
    try {
      const resume = vi.fn(() => new Promise<void>(() => {}));
      vi.spyOn(FakeAudioContext.prototype, 'resume').mockImplementation(resume);
      const engine = new WebAudioEngine();
      const first = engine.unlock();
      const second = engine.unlock();
      expect(second).toBe(first); // one shared wait
      expect(resume).toHaveBeenCalledTimes(2); // but resume() is retried on every gesture
      let settled = false;
      void first.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(true);
      expect(engine.ready).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the context and stays silent if the graph cannot be built', async () => {
    vi.spyOn(FakeAudioContext.prototype, 'createDynamicsCompressor').mockImplementation(() => {
      throw new Error('unsupported');
    });
    const close = vi.fn(() => Promise.resolve());
    (FakeAudioContext.prototype as unknown as { close: () => Promise<void> }).close = close;
    const engine = new WebAudioEngine();
    await engine.unlock();
    await engine.unlock();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(engine.ready).toBe(false);
    expect(() => engine.note(60)).not.toThrow();
    delete (FakeAudioContext.prototype as unknown as { close?: unknown }).close;
  });

  it('plays the key that unlocked audio even if the context starts asynchronously', async () => {
    vi.spyOn(FakeAudioContext.prototype, 'resume').mockImplementation(function (this: FakeAudioContext) {
      return Promise.resolve().then(() => {
        this.state = 'running';
      });
    });
    const engine = new WebAudioEngine();
    const unlocking = engine.unlock();
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.state).toBe('suspended');
    const before = ctx.sources.length;
    engine.note(60);
    expect(ctx.sources.length).toBeGreaterThan(before);
    await unlocking;
    expect(engine.ready).toBe(true);
  });

  it('does not play while the context is suspended', async () => {
    const { engine, ctx } = await unlocked();
    ctx.state = 'suspended';
    const before = ctx.sources.length;
    engine.note(60);
    engine.effect('pop');
    expect(ctx.sources.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

function voice(name: string, lang: string, localService = true, voiceURI = `uri:${name}`): VoiceLike {
  return { name, lang, voiceURI, localService };
}

describe('rankVoices', () => {
  it('orders English (US, GB, AU, other) first, then the rest by name', () => {
    const ranked = rankVoices([
      voice('Thomas', 'fr-FR'),
      voice('Karen', 'en-AU'),
      voice('Rishi', 'en-IN'),
      voice('Daniel', 'en-GB'),
      voice('Samantha', 'en-US'),
      voice('Anna', 'de-DE'),
      voice('Alex', 'en_US'),
    ]);
    expect(ranked.map((v) => v.name)).toEqual(['Alex', 'Samantha', 'Daniel', 'Karen', 'Rishi', 'Anna', 'Thomas']);
    expect(ranked[1]).toEqual({ uri: 'uri:Samantha', name: 'Samantha', lang: 'en-US', local: true });
  });

  it('filters macOS novelty voices but keeps Grandma/Grandpa', () => {
    const ranked = rankVoices([
      voice('Albert', 'en-US'),
      voice('Bad News', 'en-US'),
      voice('Zarvox', 'en-US'),
      voice('Pipe Organ', 'en-US'),
      voice('Whisper (English (United States))', 'en-US'),
      voice('Fred', 'en-US'),
      voice('Grandma (English (US))', 'en-US'),
      voice('Grandpa', 'en-GB'),
      voice('Samantha', 'en-US'),
    ]);
    expect(ranked.map((v) => v.name)).toEqual(['Grandma (English (US))', 'Samantha', 'Grandpa']);
    expect(isNoveltyVoice('Bubbles')).toBe(true);
    expect(isNoveltyVoice('Samantha')).toBe(false);
  });

  it('drops duplicate URIs', () => {
    expect(rankVoices([voice('Samantha', 'en-US'), voice('Samantha', 'en-US')])).toHaveLength(1);
  });
});

describe('pickAutoVoice', () => {
  it('prefers warm natural voices in order', () => {
    expect(pickAutoVoice([voice('Daniel', 'en-GB'), voice('Samantha', 'en-US'), voice('Alex', 'en-US')])).toBe('uri:Samantha');
    expect(pickAutoVoice([voice('Moira', 'en-IE'), voice('Karen', 'en-AU')])).toBe('uri:Karen');
  });

  it('matches names with suffixes', () => {
    const aria = voice('Microsoft Aria Online (Natural) - English (United States)', 'en-US', true);
    expect(pickAutoVoice([voice('Microsoft David - English (United States)', 'en-US'), aria])).toBe(aria.voiceURI);
  });

  it('prefers on-device voices over network voices', () => {
    const google = voice('Google US English', 'en-US', false);
    const zira = voice('Microsoft Zira - English (United States)', 'en-US', true);
    expect(pickAutoVoice([google, zira])).toBe(zira.voiceURI);
    // Only network English voices: never pick one automatically (no words leave the device).
    expect(pickAutoVoice([voice('Thomas', 'fr-FR'), google])).toBeNull();
  });

  it('falls back to the first local English voice, never a novelty one', () => {
    expect(pickAutoVoice([voice('Albert', 'en-US'), voice('Tessa', 'en-ZA'), voice('Alex', 'en-US')])).toBe('uri:Alex');
    expect(pickAutoVoice([voice('Albert', 'en-US'), voice('Thomas', 'fr-FR')])).toBeNull();
    expect(pickAutoVoice([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WebSpeaker
// ---------------------------------------------------------------------------

class FakeUtterance {
  rate = 1;
  pitch = 1;
  volume = 1;
  lang = '';
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}

class FakeSynth {
  speaking = false;
  pending = false;
  spoken: FakeUtterance[] = [];
  cancels = 0;
  /** An on-device English voice by default (speech stays on-device). */
  voiceList: VoiceLike[] = [{ name: 'Samantha', lang: 'en-US', voiceURI: 'uri:Samantha', localService: true }];
  private listeners: Array<() => void> = [];
  getVoices(): VoiceLike[] {
    return this.voiceList;
  }
  speak(u: FakeUtterance): void {
    this.spoken.push(u);
    this.speaking = true;
  }
  cancel(): void {
    this.cancels++;
    this.speaking = false;
    this.pending = false;
  }
  addEventListener(type: string, listener: () => void): void {
    if (type === 'voiceschanged') this.listeners.push(listener);
  }
  /** Finishes the current utterance normally. */
  finish(): void {
    this.speaking = false;
    this.spoken[this.spoken.length - 1]?.onend?.();
  }
  loadVoices(voices: VoiceLike[]): void {
    this.voiceList = voices;
    for (const l of this.listeners) l();
  }
}

describe('WebSpeaker', () => {
  let synth: FakeSynth;
  let clock: number;
  let speaker: WebSpeaker;

  beforeEach(() => {
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    synth = new FakeSynth();
    clock = 1000;
    speaker = new WebSpeaker(synth as unknown as SpeechSynthesis, () => clock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('speaks with a gentle rate and pitch', () => {
    expect(speaker.supported).toBe(true);
    speaker.say('  apple ');
    expect(synth.spoken).toHaveLength(1);
    const u = synth.spoken[0];
    expect(u.text).toBe('apple');
    expect(u.rate).toBeCloseTo(0.88);
    expect(u.pitch).toBeCloseTo(1.08);
    expect(u.lang).toBe('en-US');
  });

  it('skips low priority while speaking or within 300 ms', () => {
    speaker.say('a');
    clock += 500;
    speaker.say('b'); // still speaking
    expect(synth.spoken.map((u) => u.text)).toEqual(['a']);
    synth.finish();
    clock += 100;
    speaker.say('c'); // finished, 600 ms since 'a': allowed
    expect(synth.spoken.map((u) => u.text)).toEqual(['a', 'c']);
    synth.finish();
    clock += 200;
    speaker.say('d'); // 200 ms since 'c': too soon
    expect(synth.spoken.map((u) => u.text)).toEqual(['a', 'c']);
    synth.pending = true;
    clock += 1000;
    speaker.say('e'); // something pending
    expect(synth.spoken).toHaveLength(2);
  });

  it('high priority cancels and speaks immediately', () => {
    speaker.say('apple');
    clock += 10;
    speaker.say('Yay, Sam!', 'high');
    expect(synth.cancels).toBe(1);
    expect(synth.spoken.map((u) => u.text)).toEqual(['apple', 'Yay, Sam!']);
  });

  it('never stays stuck when the synth keeps claiming to speak', () => {
    speaker.say('ab'); // safety timeout: 2 × 120 + 2000 ms
    clock += 2000;
    speaker.say('blocked');
    expect(synth.spoken).toHaveLength(1);
    clock += 300; // past the timeout; synth.speaking is still true
    speaker.say('unstuck');
    expect(synth.cancels).toBe(1);
    expect(synth.spoken.map((u) => u.text)).toEqual(['ab', 'unstuck']);
  });

  it('is a no-op when disabled, empty or unsupported', () => {
    speaker.setEnabled(false);
    speaker.say('apple', 'high');
    speaker.setEnabled(true);
    speaker.say('   ');
    expect(synth.spoken).toHaveLength(0);

    const silent = new WebSpeaker(null);
    expect(silent.supported).toBe(false);
    expect(() => {
      silent.say('apple', 'high');
      silent.cancel();
      silent.setVolume(0.5);
      silent.setVoice('x');
    }).not.toThrow();
    expect(silent.voices()).toEqual([]);

    vi.stubGlobal('SpeechSynthesisUtterance', undefined);
    const noUtterance = new WebSpeaker(synth as unknown as SpeechSynthesis);
    expect(noUtterance.supported).toBe(false);
    noUtterance.say('apple');
    expect(synth.spoken).toHaveLength(0);
  });

  it('applies the volume to new utterances', () => {
    speaker.setVolume(0.4);
    speaker.say('one');
    expect(synth.spoken[0].volume).toBeCloseTo(0.4);
    speaker.setVolume(7);
    speaker.say('two', 'high');
    expect(synth.spoken[1].volume).toBe(1);
  });

  it('cancel() is always safe and frees the speaker', () => {
    speaker.cancel();
    speaker.say('one');
    speaker.cancel();
    clock += 400;
    speaker.say('two');
    expect(synth.spoken.map((u) => u.text)).toEqual(['one', 'two']);
  });

  it('loads voices asynchronously and picks one automatically', () => {
    synth.voiceList = [];
    const changed = vi.fn();
    const off = speaker.onVoicesChanged(changed);
    expect(speaker.voices()).toEqual([]);
    speaker.say('before'); // voices unknown yet: stay silent rather than risk a network voice
    expect(synth.spoken).toHaveLength(0);
    synth.spoken.push(new FakeUtterance('placeholder')); // keep the indices below stable

    synth.loadVoices([voice('Albert', 'en-US'), voice('Anna', 'de-DE'), voice('Samantha', 'en-US'), voice('Daniel', 'en-GB')]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(speaker.voices().map((v) => v.name)).toEqual(['Samantha', 'Daniel', 'Anna']);

    speaker.say('after', 'high');
    const u = synth.spoken[1];
    expect((u.voice as VoiceLike).name).toBe('Samantha');
    expect(u.lang).toBe('en-US');

    speaker.setVoice('uri:Daniel');
    speaker.say('chosen', 'high');
    expect((synth.spoken[2].voice as VoiceLike).name).toBe('Daniel');
    expect(synth.spoken[2].lang).toBe('en-GB');

    speaker.setVoice('uri:missing'); // falls back to the automatic choice
    speaker.say('fallback', 'high');
    expect((synth.spoken[3].voice as VoiceLike).name).toBe('Samantha');

    off();
    synth.loadVoices([]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('stays silent when only network voices exist, unless a grown-up picks one', () => {
    synth.voiceList = [{ name: 'Google US English', lang: 'en-US', voiceURI: 'uri:google', localService: false }];
    speaker.say('Hi, Emma!', 'high');
    expect(synth.spoken).toHaveLength(0); // the child's name never leaves the device unasked
    speaker.setVoice('uri:google'); // explicit choice in the panel ("· online")
    speaker.say('Hi, Emma!', 'high');
    expect(synth.spoken).toHaveLength(1);
  });

  it('uses onvoiceschanged when addEventListener is missing', () => {
    const bare = { speaking: false, pending: false, getVoices: () => [], speak() {}, cancel() {}, onvoiceschanged: null as null | (() => void) };
    const s = new WebSpeaker(bare as unknown as SpeechSynthesis);
    const changed = vi.fn();
    s.onVoicesChanged(changed);
    bare.onvoiceschanged?.();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// v2 effects and timbres
// ---------------------------------------------------------------------------

describe('WebAudioEngine v2 effects', () => {
  beforeEach(() => {
    audioErrors = [];
    FakeAudioContext.instances = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('never throws before unlock for every method, timbre and effect', () => {
    const engine = new WebAudioEngine();
    expect(() => {
      for (const timbre of TIMBRES) {
        engine.setTimbre(timbre);
        engine.note(60);
        engine.chord([60, 64, 67]);
      }
      for (const fx of EFFECTS) engine.effect(fx, { step: 3, pan: -1 });
      engine.setRoot(62);
      engine.setVolume(0.3);
      engine.setMuted(true);
      engine.fadeTo(0.5, 1);
    }).not.toThrow();
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(engine.ready).toBe(false);
    expect(engine.activeVoices).toBe(0);
  });

  async function unlocked(): Promise<{ engine: WebAudioEngine; ctx: FakeAudioContext }> {
    const engine = new WebAudioEngine();
    await engine.unlock();
    return { engine, ctx: FakeAudioContext.instances[0] };
  }

  function fundamentals(ctx: FakeAudioContext, before: number): number[] {
    return ctx.sources
      .slice(before)
      .filter((s): s is FakeOscillator => s instanceof FakeOscillator)
      .map((o) => Math.round(o.frequency.sets[0]));
  }

  it("'count' climbs the pentatonic scale with step and clamps bad steps", async () => {
    const { engine, ctx } = await unlocked();
    const first = (step: number | undefined): number => {
      const before = ctx.sources.length;
      engine.effect('count', step === undefined ? {} : { step });
      ctx.advance(3);
      return fundamentals(ctx, before)[0];
    };
    const f = [0, 1, 2, 3, 4, 5].map((s) => first(s));
    for (let i = 1; i < f.length; i++) expect(f[i]).toBeGreaterThan(f[i - 1]);
    expect(f[0]).toBe(Math.round(midiToFrequency(72)));
    expect(f[5]).toBe(Math.round(midiToFrequency(84)));
    expect(first(undefined)).toBe(f[0]);
    expect(first(Number.NaN)).toBe(f[0]);
    expect(first(-4)).toBe(f[0]);
    expect(first(999)).toBe(Math.round(midiToFrequency(72 + pentatonicOffset(12))));
    expect(audioErrors).toEqual([]);
  });

  it("'success' rises, 'complete' is a fuller phrase, 'retry' is soft and small", async () => {
    const { engine, ctx } = await unlocked();
    const voicesOf = (fx: SoundEffect): number => {
      const v0 = engine.activeVoices;
      engine.effect(fx);
      const n = engine.activeVoices - v0;
      ctx.advance(5);
      return n;
    };
    expect(voicesOf('success')).toBe(3);
    expect(voicesOf('complete')).toBe(5);
    expect(voicesOf('retry')).toBe(2);
    expect(voicesOf('chime')).toBe(2);
    for (const fx of ['tap', 'pop', 'swipe'] as SoundEffect[]) expect(voicesOf(fx)).toBe(1);

    // retry uses the warm 'soft' timbre (triangles), never a square/saw buzzer.
    const before = ctx.sources.length;
    engine.effect('retry');
    const types = ctx.sources.slice(before).filter((s): s is FakeOscillator => s instanceof FakeOscillator).map((o) => o.type);
    expect(types.length).toBeGreaterThan(0);
    expect(types.every((t) => t === 'triangle')).toBe(true);
    ctx.advance(5);

    // No effect ever uses a harsh waveform.
    const all = ctx.sources.filter((s): s is FakeOscillator => s instanceof FakeOscillator).map((o) => o.type);
    expect(all.some((t) => t === 'square' || t === 'sawtooth')).toBe(false);
    expect(audioErrors).toEqual([]);
  });

  it('every timbre plays one finite, in-range voice per note', async () => {
    const { engine, ctx } = await unlocked();
    for (const timbre of TIMBRES) {
      engine.setTimbre(timbre);
      engine.note(69, { velocity: 0.55 });
      expect(engine.activeVoices).toBe(1);
      ctx.advance(6);
      expect(engine.activeVoices).toBe(0);
    }
    expect(ctx.liveSources()).toBe(0);
    expect(audioErrors).toEqual([]);
  });
});

describe('WebSpeaker.sequence', () => {
  let synth: FakeSynth;
  let speaker: WebSpeaker;
  const texts = (): string[] => synth.spoken.map((u) => u.text);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    synth = new FakeSynth();
    const timers = {
      set: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    speaker = new WebSpeaker(synth as unknown as SpeechSynthesis, () => Date.now(), timers);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('speaks part i at i × step, then the closing phrase after the last part', () => {
    speaker.sequence(['one', 'two', 'three'], 700, 'three stars!');
    expect(speaker.sequencing).toBe(true);
    vi.advanceTimersByTime(0);
    expect(texts()).toEqual(['one']);
    vi.advanceTimersByTime(699);
    expect(texts()).toEqual(['one']);
    vi.advanceTimersByTime(1);
    expect(texts()).toEqual(['one', 'two']);
    vi.advanceTimersByTime(700);
    expect(texts()).toEqual(['one', 'two', 'three']);
    // 'then' comes after the last part's slot (3 × 700 + gap), never before.
    vi.advanceTimersByTime(699);
    expect(texts()).toEqual(['one', 'two', 'three']);
    vi.advanceTimersByTime(1000);
    expect(texts()).toEqual(['one', 'two', 'three', 'three stars!']);
    expect(speaker.sequencing).toBe(true); // still saying the closing phrase
    vi.advanceTimersByTime(5000);
    expect(speaker.sequencing).toBe(false);
  });

  it('skips low-priority say while sequencing but lets it through afterwards', () => {
    speaker.sequence(['red', 'orange'], 600);
    vi.advanceTimersByTime(100);
    speaker.say('cow');
    expect(texts()).toEqual(['red']);
    vi.advanceTimersByTime(10_000);
    expect(speaker.sequencing).toBe(false);
    synth.finish();
    speaker.say('cow');
    expect(texts()).toEqual(['red', 'orange', 'cow']);
  });

  it('a high-priority say aborts the sequence', () => {
    speaker.sequence(['one', 'two', 'three'], 700, 'three!');
    vi.advanceTimersByTime(10);
    speaker.say('Yes!', 'high');
    expect(speaker.sequencing).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(texts()).toEqual(['one', 'Yes!']);
  });

  it('cancel() aborts the sequence and clears every pending timer', () => {
    speaker.sequence(['one', 'two', 'three'], 700, 'done');
    vi.advanceTimersByTime(10);
    speaker.cancel();
    expect(speaker.sequencing).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(texts()).toEqual(['one']);
  });

  it('a new sequence replaces the previous one', () => {
    speaker.sequence(['one', 'two', 'three'], 700);
    vi.advanceTimersByTime(10);
    speaker.sequence(['a', 'b'], 100);
    vi.advanceTimersByTime(10_000);
    expect(texts()).toEqual(['one', 'a', 'b']);
    expect(speaker.sequencing).toBe(false);
  });

  it("'then' alone (zero — none!) is spoken immediately", () => {
    speaker.sequence([], 700, 'zero — none!');
    expect(speaker.sequencing).toBe(true);
    vi.advanceTimersByTime(0);
    expect(texts()).toEqual(['zero — none!']);
    vi.advanceTimersByTime(10_000);
    expect(speaker.sequencing).toBe(false);
  });

  it('is a no-op when disabled, unsupported, or given nothing to say', () => {
    speaker.setEnabled(false);
    speaker.sequence(['one'], 700, 'x');
    expect(speaker.sequencing).toBe(false);
    speaker.setEnabled(true);
    speaker.sequence(['  ', ''], 700, '  ');
    speaker.sequence(null as unknown as string[], 700);
    expect(speaker.sequencing).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(synth.spoken).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    const silent = new WebSpeaker(null);
    expect(() => silent.sequence(['one'], 700, 'x')).not.toThrow();
    expect(silent.sequencing).toBe(false);
  });

  it('bounds the number of scheduled parts and tolerates a bad step', () => {
    speaker.sequence(Array.from({ length: 100 }, (_, i) => `n${i}`), Number.NaN);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(14);
    vi.advanceTimersByTime(60_000);
    expect(synth.spoken.length).toBeLessThanOrEqual(12);
    expect(speaker.sequencing).toBe(false);
  });

  it('disabling mid-sequence stops it', () => {
    speaker.sequence(['one', 'two'], 700);
    vi.advanceTimersByTime(10);
    speaker.setEnabled(false);
    vi.advanceTimersByTime(10_000);
    expect(texts()).toEqual(['one']);
    expect(speaker.sequencing).toBe(false);
  });
});
