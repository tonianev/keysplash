/**
 * Parent settings: defaults, sanitising and a localStorage-backed store.
 *
 * Everything that comes out of this module is a fully valid `Settings` object,
 * whatever was in storage (old versions, hand edits, other apps on the same
 * origin). Storage failures (Safari private mode, sandboxed iframes, quota)
 * silently fall back to in-memory settings so play never breaks.
 */
import type {
  Intensity,
  LetterCase,
  MotionPref,
  Settings,
  SettingsStore,
  SizeLevel,
  SpeechMode,
  WorldId,
} from './types';

export const SETTINGS_STORAGE_KEY = 'keysplash:settings:v1';

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  world: 'space',
  autoRotate: false,
  rotateMinutes: 5,
  volume: 0.7,
  muted: false,
  notes: true,
  speech: 'word',
  voiceURI: null,
  letterCase: 'upper',
  pictures: true,
  size: 'big',
  intensity: 'normal',
  motion: 'system',
  trails: true,
  faces: true,
  spatialKeys: true,
  childName: '',
  sessionMinutes: 0,
  secretWord: 'parent',
  lockKeyboard: true,
  confirmExit: true,
});

// `Record<Union, true>` makes the compiler insist every member is listed.
const WORLD_IDS: Record<WorldId, true> = {
  space: true, ocean: true, garden: true, party: true, bubbles: true, dino: true, night: true,
};
const SPEECH_MODES: Record<SpeechMode, true> = { off: true, letter: true, word: true };
const LETTER_CASES: Record<LetterCase, true> = { upper: true, lower: true, both: true };
const SIZES: Record<SizeLevel, true> = { normal: true, big: true, huge: true };
const INTENSITIES: Record<Intensity, true> = { calm: true, normal: true, wild: true };
const MOTIONS: Record<MotionPref, true> = { system: true, reduce: true, full: true };

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>;

const CHILD_NAME_MAX = 24;
const VOICE_URI_MAX = 300;
/** Letters of any script (plus combining marks), spaces, hyphens and apostrophes. */
const CHILD_NAME_DISALLOWED = /[^\p{L}\p{M} \-‐‑'’ʼ]/gu;
/** 4..16 letters (any script, so non-Latin keyboard layouts can type it). */
const SECRET_WORD_PATTERN = /^\p{L}{4,16}$/u;

function pickEnum<T extends string>(value: unknown, allowed: Record<T, true>, fallback: T): T {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(allowed, value)
    ? (value as T)
    : fallback;
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Accepts finite numbers and numeric strings (form inputs); anything else → null. */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickNumber(value: unknown, min: number, max: number, fallback: number, integer: boolean): number {
  let n = toFiniteNumber(value);
  if (n === null) return fallback;
  if (integer) n = Math.round(n);
  return Math.min(max, Math.max(min, n));
}

function sanitizeChildName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .replace(CHILD_NAME_DISALLOWED, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  // Slice by code points so astral letters are never split in half.
  const chars = Array.from(cleaned);
  return chars.length > CHILD_NAME_MAX ? chars.slice(0, CHILD_NAME_MAX).join('').trim() : cleaned;
}

function sanitizeSecretWord(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const word = value.normalize('NFC').trim().toLowerCase();
  return SECRET_WORD_PATTERN.test(word) ? word : fallback;
}

function sanitizeVoiceURI(value: unknown, fallback: string | null): string | null {
  if (value === null || value === '') return null; // explicit "automatic"
  return typeof value === 'string' && value.length <= VOICE_URI_MAX ? value : fallback;
}

/**
 * Returns a complete, valid Settings object for any input. Never throws.
 *
 * Missing or invalid fields take their value from `fallback` (the defaults, or
 * the current settings when applying a patch, so a bad value never silently
 * resets a field, e.g. the secret word, to its default).
 */
export function sanitizeSettings(raw: unknown, fallback: Settings = DEFAULT_SETTINGS): Settings {
  // The fallback itself must be valid; anything odd in it falls back to the defaults.
  const d = fallback === DEFAULT_SETTINGS ? DEFAULT_SETTINGS : sanitizeSettings(fallback);
  const src: Record<string, unknown> =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  // Reading a property can run a getter that throws; treat that as missing.
  const get = (key: keyof Settings): unknown => {
    try {
      return src[key];
    } catch {
      return undefined;
    }
  };
  return {
    world: pickEnum(get('world'), WORLD_IDS, d.world),
    autoRotate: pickBool(get('autoRotate'), d.autoRotate),
    rotateMinutes: pickNumber(get('rotateMinutes'), 1, 30, d.rotateMinutes, true),
    volume: pickNumber(get('volume'), 0, 1, d.volume, false),
    muted: pickBool(get('muted'), d.muted),
    notes: pickBool(get('notes'), d.notes),
    speech: pickEnum(get('speech'), SPEECH_MODES, d.speech),
    voiceURI: sanitizeVoiceURI(get('voiceURI'), d.voiceURI),
    letterCase: pickEnum(get('letterCase'), LETTER_CASES, d.letterCase),
    pictures: pickBool(get('pictures'), d.pictures),
    size: pickEnum(get('size'), SIZES, d.size),
    intensity: pickEnum(get('intensity'), INTENSITIES, d.intensity),
    motion: pickEnum(get('motion'), MOTIONS, d.motion),
    trails: pickBool(get('trails'), d.trails),
    faces: pickBool(get('faces'), d.faces),
    spatialKeys: pickBool(get('spatialKeys'), d.spatialKeys),
    childName: sanitizeChildName(get('childName'), d.childName),
    sessionMinutes: pickNumber(get('sessionMinutes'), 0, 120, d.sessionMinutes, true),
    secretWord: sanitizeSecretWord(get('secretWord'), d.secretWord),
    lockKeyboard: pickBool(get('lockKeyboard'), d.lockKeyboard),
    confirmExit: pickBool(get('confirmExit'), d.confirmExit),
  };
}

function sameSettings(a: Settings, b: Settings): boolean {
  for (const key of SETTINGS_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** `window.localStorage`, or null when merely touching it throws (sandboxed iframes, some privacy modes). */
function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

type Listener = (next: Settings, prev: Settings) => void;

/**
 * Settings persisted to localStorage (or memory when storage is unavailable).
 *
 * The object returned by `get()` is frozen and replaced (never mutated) on
 * every change, so callers may keep references and compare them with `===`.
 */
export class LocalSettingsStore implements SettingsStore {
  private storage: Storage | null;
  private readonly key: string;
  private current: Settings;
  private readonly listeners = new Set<Listener>();

  constructor(storage?: Storage | null, key: string = SETTINGS_STORAGE_KEY) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    this.key = key;
    this.current = Object.freeze(sanitizeSettings(this.read()));
  }

  get(): Settings {
    return this.current;
  }

  update(patch: Partial<Settings>): Settings {
    const prev = this.current;
    let merged: unknown = prev;
    try {
      if (patch !== null && typeof patch === 'object') merged = { ...prev, ...patch };
    } catch {
      return prev; // a hostile patch (throwing getter) changes nothing
    }
    // Invalid patch values keep the current value rather than reverting to defaults.
    const next = sanitizeSettings(merged, prev);
    if (sameSettings(prev, next)) return prev;
    this.current = Object.freeze(next);
    this.write(this.current);
    // Snapshot so listeners that (un)subscribe during notification are handled predictably.
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(this.current, prev);
      } catch {
        // One broken listener must not stop the others from hearing about the change.
      }
    }
    return this.current;
  }

  reset(): Settings {
    return this.update(DEFAULT_SETTINGS);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private read(): unknown {
    if (!this.storage) return null;
    try {
      const text = this.storage.getItem(this.key);
      return text ? (JSON.parse(text) as unknown) : null;
    } catch {
      return null;
    }
  }

  private write(settings: Settings): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.key, JSON.stringify(settings));
    } catch {
      // Quota or access error: keep playing with in-memory settings.
    }
  }
}
