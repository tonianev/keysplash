/**
 * ClipVoice: the built-in natural voice (VOICE.md §Runtime voice).
 *
 * Every line KeySplash says was synthesised once at build time (Kokoro) and
 * shipped as a small mp3 in ./voice/, precached for offline use. A line is
 * played from its own clip, or sentence by sentence; a line with no clips goes
 * to the `fallback` speaker (the device voice), or stays silent.
 *
 * Clips are fetched from the app's own origin, decoded through the audio
 * engine (so they share master volume, fade and limiter) and kept in a small
 * LRU. Playback is scheduled on AudioContext time, so counting stays even.
 * Clips are handed to the engine just before they are due (SCHEDULE_AHEAD),
 * which keeps the engine's live-clip count small even for long sequences.
 */
import { letterName } from '../content';
import { lines } from '../phrases';
import type { Speaker, VoiceInfo, VoiceOutput, VoicePlayback } from '../types';
import { resolveClips } from '../voice/normalize';

export interface ClipManifest {
  clips: Record<string, [string, number]>;
}

export interface ClipTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ClipVoiceOptions {
  /** Where the clips live (default './voice/'). */
  baseUrl?: string;
  /** Speaker for lines without clips (the device voice). */
  fallback?: Speaker | null;
  fetchFn?: typeof fetch;
  /** Monotonic clock in ms. */
  now?: () => number;
  timers?: ClipTimers;
  /** Decoded clips kept in memory (default 120). */
  cacheSize?: number;
  /** Lines prefetched by warm(). */
  warmLines?: string[];
}

/** A low-priority say within this long of the previous one is dropped (ms). */
const MIN_GAP_MS = 300;
/** Gap between sentences of one line (s). */
const SENTENCE_GAP = 0.07;
/** Pause between the last sequence part and the closing line (s). */
const THEN_GAP = 0.25;
/** A sequence whose clips take longer than this to load is dropped (ms). */
export const SEQUENCE_LOAD_LIMIT_MS = 600;
/** A single line that takes longer than this to load is dropped: late words confuse (ms). */
export const SAY_LOAD_LIMIT_MS = 1000;
/** Clips are handed to the engine this long before they are due (s). */
const SCHEDULE_AHEAD = 0.15;
/** Small offset so the first clip never starts in the past (s). */
const LEAD = 0.02;
const MAX_SEQUENCE = 12;
const WARM_CONCURRENCY = 4;
const DEFAULT_CACHE = 120;

/** Letters (solo), number words 1–10 and the common short lines. */
export function defaultWarmLines(): string[] {
  const out: string[] = [];
  for (let c = 65; c <= 90; c++) out.push(lines.letter(letterName(String.fromCharCode(c))));
  for (const w of ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']) out.push(lines.number(w));
  out.push(lines.greeting(), lines.yay(), 'Yes!', lines.hello());
  return out;
}

const DEFAULT_TIMERS: ClipTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function defaultClock(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function defaultFetch(): typeof fetch | null {
  return typeof fetch === 'function' ? fetch.bind(globalThis) : null;
}

/** One clip placed on the context timeline. */
interface Slot {
  buffer: AudioBuffer;
  at: number;
}

export class ClipVoice implements Speaker {
  readonly supported = true;
  private readonly clips: Record<string, [string, number]>;
  private readonly baseUrl: string;
  private readonly fallback: Speaker | null;
  private readonly fetchFn: typeof fetch | null;
  private readonly now: () => number;
  private readonly timers: ClipTimers;
  private readonly cacheSize: number;
  private readonly warmLines: readonly string[];
  /** Decoded clips by id; Map order = least recently used first. */
  private readonly cache = new Map<string, AudioBuffer>();
  private readonly inflight = new Map<string, Promise<AudioBuffer | null>>();
  /** Clips handed to the engine and not yet ended. */
  private readonly playing = new Set<VoicePlayback>();
  /** Pending timers (scheduled clips, load limits, sequence end). */
  private readonly pending = new Set<unknown>();
  private enabled = true;
  /** Bumped by cancel(); async work started under an older value is dropped. */
  private generation = 0;
  /** A line's clips are loading (counts as busy for low-priority says). */
  private loading = false;
  private seqActive = false;
  private lastSayAt = -Infinity;
  /** Context time when the last scheduled clip ends. */
  private busyUntil = 0;

  constructor(
    private readonly output: VoiceOutput,
    manifest: ClipManifest,
    options: ClipVoiceOptions = {},
  ) {
    this.clips = manifest?.clips ?? {};
    const base = options.baseUrl ?? './voice/';
    this.baseUrl = base.endsWith('/') ? base : `${base}/`;
    this.fallback = options.fallback ?? null;
    this.fetchFn = options.fetchFn ?? defaultFetch();
    this.now = options.now ?? defaultClock;
    this.timers = options.timers ?? DEFAULT_TIMERS;
    this.cacheSize = Math.max(1, Math.floor(options.cacheSize ?? DEFAULT_CACHE));
    this.warmLines = options.warmLines ?? defaultWarmLines();
  }

  get sequencing(): boolean {
    return this.seqActive;
  }

  /** Decoded clips held in memory (tests/diagnostics). */
  get cached(): number {
    return this.cache.size;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = !!enabled;
    if (!this.enabled) this.cancel();
  }

  /** Clips already follow the engine's master volume. */
  setVolume(_volume: number): void {
    // Intentionally empty.
  }

  setVoice(uri: string | null): void {
    this.fallback?.setVoice(uri);
  }

  voices(): VoiceInfo[] {
    return this.fallback?.voices() ?? [];
  }

  onVoicesChanged(listener: () => void): () => void {
    return this.fallback?.onVoicesChanged(listener) ?? (() => {});
  }

  /** Stops what is playing, everything scheduled, and drops pending loads' playback. */
  cancel(): void {
    this.stopOwn();
    try {
      this.fallback?.cancel();
    } catch {
      // Best effort.
    }
  }

  private stopOwn(): void {
    this.generation++;
    for (const t of this.pending) this.timers.clear(t);
    this.pending.clear();
    for (const p of this.playing) {
      try {
        p.stop();
      } catch {
        // Already stopped.
      }
    }
    this.playing.clear();
    this.loading = false;
    this.seqActive = false;
    this.busyUntil = 0;
  }

  // -------------------------------------------------------------------------
  // Loading

  /** Fetch + decode one clip (deduped, cached). Null before audio unlock or on failure. */
  private load(id: string): Promise<AudioBuffer | null> {
    const hit = this.cache.get(id);
    if (hit) {
      this.cache.delete(id);
      this.cache.set(id, hit);
      return Promise.resolve(hit);
    }
    const running = this.inflight.get(id);
    if (running) return running;
    const fetchFn = this.fetchFn;
    if (!fetchFn || this.output.currentTime() === null) return Promise.resolve(null);
    let request: Promise<Response>;
    try {
      request = fetchFn(`${this.baseUrl}${encodeURIComponent(id)}.mp3`);
    } catch (error) {
      request = Promise.reject(error);
    }
    const p = Promise.resolve(request)
      .then((res) => (res && res.ok ? res.arrayBuffer() : null))
      .then((data) => (data ? this.output.decodeAudio(data) : null))
      .catch(() => null)
      .then((buffer) => {
        this.inflight.delete(id);
        if (buffer) this.remember(id, buffer);
        return buffer;
      });
    this.inflight.set(id, p);
    return p;
  }

  private remember(id: string, buffer: AudioBuffer): void {
    this.cache.delete(id);
    this.cache.set(id, buffer);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
  }

  /** Loads all ids; null if any fails. */
  private loadAll(ids: string[]): Promise<AudioBuffer[] | null> {
    return Promise.all(ids.map((id) => this.load(id))).then((buffers) =>
      buffers.every((b): b is AudioBuffer => !!b) ? buffers : null,
    );
  }

  // -------------------------------------------------------------------------
  // Speaking

  say(text: string, priority: 'low' | 'high' = 'low'): void {
    if (!this.enabled || typeof text !== 'string') return;
    const phrase = text.trim();
    if (!phrase) return;
    const now = this.now();
    if (priority === 'high') this.cancel();
    else if (this.isBusy(now)) return;
    const refs = resolveClips(phrase, this.clips);
    if (!refs) {
      this.fallback?.say(phrase, priority);
      return;
    }
    this.lastSayAt = now;
    this.loading = true;
    const gen = this.generation;
    const limit = this.after(SAY_LOAD_LIMIT_MS, () => {
      if (gen === this.generation && this.loading) this.stopOwn();
    });
    void this.loadAll(refs.map((r) => r.id)).then((buffers) => {
      if (gen !== this.generation) return;
      this.cancelTimer(limit);
      this.loading = false;
      const t0 = this.output.currentTime();
      if (!buffers || t0 === null) {
        this.fallback?.say(phrase, priority);
        return;
      }
      const slots: Slot[] = [];
      let at = t0 + LEAD;
      for (const buffer of buffers) {
        slots.push({ buffer, at });
        at += buffer.duration + SENTENCE_GAP;
      }
      this.playSlots(slots, gen);
    });
  }

  sequence(parts: string[], stepMs: number, then: string | null = null): void {
    this.cancel();
    if (!this.enabled || !Array.isArray(parts)) return;
    const list = parts.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()).slice(0, MAX_SEQUENCE);
    const tail = typeof then === 'string' && then.trim() ? then.trim() : null;
    if (list.length === 0 && !tail) return;
    const partRefs = list.map((p) => resolveClips(p, this.clips));
    const tailRefs = tail ? resolveClips(tail, this.clips) : [];
    if (partRefs.some((r) => !r) || !tailRefs) {
      this.fallback?.sequence(parts, stepMs, then);
      return;
    }
    const ids = new Set<string>();
    for (const refs of [...partRefs, tailRefs]) for (const r of refs ?? []) ids.add(r.id);
    this.seqActive = true;
    this.loading = true;
    const gen = this.generation;
    // Counting that starts late is worse than none: drop it if loading is slow.
    const limit = this.after(SEQUENCE_LOAD_LIMIT_MS, () => {
      if (gen === this.generation && this.loading) this.stopOwn();
    });
    const order = [...ids];
    void this.loadAll(order).then((buffers) => {
      if (gen !== this.generation) return;
      this.cancelTimer(limit);
      this.loading = false;
      const t0 = this.output.currentTime();
      if (!buffers || t0 === null) {
        this.seqActive = false;
        this.fallback?.sequence(parts, stepMs, then);
        return;
      }
      const byId = new Map(order.map((id, i) => [id, buffers[i]] as const));
      const step = Number.isFinite(stepMs) ? Math.max(0, stepMs) / 1000 : 0;
      const start = t0 + LEAD;
      const slots: Slot[] = [];
      let end = start;
      const place = (refs: Array<{ id: string }>, from: number): number => {
        let at = from;
        refs.forEach((r, k) => {
          const buffer = byId.get(r.id) as AudioBuffer;
          if (k > 0) at += SENTENCE_GAP;
          slots.push({ buffer, at });
          at += buffer.duration;
        });
        return at;
      };
      // Part i starts at start + i·step (never overlapping a long previous part).
      partRefs.forEach((refs, i) => {
        end = place(refs ?? [], i === 0 ? start : Math.max(start + i * step, end));
      });
      if (tail) end = place(tailRefs, list.length ? end + THEN_GAP : start);
      this.playSlots(slots, gen);
      this.after(Math.max(0, (end - t0) * 1000), () => {
        if (gen === this.generation) this.seqActive = false;
      });
    });
  }

  /** Prefetch and decode the common lines (after audio unlock). Bounded, low concurrency. */
  warm(): void {
    if (this.output.currentTime() === null) return;
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const line of this.warmLines) {
      for (const r of resolveClips(line, this.clips) ?? []) {
        if (seen.has(r.id) || this.cache.has(r.id)) continue;
        seen.add(r.id);
        ids.push(r.id);
      }
    }
    const queue = ids.slice(0, this.cacheSize);
    let next = 0;
    const pump = (): void => {
      if (next >= queue.length) return;
      void this.load(queue[next++]).then(pump);
    };
    for (let k = 0; k < WARM_CONCURRENCY; k++) pump();
  }

  // -------------------------------------------------------------------------

  private isBusy(now: number): boolean {
    if (this.seqActive || this.loading || now - this.lastSayAt < MIN_GAP_MS) return true;
    const t = this.output.currentTime();
    return t !== null && t < this.busyUntil;
  }

  /** Hands each clip to the engine shortly before it is due. */
  private playSlots(slots: Slot[], gen: number): void {
    const now = this.output.currentTime() ?? 0;
    for (const slot of slots) {
      this.busyUntil = Math.max(this.busyUntil, slot.at + slot.buffer.duration);
      const lead = slot.at - now - SCHEDULE_AHEAD;
      if (lead <= 0) this.playOne(slot, gen);
      else this.after(lead * 1000, () => this.playOne(slot, gen));
    }
  }

  private playOne(slot: Slot, gen: number): void {
    if (gen !== this.generation || !this.enabled) return;
    const playback = this.output.playVoice(slot.buffer, slot.at);
    if (!playback) return;
    this.playing.add(playback);
    void playback.ended.then(() => this.playing.delete(playback));
  }

  private after(ms: number, fn: () => void): unknown {
    const handle: unknown = this.timers.set(() => {
      this.pending.delete(handle);
      fn();
    }, ms);
    this.pending.add(handle);
    return handle;
  }

  private cancelTimer(handle: unknown): void {
    if (!this.pending.delete(handle)) return;
    this.timers.clear(handle);
  }
}
