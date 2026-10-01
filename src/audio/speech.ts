/**
 * WebSpeaker: short spoken words ("A… apple!", "three", "blue star") via the
 * Web Speech API.
 *
 * Never stacks speech: at most one utterance is in flight. Low-priority lines
 * are dropped while something is being said; high-priority lines cut in.
 * Browsers sometimes lose the `end` event (Chrome garbage-collects unreferenced
 * utterances) or report `speaking` forever, so a per-utterance safety timeout
 * unsticks the synth on the next say().
 */
import type { Speaker, VoiceInfo } from '../types';

/** The fields of SpeechSynthesisVoice the ranking needs. */
export interface VoiceLike {
  readonly name: string;
  readonly lang: string;
  readonly voiceURI: string;
  readonly localService?: boolean;
}

const RATE = 0.92;
const PITCH = 1.15;
/** A low-priority say within this long of the previous say is dropped (ms). */
const MIN_GAP_MS = 300;
/** Safety timeout per utterance: text length × this + SAFETY_PAD_MS. */
const MS_PER_CHAR = 120;
const SAFETY_PAD_MS = 2000;
const FALLBACK_LANG = 'en-US';

/** macOS novelty / robotic voices, matched on the name before any " (…)" suffix. */
const NOVELTY_VOICES = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'good news',
  'jester', 'organ', 'pipe organ', 'superstar', 'trinoids', 'whisper', 'wobble',
  'zarvox', 'deranged', 'hysterical', 'fred', 'junior', 'ralph', 'kathy', 'princess',
]);

/** Warm, natural voices, best first. Matched as a name prefix (case-insensitive). */
const PREFERRED_VOICES = [
  'samantha',
  'google us english',
  'microsoft aria online (natural)',
  'microsoft jenny online (natural)',
  'karen',
  'moira',
  'serena',
  'daniel',
];

export function isNoveltyVoice(name: string): boolean {
  const lower = name.toLowerCase();
  const paren = lower.indexOf('(');
  return NOVELTY_VOICES.has((paren >= 0 ? lower.slice(0, paren) : lower).trim());
}

/** 0 en-US, 1 en-GB, 2 en-AU, 3 other English, 4 everything else. Accepts 'en_US' (Android). */
function langRank(lang: string): number {
  const l = (lang || '').replace(/_/g, '-').toLowerCase();
  if (l === 'en-us') return 0;
  if (l === 'en-gb') return 1;
  if (l === 'en-au') return 2;
  if (l === 'en' || l.startsWith('en-')) return 3;
  return 4;
}

function uriOf(voice: VoiceLike): string {
  return voice.voiceURI || voice.name;
}

/** 'Microsoft Aria Online (Natural) - English (United States)' matches 'microsoft aria online (natural)'. */
function nameMatches(name: string, preferred: string): boolean {
  const n = name.toLowerCase().trim();
  if (!n.startsWith(preferred)) return false;
  const next = n.charAt(preferred.length);
  return next === '' || next === ' ' || next === '(' || next === '-';
}

function usable(voice: VoiceLike | null | undefined): voice is VoiceLike {
  return !!voice && typeof voice.name === 'string' && !isNoveltyVoice(voice.name);
}

function byRankThenName(a: VoiceLike, b: VoiceLike): number {
  return langRank(a.lang) - langRank(b.lang) || a.name.localeCompare(b.name);
}

/** English first (en-US, en-GB, en-AU, other en-*), then the rest; by name within each group. No novelty voices, no duplicates. */
export function rankVoices(voices: readonly VoiceLike[]): VoiceInfo[] {
  const seen = new Set<string>();
  const kept: VoiceLike[] = [];
  for (const voice of voices) {
    if (!usable(voice)) continue;
    const uri = uriOf(voice);
    if (seen.has(uri)) continue;
    seen.add(uri);
    kept.push(voice);
  }
  kept.sort(byRankThenName);
  return kept.map((v) => ({ uri: uriOf(v), name: v.name, lang: v.lang || '', local: v.localService !== false }));
}

/**
 * The voice to use when the parent has not picked one, as a voiceURI (null = browser default).
 *
 * On-device voices win over network ones: KeySplash promises to work offline and
 * send nothing anywhere, and network voices ("Google US English", "… Online
 * (Natural)") fail without a connection. Order: preferred on-device voice → any
 * on-device English voice → preferred network voice → null.
 */
export function pickAutoVoice(voices: readonly VoiceLike[]): string | null {
  const english = voices.filter((v) => usable(v) && langRank(v.lang) < 4).sort(byRankThenName);
  const onDevice = english.filter((v) => v.localService !== false);
  for (const preferred of PREFERRED_VOICES) {
    const hit = onDevice.find((v) => nameMatches(v.name, preferred));
    if (hit) return uriOf(hit);
  }
  if (onDevice.length > 0) return uriOf(onDevice[0]);
  for (const preferred of PREFERRED_VOICES) {
    const hit = english.find((v) => nameMatches(v.name, preferred));
    if (hit) return uriOf(hit);
  }
  return null;
}

function defaultSynth(): SpeechSynthesis | null {
  try {
    return (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis ?? null;
  } catch {
    return null;
  }
}

function defaultClock(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class WebSpeaker implements Speaker {
  readonly supported: boolean;
  private readonly synth: SpeechSynthesis | null;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private enabled = true;
  private volume = 1;
  private voiceURI: string | null = null;
  /** Voice for the current setting; undefined = resolve on next say(). */
  private resolved: SpeechSynthesisVoice | null | undefined = undefined;
  /** The utterance in flight. Holding it stops Chrome from collecting it (and losing `end`). */
  private current: SpeechSynthesisUtterance | null = null;
  /** After this time a still-"speaking" synth is treated as stuck. */
  private busyUntil = 0;
  private lastSayAt = -Infinity;

  /** `now` is injectable for tests (ms, monotonic). */
  constructor(synth: SpeechSynthesis | null = defaultSynth(), now: () => number = defaultClock) {
    this.synth = synth ?? null;
    this.now = now;
    this.supported = !!this.synth && typeof SpeechSynthesisUtterance !== 'undefined';
    const s = this.synth;
    if (!s) return;
    try {
      if (typeof s.addEventListener === 'function') s.addEventListener('voiceschanged', this.handleVoicesChanged);
      else s.onvoiceschanged = this.handleVoicesChanged;
      s.getVoices(); // Chrome starts loading voices on first call
    } catch {
      // Voices will just stay empty.
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = !!enabled;
    if (!this.enabled) this.cancel();
  }

  /** Applies to the next utterance (browsers cannot change one already speaking). */
  setVolume(volume: number): void {
    if (Number.isFinite(volume)) this.volume = Math.min(1, Math.max(0, volume));
  }

  setVoice(uri: string | null): void {
    this.voiceURI = uri || null;
    this.resolved = undefined;
  }

  voices(): VoiceInfo[] {
    return rankVoices(this.rawVoices());
  }

  onVoicesChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  say(text: string, priority: 'low' | 'high' = 'low'): void {
    const synth = this.synth;
    if (!this.enabled || !this.supported || !synth || typeof text !== 'string') return;
    const phrase = text.trim();
    if (!phrase) return;
    const now = this.now();
    if (priority === 'high') {
      this.cancel();
    } else if (now - this.lastSayAt < MIN_GAP_MS || this.isBusy(synth, now)) {
      return;
    }
    try {
      const utterance = new SpeechSynthesisUtterance(phrase);
      utterance.rate = RATE;
      utterance.pitch = PITCH;
      utterance.volume = this.volume;
      const voice = this.resolveVoice();
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang || FALLBACK_LANG;
      // busyUntil stays: if the synth still claims to be speaking, wait out the safety timeout.
      const finish = (): void => {
        if (this.current === utterance) this.current = null;
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      this.current = utterance;
      this.busyUntil = now + phrase.length * MS_PER_CHAR + SAFETY_PAD_MS;
      this.lastSayAt = now;
      synth.speak(utterance);
    } catch {
      this.current = null;
      this.busyUntil = 0;
    }
  }

  cancel(): void {
    this.current = null;
    this.busyUntil = 0;
    try {
      this.synth?.cancel();
    } catch {
      // Nothing to cancel.
    }
  }

  // -------------------------------------------------------------------------

  private readonly handleVoicesChanged = (): void => {
    this.resolved = undefined;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // One bad listener must not break the others.
      }
    }
  };

  /** True while something is believably being said; resets a synth stuck past its safety timeout. */
  private isBusy(synth: SpeechSynthesis, now: number): boolean {
    if (!synth.speaking && !synth.pending && this.current === null) return false;
    if (now < this.busyUntil) return true;
    this.cancel();
    return false;
  }

  private rawVoices(): SpeechSynthesisVoice[] {
    try {
      return this.synth?.getVoices() ?? [];
    } catch {
      return [];
    }
  }

  private resolveVoice(): SpeechSynthesisVoice | null {
    if (this.resolved !== undefined) return this.resolved;
    const list = this.rawVoices();
    if (list.length === 0) return null; // not loaded yet; try again next time
    let voice: SpeechSynthesisVoice | null = null;
    if (this.voiceURI) voice = list.find((v) => v.voiceURI === this.voiceURI) ?? null;
    if (!voice) {
      const uri = pickAutoVoice(list);
      if (uri) voice = list.find((v) => uriOf(v) === uri) ?? null;
    }
    this.resolved = voice;
    return voice;
  }
}
