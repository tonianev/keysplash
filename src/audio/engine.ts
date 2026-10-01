/**
 * WebAudioEngine: every sound in KeySplash, synthesised live (no audio files).
 *
 * Signal flow, built once on the first unlock() (which must come from a user gesture):
 *
 *   sources → envelopes → voice out (level) → panner ─┬─► dry ─────────────────┐
 *                                                     └─► send 18% → reverb ───┴─► master
 *   master (volume², mute) → fade (wind-down) → compressor → ceiling 0.8 → speakers
 *
 * Protecting little ears: each voice's level is divided by √(onsets within 40 ms),
 * no more than 18 voices sound at once (the oldest is faded out fast), and a
 * hard compressor plus a 0.8 ceiling sit in front of the destination.
 *
 * Before unlock() every method is a silent no-op, and no method ever throws.
 */
import type { AudioEngine, NoteOptions, SoundEffect, Timbre } from '../types';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Envelope floor. Exponential ramps cannot reach 0, so they start and end here. */
const SILENT = 0.0001;
export const MAX_VOICES = 18;
/** Seconds a stolen voice takes to fade out. */
const STEAL_FADE = 0.025;
/** Onsets closer together than this share loudness (seconds). */
const ONSET_WINDOW = 0.04;
const ONSET_CAPACITY = 32;
/** Per-voice peak at velocity 1, before master volume. Keeps one note near the limiter threshold. */
const VOICE_LEVEL = 0.16;
const DEFAULT_VELOCITY = 0.8;
/** Hard pans are harsh on headphones; keep a little of each side. */
const PAN_WIDTH = 0.8;
const REVERB_WET = 0.18;
const REVERB_SECONDS = 1.4;
const VOLUME_RAMP = 0.05;
const CEILING = 0.8;
/** Schedule slightly ahead so attacks never start in the past (which would click). */
const LOOKAHEAD = 0.005;
/** Extra time after a voice's envelope ends before its sources stop. */
const STOP_PAD = 0.03;
const MAX_CHORD = 8;
const DEFAULT_SPREAD = 0.06;
/** unlock() resolves after this even if the browser never settles resume(). */
const RESUME_TIMEOUT_MS = 400;
const MIDI_MIN = 24;
const MIDI_MAX = 108;

const PENTATONIC = [0, 2, 4, 7, 9];
/** Soft bell triad (E5 G5 C6) and the "ta-da" arpeggio (C5 E5 G5 C6), in C; shifted by setRoot(). */
const CHIME_NOTES = [76, 79, 84];
const TADA_NOTES = [72, 76, 79, 84];

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Loudness share of one voice when `onsets` voices start together: 1/√n. */
export function onsetScale(onsets: number): number {
  return 1 / Math.sqrt(Math.max(1, onsets));
}

/** Velocity (0..1) scaled down for a burst of simultaneous onsets. */
export function scaledVelocity(velocity: number, recentOnsets: number): number {
  return clamp01(velocity) * onsetScale(recentOnsets);
}

/** Perceptual volume curve: slider 0..1 → gain (volume²). */
export function volumeToGain(volume: number): number {
  const v = clamp01(volume);
  return v * v;
}

/**
 * Semitones (-5..6) from C to the pitch class of `rootMidi`. Melodic effects are
 * written in C and shifted by this, so they share the world's pentatonic scale.
 */
export function keyShift(rootMidi: number): number {
  if (!Number.isFinite(rootMidi)) return 0;
  const pc = ((Math.round(rootMidi) % 12) + 12) % 12;
  return pc > 6 ? pc - 12 : pc;
}

/** Semitone offset of a step up the major pentatonic scale (wraps octaves). */
export function pentatonicOffset(step: number): number {
  const s = Math.max(0, Math.floor(step));
  return PENTATONIC[s % 5] + 12 * Math.floor(s / 5);
}

/**
 * Fixed-size ring of recent onset times. `push` records one and returns how many
 * recorded onsets (itself included) fall within the window around it.
 */
export class OnsetWindow {
  private readonly times: Float64Array;
  private readonly window: number;
  private next = 0;

  constructor(capacity = ONSET_CAPACITY, windowSeconds = ONSET_WINDOW) {
    this.times = new Float64Array(Math.max(1, Math.floor(capacity))).fill(-Infinity);
    this.window = windowSeconds;
  }

  push(time: number): number {
    this.times[this.next] = time;
    this.next = (this.next + 1) % this.times.length;
    let count = 0;
    for (let i = 0; i < this.times.length; i++) {
      // Symmetric: a chord note scheduled a few ms ahead counts as simultaneous too.
      if (Math.abs(this.times[i] - time) < this.window) count++;
    }
    return count;
  }
}

export interface VoiceSlotInfo {
  readonly start: number;
  readonly end: number;
}

/**
 * Index of the slot a new voice should use: the first free one (empty, or its
 * voice has finished by `now`), otherwise the voice that started earliest.
 */
export function chooseVoiceSlot(slots: readonly (VoiceSlotInfo | null)[], now: number): number {
  let oldest = 0;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot || slot.end <= now) return i;
    const best = slots[oldest];
    if (best && slot.start < best.start) oldest = i;
  }
  return oldest;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// ---------------------------------------------------------------------------
// Voices and node helpers
// ---------------------------------------------------------------------------

interface Voice {
  readonly ctx: BaseAudioContext;
  readonly out: GainNode;
  readonly noise: AudioBuffer | null;
  /** Started sources, so a stolen voice can be stopped early. */
  readonly sources: AudioScheduledSourceNode[];
  /** Every node to disconnect once the voice has finished. */
  readonly nodes: AudioNode[];
  readonly level: number;
  start: number;
  /** Context time by which the voice is silent. */
  end: number;
  /** Sources that have not fired `ended` yet. */
  live: number;
  done: () => void;
}

/** Builds a voice's sound starting at `t`; returns the time it falls silent. */
type ToneBuilder = (v: Voice, t: number, freq: number, length: number) => number;
/** `shift` transposes melodic effects into the world's key (see keyShift). */
type EffectBuilder = (v: Voice, t: number, shift: number) => number;

/** Keep frequencies safely under Nyquist. */
function hz(v: Voice, freq: number): number {
  return Math.min(freq, v.ctx.sampleRate * 0.45);
}

function audible(v: Voice, freq: number): boolean {
  return freq < v.ctx.sampleRate * 0.45;
}

function track(v: Voice, src: AudioScheduledSourceNode): void {
  v.sources.push(src);
  v.nodes.push(src);
  v.live++;
  src.onended = v.done;
}

/** Click-free envelope: ~silence → `peak` (linear, `attack` s) → exponential decay to silence. */
function envelope(v: Voice, t: number, peak: number, attack: number, decay: number, dest: AudioNode): GainNode {
  const g = v.ctx.createGain();
  g.gain.value = SILENT;
  g.gain.setValueAtTime(SILENT, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(SILENT, t + attack + decay);
  g.connect(dest);
  v.nodes.push(g);
  return g;
}

function osc(v: Voice, type: OscillatorType, freq: number, t: number, stop: number, dest: AudioNode): OscillatorNode {
  const o = v.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.connect(dest);
  o.start(t);
  o.stop(stop);
  track(v, o);
  return o;
}

function filter(v: Voice, type: BiquadFilterType, freq: number, q: number, dest: AudioNode): BiquadFilterNode {
  const f = v.ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz(v, freq);
  f.Q.value = q;
  f.connect(dest);
  v.nodes.push(f);
  return f;
}

function gain(v: Voice, value: number, dest: AudioNode): GainNode {
  const g = v.ctx.createGain();
  g.gain.value = value;
  g.connect(dest);
  v.nodes.push(g);
  return g;
}

/** Plays the shared looping white-noise buffer from a random offset. */
function noise(v: Voice, t: number, stop: number, dest: AudioNode): void {
  const buffer = v.noise;
  if (!buffer) return;
  const src = v.ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.connect(dest);
  src.start(t, Math.random() * Math.max(0, buffer.duration - 0.1));
  src.stop(stop);
  track(v, src);
}

// ---------------------------------------------------------------------------
// Timbres (key notes)
// ---------------------------------------------------------------------------

/** [frequency ratio, peak, decay as a fraction of the note length] */
const BELL_PARTIALS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0.55, 1],
  [1.0035, 0.14, 0.85], // slightly detuned twin: slow shimmer
  [2.0, 0.22, 0.55],
  [3.0, 0.11, 0.35],
  [4.16, 0.09, 0.22], // inharmonic "bell" partial
];

const buildBell: ToneBuilder = (v, t, f, len) => {
  const attack = 0.004;
  const stop = t + attack + len + STOP_PAD;
  for (let i = 0; i < BELL_PARTIALS.length; i++) {
    const [ratio, peak, decay] = BELL_PARTIALS[i];
    if (!audible(v, f * ratio)) continue;
    osc(v, 'sine', f * ratio, t, stop, envelope(v, t, peak, attack, len * decay, v.out));
  }
  return t + attack + len;
};

const buildMarimba: ToneBuilder = (v, t, f, len) => {
  const attack = 0.003;
  const stop = t + attack + len + STOP_PAD;
  osc(v, 'sine', f, t, stop, envelope(v, t, 0.75, attack, len, v.out));
  if (audible(v, f * 3.93)) {
    const bright = Math.min(0.09, len * 0.15);
    osc(v, 'sine', f * 3.93, t, t + bright + STOP_PAD, envelope(v, t, 0.28, 0.002, bright, v.out));
  }
  // Soft mallet: a 25 ms puff of band-passed noise.
  const click = envelope(v, t, 0.3, 0.001, 0.025, v.out);
  noise(v, t, t + 0.05, filter(v, 'bandpass', clamp(f * 5.5, 1500, 7000), 1.4, click));
  return t + attack + len;
};

const buildPluck: ToneBuilder = (v, t, f, len) => {
  const attack = 0.003;
  const stop = t + attack + len + STOP_PAD;
  const env = envelope(v, t, 0.6, attack, len, v.out);
  // Bright at the pluck, then the lowpass closes fast like a damped string.
  const lp = filter(v, 'lowpass', f * 12, 1.5, env);
  lp.frequency.setValueAtTime(hz(v, f * 12), t);
  lp.frequency.exponentialRampToValueAtTime(hz(v, Math.max(f * 1.4, 150)), t + 0.25);
  osc(v, 'triangle', f, t, stop, lp);
  const saw = osc(v, 'sawtooth', f, t, stop, gain(v, 0.35, lp));
  saw.detune.value = 5;
  return t + attack + len;
};

/** A sine that rises ×0.7 → ×1.15 in 70 ms, then settles on pitch: a round "bloop". */
function bloop(v: Voice, f: number, t: number, stop: number, dest: AudioNode): void {
  const o = osc(v, 'sine', f * 0.7, t, stop, dest);
  o.frequency.exponentialRampToValueAtTime(f * 1.15, t + 0.07);
  o.frequency.setTargetAtTime(f, t + 0.07, 0.05);
}

const buildBubble: ToneBuilder = (v, t, f, len) => {
  const attack = 0.006;
  bloop(v, f, t, t + attack + len + STOP_PAD, envelope(v, t, 0.8, attack, len, v.out));
  if (audible(v, f * 2.3)) {
    const body = len * 0.35;
    bloop(v, f * 2, t, t + body + STOP_PAD, envelope(v, t, 0.16, 0.004, body, v.out));
  }
  return t + attack + len;
};

const buildKalimba: ToneBuilder = (v, t, f, len) => {
  const attack = 0.002;
  const stop = t + attack + len + STOP_PAD;
  osc(v, 'sine', f, t, stop, envelope(v, t, 0.6, attack, len, v.out));
  if (audible(v, f * 2.006)) {
    osc(v, 'sine', f * 2.006, t, stop, envelope(v, t, 0.17, attack, len * 0.45, v.out));
  }
  // Metallic tine: two short inharmonic partials.
  if (audible(v, f * 5.95)) osc(v, 'sine', f * 5.95, t, t + 0.1, envelope(v, t, 0.2, 0.001, 0.045, v.out));
  if (audible(v, f * 8.2)) osc(v, 'sine', f * 8.2, t, t + 0.08, envelope(v, t, 0.08, 0.001, 0.025, v.out));
  return t + attack + len;
};

const buildSoft: ToneBuilder = (v, t, f, len) => {
  const attack = 0.07;
  const stop = t + attack + len + STOP_PAD;
  const lp = filter(v, 'lowpass', 1800, 0.5, envelope(v, t, 0.75, attack, len, v.out));
  osc(v, 'triangle', f, t, stop, lp);
  const twin = osc(v, 'triangle', f, t, stop, gain(v, 0.35, lp));
  twin.detune.value = 6;
  return t + attack + len;
};

interface TimbreSpec {
  /** Default decay length (seconds). */
  length: number;
  /** Loudness trim so every timbre sits at a similar level. */
  gain: number;
  build: ToneBuilder;
}

const TIMBRES: Record<Timbre, TimbreSpec> = {
  bell: { length: 1.6, gain: 1, build: buildBell },
  marimba: { length: 0.7, gain: 1.05, build: buildMarimba },
  pluck: { length: 0.9, gain: 1, build: buildPluck },
  bubble: { length: 0.35, gain: 1.05, build: buildBubble },
  kalimba: { length: 1.3, gain: 1.05, build: buildKalimba },
  soft: { length: 1.6, gain: 0.75, build: buildSoft },
};

// ---------------------------------------------------------------------------
// Sound effects
// ---------------------------------------------------------------------------

const buildPop: EffectBuilder = (v, t) => {
  const o = osc(v, 'sine', 900, t, t + 0.12, envelope(v, t, 0.8, 0.002, 0.09, v.out));
  o.frequency.exponentialRampToValueAtTime(180, t + 0.07);
  const click = envelope(v, t, 0.22, 0.001, 0.012, v.out);
  noise(v, t, t + 0.04, filter(v, 'bandpass', 2400, 0.9, click));
  return t + 0.092;
};

const buildBubbleFx: EffectBuilder = (v, t) => {
  const o = osc(v, 'sine', 300, t, t + 0.2, envelope(v, t, 0.75, 0.005, 0.16, v.out));
  o.frequency.exponentialRampToValueAtTime(900, t + 0.12);
  return t + 0.165;
};

const buildBoing: EffectBuilder = (v, t) => {
  const len = 0.45;
  const stop = t + len + STOP_PAD;
  const o = osc(v, 'sine', 240, t, stop, envelope(v, t, 0.8, 0.004, len, v.out));
  o.frequency.exponentialRampToValueAtTime(205, t + len);
  // Springy vibrato: wide and slow at first, narrowing and quickening as it settles.
  const depth = v.ctx.createGain();
  depth.gain.value = 60;
  depth.gain.setValueAtTime(60, t);
  depth.connect(o.frequency);
  v.nodes.push(depth);
  depth.gain.exponentialRampToValueAtTime(2, t + len);
  const lfo = osc(v, 'sine', 9, t, stop, depth);
  lfo.frequency.linearRampToValueAtTime(15, t + len);
  return t + 0.004 + len;
};

function sweep(v: Voice, t: number, from: number, to: number, q: number, attack: number, decay: number, peak: number): number {
  const len = attack + decay;
  const bp = filter(v, 'bandpass', from, q, envelope(v, t, peak, attack, decay, v.out));
  bp.frequency.setValueAtTime(hz(v, from), t);
  bp.frequency.exponentialRampToValueAtTime(hz(v, to), t + len);
  noise(v, t, t + len + STOP_PAD, bp);
  return t + len;
}

const buildWhoosh: EffectBuilder = (v, t) => sweep(v, t, 300, 2500, 1.3, 0.2, 0.4, 0.9);
const buildSwoosh: EffectBuilder = (v, t) => sweep(v, t, 800, 5000, 1.6, 0.07, 0.23, 0.85);

/** A quick rising run of 4–6 high pentatonic blips over ~0.3 s. */
const buildSparkle: EffectBuilder = (v, t, shift) => {
  const count = 4 + Math.floor(Math.random() * 3);
  const spacing = 0.3 / count;
  let step = Math.floor(Math.random() * 3);
  let end = t;
  for (let i = 0; i < count; i++, step++) {
    const at = t + i * spacing;
    const f = hz(v, midiToFrequency(84 + shift + pentatonicOffset(step)));
    osc(v, 'sine', f, at, at + 0.16 + STOP_PAD, envelope(v, at, 0.32, 0.002, 0.16, v.out));
    end = at + 0.162;
  }
  return end;
};

const buildThud: EffectBuilder = (v, t) => {
  const low = osc(v, 'sine', 140, t, t + 0.25, envelope(v, t, 0.85, 0.004, 0.22, v.out));
  low.frequency.exponentialRampToValueAtTime(90, t + 0.05);
  // An octave above so it is still heard on small laptop speakers.
  const body = osc(v, 'sine', 280, t, t + 0.14, envelope(v, t, 0.28, 0.004, 0.1, v.out));
  body.frequency.exponentialRampToValueAtTime(180, t + 0.05);
  return t + 0.224;
};

const buildTwinkle: EffectBuilder = (v, t, shift) => {
  // Scale degrees 2..6 above C6 (E6…D7 before the key shift).
  const f = hz(v, midiToFrequency(84 + shift + pentatonicOffset(2 + Math.floor(Math.random() * 5))));
  osc(v, 'sine', f, t, t + 0.25 + STOP_PAD, envelope(v, t, 0.5, 0.003, 0.25, v.out));
  if (audible(v, f * 2)) osc(v, 'sine', f * 2, t, t + 0.12, envelope(v, t, 0.1, 0.002, 0.08, v.out));
  return t + 0.253;
};

type SingleVoiceEffect = Exclude<SoundEffect, 'chime' | 'tada'>;

const EFFECTS: Record<SingleVoiceEffect, { gain: number; build: EffectBuilder }> = {
  pop: { gain: 1, build: buildPop },
  bubble: { gain: 0.9, build: buildBubbleFx },
  boing: { gain: 0.9, build: buildBoing },
  whoosh: { gain: 1.3, build: buildWhoosh },
  swoosh: { gain: 1.1, build: buildSwoosh },
  sparkle: { gain: 0.9, build: buildSparkle },
  thud: { gain: 1.2, build: buildThud },
  twinkle: { gain: 0.45, build: buildTwinkle },
};

function has<K extends string>(record: Record<K, unknown>, key: string): key is K {
  return Object.prototype.hasOwnProperty.call(record, key);
}

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

function makeNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** Stereo noise with an exponential decay that darkens as it fades: a small, soft room. */
function makeImpulseResponse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(2, Math.floor(rate * seconds));
  const ir = ctx.createBuffer(2, length, rate);
  const predelay = Math.floor(rate * 0.012);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    let smoothed = 0;
    for (let i = predelay; i < length; i++) {
      const p = i / length;
      // One-pole lowpass whose cutoff falls through the tail.
      smoothed += (0.85 - 0.7 * p) * (Math.random() * 2 - 1 - smoothed);
      // ≈ -60 dB by the end, shaped to reach exactly zero (no truncation click).
      data[i] = smoothed * Math.exp(-6 * p) * (1 - p);
    }
  }
  return ir;
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function findAudioContext(): AudioContextCtor | null {
  const g = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/** Ramp from the param's current value (no jump if a ramp is mid-flight). */
function rampTo(param: AudioParam, target: number, now: number, seconds: number): void {
  const current = param.value;
  param.cancelScheduledValues(now);
  param.setValueAtTime(current, now);
  param.linearRampToValueAtTime(target, now + Math.max(0.005, seconds));
}

const NO_OPTIONS: NoteOptions = Object.freeze({});

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class WebAudioEngine implements AudioEngine {
  private ctx: AudioContext | null = null;
  /** Every voice mixes into this bus (dry path + reverb send). */
  private bus: GainNode | null = null;
  private master: GainNode | null = null;
  private fade: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private readonly slots: (Voice | null)[] = new Array<Voice | null>(MAX_VOICES).fill(null);
  private readonly onsets = new OnsetWindow();
  private volume = 0.8;
  private muted = false;
  private fadeLevel = 1;
  private timbre: Timbre = 'bell';
  /** Key shift for melodic effects (see keyShift); 0 = C. */
  private shift = 0;
  /** In-flight resume wait shared by repeated unlock() calls. */
  private resuming: Promise<void> | null = null;
  /** Building the graph failed once; stay silent rather than leak contexts. */
  private broken = false;

  get ready(): boolean {
    return this.ctx !== null && this.bus !== null && this.ctx.state === 'running';
  }

  /** Voices still sounding (for diagnostics and tests). */
  get activeVoices(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    let n = 0;
    for (const v of this.slots) if (v && v.end > ctx.currentTime) n++;
    return n;
  }

  /**
   * Creates the context on first call and resumes it whenever it is not running.
   * Creation and resume() happen synchronously, inside the caller's gesture; the
   * returned promise settles within ~0.4 s even if the browser never resolves resume().
   */
  unlock(): Promise<void> {
    try {
      let ctx = this.ctx;
      if (ctx && ctx.state === 'closed') {
        this.reset();
        ctx = null;
      }
      if (!ctx && !this.broken) ctx = this.create();
      if (!ctx || ctx.state === 'running') return Promise.resolve();
      // Call resume() (and prime iOS) on every gesture: a call made outside a
      // gesture stays pending, and only a later in-gesture call starts the context.
      this.primeOutput(ctx);
      const resumed = ctx.resume() as Promise<void> | undefined;
      if (!resumed || typeof resumed.then !== 'function') return Promise.resolve();
      // Share one bounded wait while resuming, so a mashed keyboard cannot pile up timers.
      if (!this.resuming) {
        this.resuming = Promise.race([
          resumed.then(noop, noop),
          new Promise<void>((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS)),
        ]).then(() => {
          this.resuming = null;
        });
      }
      return this.resuming;
    } catch {
      return Promise.resolve();
    }
  }

  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.volume = clamp01(volume);
    this.applyMaster();
  }

  setMuted(muted: boolean): void {
    this.muted = !!muted;
    this.applyMaster();
  }

  setTimbre(timbre: Timbre): void {
    if (typeof timbre === 'string' && has(TIMBRES, timbre)) this.timbre = timbre;
  }

  setRoot(rootMidi: number): void {
    if (isFiniteNumber(rootMidi)) this.shift = keyShift(rootMidi);
  }

  note(midi: number, options: NoteOptions = NO_OPTIONS): void {
    this.play(midi, this.timbre, options ?? NO_OPTIONS, 0, 1);
  }

  chord(midis: number[], options: NoteOptions & { spread?: number } = NO_OPTIONS): void {
    if (!this.live() || !Array.isArray(midis)) return;
    const opts = options ?? NO_OPTIONS;
    const notes: number[] = [];
    for (let i = 0; i < midis.length && notes.length < MAX_CHORD; i++) {
      if (isFiniteNumber(midis[i])) notes.push(midis[i]);
    }
    if (notes.length === 0) return;
    notes.sort((a, b) => a - b);
    const spread = isFiniteNumber(opts.spread) ? clamp(opts.spread, 0, 0.5) : DEFAULT_SPREAD;
    // Long chords overlap their tails; trim each note a little.
    const trim = 1 / Math.pow(notes.length, 0.25);
    for (let i = 0; i < notes.length; i++) this.play(notes[i], this.timbre, opts, i * spread, trim);
  }

  effect(name: SoundEffect, options: NoteOptions = NO_OPTIONS): void {
    if (!this.live()) return;
    const opts = options ?? NO_OPTIONS;
    if (name === 'chime') {
      for (let i = 0; i < CHIME_NOTES.length; i++) this.play(CHIME_NOTES[i] + this.shift, 'bell', opts, i * 0.03, 0.55);
    } else if (name === 'tada') {
      for (let i = 0; i < TADA_NOTES.length; i++) this.play(TADA_NOTES[i] + this.shift, this.timbre, opts, i * 0.08, 0.8);
      this.playEffect('sparkle', opts, TADA_NOTES.length * 0.08, 0.6);
    } else if (typeof name === 'string' && has(EFFECTS, name)) {
      this.playEffect(name, opts, 0, 1);
    }
  }

  fadeTo(level: number, seconds: number): void {
    if (!Number.isFinite(level)) return;
    this.fadeLevel = clamp01(level);
    const ctx = this.ctx;
    if (!ctx || !this.fade) return;
    try {
      rampTo(this.fade.gain, this.fadeLevel, ctx.currentTime, Number.isFinite(seconds) ? Math.max(0, seconds) : 0);
    } catch {
      // Never throw from audio.
    }
  }

  // -------------------------------------------------------------------------

  /**
   * The context while it is running, or while a resume is in flight (Firefox and
   * Safari report 'suspended' for a moment after the unlocking gesture, which would
   * swallow the first key). Otherwise null: a long-suspended context would replay
   * stale notes all at once when it finally resumes.
   */
  private live(): AudioContext | null {
    const ctx = this.ctx;
    if (!ctx || !this.bus) return null;
    return ctx.state === 'running' || (ctx.state === 'suspended' && this.resuming !== null) ? ctx : null;
  }

  private play(midi: number, timbre: Timbre, options: NoteOptions, delay: number, trim: number): void {
    const ctx = this.live();
    if (!ctx || !isFiniteNumber(midi)) return;
    const spec = TIMBRES[timbre];
    const length = isFiniteNumber(options.duration) && options.duration > 0 ? clamp(options.duration, 0.08, 4) : spec.length;
    const t = ctx.currentTime + LOOKAHEAD + delay;
    this.startVoice(ctx, t, spec.gain * trim, options, (v) =>
      spec.build(v, t, midiToFrequency(clamp(midi, MIDI_MIN, MIDI_MAX)), length),
    );
  }

  private playEffect(name: SingleVoiceEffect, options: NoteOptions, delay: number, trim: number): void {
    const ctx = this.live();
    if (!ctx) return;
    const spec = EFFECTS[name];
    const t = ctx.currentTime + LOOKAHEAD + delay;
    const shift = this.shift;
    this.startVoice(ctx, t, spec.gain * trim, options, (v) => spec.build(v, t, shift));
  }

  /** Allocates a voice slot (stealing the oldest if full), wires out → panner → bus and builds the sound. */
  private startVoice(ctx: AudioContext, t: number, trim: number, options: NoteOptions, build: (v: Voice) => number): void {
    const bus = this.bus;
    const velocity = isFiniteNumber(options.velocity) ? options.velocity : DEFAULT_VELOCITY;
    if (!bus || !(velocity > 0)) return;
    let voice: Voice | null = null;
    try {
      const level = VOICE_LEVEL * trim * scaledVelocity(velocity, this.onsets.push(t));
      const now = ctx.currentTime;
      const index = chooseVoiceSlot(this.slots, now);
      const previous = this.slots[index];
      if (previous && previous.end > now) this.steal(previous, now);

      const out = ctx.createGain();
      out.gain.value = level;
      const v: Voice = {
        ctx,
        out,
        noise: this.noiseBuffer,
        sources: [],
        nodes: [out],
        level,
        start: t,
        end: t,
        live: 0,
        done: noop,
      };
      v.done = () => {
        v.live--;
        if (v.live <= 0) this.retire(v);
      };
      voice = v;
      this.slots[index] = v;

      let tail: AudioNode = out;
      const pan = isFiniteNumber(options.pan) ? clamp(options.pan, -1, 1) * PAN_WIDTH : 0;
      if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
        const panner = ctx.createStereoPanner();
        panner.pan.value = pan;
        out.connect(panner);
        v.nodes.push(panner);
        tail = panner;
      }
      tail.connect(bus);

      v.end = build(v);
      if (v.live === 0) this.retire(v);
    } catch {
      if (voice) {
        if (voice.live === 0) this.retire(voice);
        else this.steal(voice, ctx.currentTime);
      }
    }
  }

  /** Fast-fades a voice and stops its sources; cleanup follows on their `ended`. */
  private steal(v: Voice, now: number): void {
    try {
      const g = v.out.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(v.level, now);
      g.linearRampToValueAtTime(0, now + STEAL_FADE);
    } catch {
      // Fall through to stopping the sources.
    }
    const stopAt = now + STEAL_FADE + 0.005;
    for (let i = 0; i < v.sources.length; i++) {
      try {
        v.sources[i].stop(stopAt);
      } catch {
        // Already stopped.
      }
    }
    v.end = Math.min(v.end, stopAt);
  }

  private retire(v: Voice): void {
    for (let i = 0; i < v.nodes.length; i++) {
      try {
        v.nodes[i].disconnect();
      } catch {
        // Already disconnected.
      }
    }
    v.nodes.length = 0;
    v.sources.length = 0;
    const index = this.slots.indexOf(v);
    if (index >= 0) this.slots[index] = null;
  }

  private applyMaster(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    try {
      rampTo(this.master.gain, this.muted ? 0 : volumeToGain(this.volume), ctx.currentTime, VOLUME_RAMP);
    } catch {
      // Never throw from audio.
    }
  }

  private create(): AudioContext | null {
    const Ctor = findAudioContext();
    if (!Ctor) return null;
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      ctx = new Ctor(); // old webkitAudioContext takes no options
    }
    try {
      this.buildGraph(ctx);
      return ctx;
    } catch {
      this.broken = true;
      this.reset();
      try {
        void ctx.close().catch(noop);
      } catch {
        // Nothing more to release.
      }
      return null;
    }
  }

  private buildGraph(ctx: AudioContext): void {
    const ceiling = ctx.createGain();
    ceiling.gain.value = CEILING;
    ceiling.connect(ctx.destination);

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -20;
    limiter.knee.value = 10;
    limiter.ratio.value = 10;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(ceiling);

    const fade = ctx.createGain();
    fade.gain.value = this.fadeLevel;
    fade.connect(limiter);

    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : volumeToGain(this.volume);
    master.connect(fade);

    const bus = ctx.createGain();
    bus.connect(master); // dry path
    try {
      const reverb = ctx.createConvolver();
      reverb.buffer = makeImpulseResponse(ctx, REVERB_SECONDS);
      const send = ctx.createGain();
      send.gain.value = REVERB_WET;
      bus.connect(send);
      send.connect(reverb);
      reverb.connect(master);
    } catch {
      // No reverb: the dry path still works.
    }

    try {
      this.noiseBuffer = makeNoise(ctx, 1);
    } catch {
      this.noiseBuffer = null;
    }
    this.ctx = ctx;
    this.master = master;
    this.fade = fade;
    this.bus = bus;
  }

  /** iOS only unlocks output once something actually plays inside the gesture. */
  private primeOutput(ctx: AudioContext): void {
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.onended = () => src.disconnect();
      src.start(0);
    } catch {
      // Best effort.
    }
  }

  private reset(): void {
    this.resuming = null;
    this.ctx = null;
    this.bus = null;
    this.master = null;
    this.fade = null;
    this.noiseBuffer = null;
    this.slots.fill(null);
  }
}

function noop(): void {
  // Intentionally empty.
}
