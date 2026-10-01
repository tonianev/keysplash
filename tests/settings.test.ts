import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, LocalSettingsStore, sanitizeSettings } from '../src/settings';
import type { Settings } from '../src/types';

/** Minimal in-memory Storage. */
function memoryStorage(initial: Record<string, string> = {}): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    removeItem: (k: string) => {
      data.delete(k);
    },
    setItem: (k: string, v: string) => {
      data.set(k, String(v));
    },
  } as Storage & { data: Map<string, string> };
}

/** Storage where every access throws (Safari private mode, sandboxed iframes). */
function throwingStorage(): Storage {
  const boom = () => {
    throw new DOMException('denied', 'SecurityError');
  };
  return { length: 0, clear: boom, getItem: boom, key: boom, removeItem: boom, setItem: boom } as Storage;
}

describe('DEFAULT_SETTINGS', () => {
  it('has the documented defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({
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
  });

  it('is already sanitised', () => {
    expect(sanitizeSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('sanitizeSettings', () => {
  it('returns defaults for garbage', () => {
    for (const raw of [undefined, null, 42, 'settings', true, [], [1, 2], () => 1, Symbol('x')]) {
      expect(sanitizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('returns a fresh object (not the frozen defaults)', () => {
    const s = sanitizeSettings(null);
    expect(s).not.toBe(DEFAULT_SETTINGS);
    expect(Object.isFrozen(s)).toBe(false);
  });

  it('fills a partial object with defaults', () => {
    expect(sanitizeSettings({ volume: 0.3, world: 'ocean' })).toEqual({ ...DEFAULT_SETTINGS, volume: 0.3, world: 'ocean' });
  });

  it('replaces wrong types and invalid enum values with defaults', () => {
    const s = sanitizeSettings({
      world: 'mars',
      volume: 'loud',
      notes: 'yes',
      muted: 1,
      speech: 2,
      letterCase: 'UPPER',
      size: null,
      intensity: {},
      motion: [],
      trails: 'false',
      voiceURI: 42,
      childName: 7,
      secretWord: false,
      rotateMinutes: {},
      sessionMinutes: true,
    });
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('accepts every valid enum value', () => {
    for (const world of ['space', 'ocean', 'garden', 'party', 'bubbles', 'dino', 'night'] as const) {
      expect(sanitizeSettings({ world }).world).toBe(world);
    }
    for (const speech of ['off', 'letter', 'word'] as const) expect(sanitizeSettings({ speech }).speech).toBe(speech);
    for (const letterCase of ['upper', 'lower', 'both'] as const) {
      expect(sanitizeSettings({ letterCase }).letterCase).toBe(letterCase);
    }
    for (const size of ['normal', 'big', 'huge'] as const) expect(sanitizeSettings({ size }).size).toBe(size);
    for (const intensity of ['calm', 'normal', 'wild'] as const) {
      expect(sanitizeSettings({ intensity }).intensity).toBe(intensity);
    }
    for (const motion of ['system', 'reduce', 'full'] as const) expect(sanitizeSettings({ motion }).motion).toBe(motion);
  });

  it('does not treat inherited properties as valid enum values', () => {
    expect(sanitizeSettings({ world: 'toString' }).world).toBe('space');
    expect(sanitizeSettings({ speech: '__proto__' }).speech).toBe('word');
  });

  it('clamps and rounds numbers', () => {
    expect(sanitizeSettings({ volume: 5 }).volume).toBe(1);
    expect(sanitizeSettings({ volume: -1 }).volume).toBe(0);
    expect(sanitizeSettings({ volume: 0.25 }).volume).toBe(0.25);
    expect(sanitizeSettings({ rotateMinutes: 0 }).rotateMinutes).toBe(1);
    expect(sanitizeSettings({ rotateMinutes: 99 }).rotateMinutes).toBe(30);
    expect(sanitizeSettings({ rotateMinutes: 7.6 }).rotateMinutes).toBe(8);
    expect(sanitizeSettings({ sessionMinutes: -5 }).sessionMinutes).toBe(0);
    expect(sanitizeSettings({ sessionMinutes: 500 }).sessionMinutes).toBe(120);
    expect(sanitizeSettings({ sessionMinutes: 12.4 }).sessionMinutes).toBe(12);
  });

  it('rejects non-finite numbers but accepts numeric strings from form inputs', () => {
    expect(sanitizeSettings({ volume: Number.NaN }).volume).toBe(0.7);
    expect(sanitizeSettings({ volume: Number.POSITIVE_INFINITY }).volume).toBe(0.7);
    expect(sanitizeSettings({ rotateMinutes: '' }).rotateMinutes).toBe(5);
    expect(sanitizeSettings({ rotateMinutes: 'ten' }).rotateMinutes).toBe(5);
    expect(sanitizeSettings({ volume: '0.5' }).volume).toBe(0.5);
    expect(sanitizeSettings({ sessionMinutes: ' 20 ' }).sessionMinutes).toBe(20);
  });

  it('lower-cases and validates the secret word', () => {
    expect(sanitizeSettings({ secretWord: 'PaRent' }).secretWord).toBe('parent');
    expect(sanitizeSettings({ secretWord: '  Mommy ' }).secretWord).toBe('mommy');
    expect(sanitizeSettings({ secretWord: 'abcd' }).secretWord).toBe('abcd');
    expect(sanitizeSettings({ secretWord: 'abcdefghijklmnop' }).secretWord).toBe('abcdefghijklmnop');
    expect(sanitizeSettings({ secretWord: 'мама' }).secretWord).toBe('мама');
    for (const bad of ['abc', 'abcdefghijklmnopq', 'pass word', '1234', 'dad1', 'mom!', '', '    ']) {
      expect(sanitizeSettings({ secretWord: bad }).secretWord).toBe('parent');
    }
  });

  it('cleans the child name (any script, letters/spaces/hyphens/apostrophes, ≤ 24 chars)', () => {
    const name = (childName: unknown) => sanitizeSettings({ childName }).childName;
    expect(name('  Mia  ')).toBe('Mia');
    expect(name("Zoë-Ann O'Neil")).toBe("Zoë-Ann O'Neil");
    expect(name('D’Angelo')).toBe('D’Angelo');
    expect(name('Анна')).toBe('Анна');
    expect(name('さくら')).toBe('さくら');
    expect(name('अनन्या')).toBe('अनन्या'); // combining marks survive
    expect(name('Mia<script>alert(1)</script>')).toBe('Miascriptalertscript');
    expect(name('Mia 123')).toBe('Mia');
    expect(name('Leo 🦁')).toBe('Leo');
    expect(name('Mary\n\tAnn')).toBe('Mary Ann');
    expect(name('A'.repeat(40))).toBe('A'.repeat(24));
    expect(Array.from(name('𝒜'.repeat(30))).length).toBeLessThanOrEqual(24);
    expect(name(null)).toBe('');
  });

  it('accepts a voice URI string up to 300 chars, otherwise null', () => {
    expect(sanitizeSettings({ voiceURI: 'com.apple.voice.Samantha' }).voiceURI).toBe('com.apple.voice.Samantha');
    expect(sanitizeSettings({ voiceURI: '' }).voiceURI).toBeNull();
    expect(sanitizeSettings({ voiceURI: 'x'.repeat(300) }).voiceURI).toHaveLength(300);
    expect(sanitizeSettings({ voiceURI: 'x'.repeat(301) }).voiceURI).toBeNull();
    expect(sanitizeSettings({ voiceURI: { uri: 'x' } }).voiceURI).toBeNull();
  });

  it('drops unknown fields', () => {
    const s = sanitizeSettings({ ...DEFAULT_SETTINGS, evil: true, __proto__: { polluted: true } });
    expect(Object.keys(s).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect((s as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('never throws, even for hostile objects', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('nope');
        },
      },
    );
    expect(sanitizeSettings(hostile)).toEqual(DEFAULT_SETTINGS);
    const getter = Object.defineProperty({}, 'volume', {
      get() {
        throw new Error('nope');
      },
      enumerable: true,
    });
    expect(sanitizeSettings(getter)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('LocalSettingsStore', () => {
  it('starts with defaults on empty storage', () => {
    expect(new LocalSettingsStore(memoryStorage()).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('persists and reloads (round trip)', () => {
    const storage = memoryStorage();
    const a = new LocalSettingsStore(storage);
    a.update({ world: 'dino', volume: 0.4, childName: 'Mia' });
    expect(storage.data.has('keysplash:settings:v1')).toBe(true);
    const b = new LocalSettingsStore(storage);
    expect(b.get()).toEqual({ ...DEFAULT_SETTINGS, world: 'dino', volume: 0.4, childName: 'Mia' });
  });

  it('uses a custom key', () => {
    const storage = memoryStorage();
    new LocalSettingsStore(storage, 'custom').update({ muted: true });
    expect(storage.data.has('custom')).toBe(true);
    expect(storage.data.has('keysplash:settings:v1')).toBe(false);
  });

  it('sanitises what it loads', () => {
    const storage = memoryStorage({
      'keysplash:settings:v1': JSON.stringify({ world: 'night', volume: 9, secretWord: 'x', extra: 1 }),
    });
    expect(new LocalSettingsStore(storage).get()).toEqual({ ...DEFAULT_SETTINGS, world: 'night', volume: 1 });
  });

  it('survives corrupt JSON', () => {
    const storage = memoryStorage({ 'keysplash:settings:v1': '{not json' });
    expect(new LocalSettingsStore(storage).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back to memory when storage throws', () => {
    const store = new LocalSettingsStore(throwingStorage());
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(() => store.update({ world: 'party' })).not.toThrow();
    expect(store.get().world).toBe('party');
  });

  it('works with no storage at all', () => {
    const store = new LocalSettingsStore(null);
    store.update({ notes: false });
    expect(store.get().notes).toBe(false);
  });

  it('defaults to window.localStorage', () => {
    localStorage.removeItem('keysplash:settings:v1');
    new LocalSettingsStore().update({ world: 'garden' });
    expect(JSON.parse(localStorage.getItem('keysplash:settings:v1') ?? '{}').world).toBe('garden');
    expect(new LocalSettingsStore().get().world).toBe('garden');
    localStorage.removeItem('keysplash:settings:v1');
  });

  it('sanitises updates', () => {
    const store = new LocalSettingsStore(memoryStorage());
    const next = store.update({ volume: 3, rotateMinutes: -2 } as Partial<Settings>);
    expect(next.volume).toBe(1);
    expect(next.rotateMinutes).toBe(1);
  });

  it('keeps the current value when a patch field is invalid (never silently resets to defaults)', () => {
    const store = new LocalSettingsStore(memoryStorage());
    store.update({ secretWord: 'banana', world: 'night', voiceURI: 'v1' });
    const next = store.update({ secretWord: 'no', world: 'mars', voiceURI: 42 } as unknown as Partial<Settings>);
    expect(next.secretWord).toBe('banana');
    expect(next.world).toBe('night');
    expect(next.voiceURI).toBe('v1');
    // null is a valid voice choice ("automatic").
    expect(store.update({ voiceURI: null }).voiceURI).toBeNull();
  });

  it('returns frozen snapshots that are replaced, never mutated', () => {
    const store = new LocalSettingsStore(memoryStorage());
    const before = store.get();
    expect(Object.isFrozen(before)).toBe(true);
    const after = store.update({ world: 'ocean' });
    expect(after).not.toBe(before);
    expect(before.world).toBe('space');
    expect(store.get()).toBe(after);
  });

  it('notifies subscribers with (next, prev) only when something changed', () => {
    const store = new LocalSettingsStore(memoryStorage());
    const listener = vi.fn();
    store.subscribe(listener);
    const prev = store.get();
    const next = store.update({ world: 'bubbles' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(next, prev);

    // No-ops: same value, invalid value that sanitises to the current one, empty patch.
    expect(store.update({ world: 'bubbles' })).toBe(next);
    store.update({ volume: Number.NaN });
    store.update({});
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not write storage on a no-op update', () => {
    const storage = memoryStorage();
    const store = new LocalSettingsStore(storage);
    const spy = vi.spyOn(storage, 'setItem');
    store.update({ volume: 0.7 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('unsubscribes', () => {
    const store = new LocalSettingsStore(memoryStorage());
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    off(); // idempotent
    store.update({ muted: true });
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps notifying other listeners when one throws', () => {
    const store = new LocalSettingsStore(memoryStorage());
    const bad = vi.fn(() => {
      throw new Error('listener bug');
    });
    const good = vi.fn();
    store.subscribe(bad);
    store.subscribe(good);
    expect(() => store.update({ trails: false })).not.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(store.get().trails).toBe(false);
  });

  it('reset() restores defaults and notifies only if needed', () => {
    const store = new LocalSettingsStore(memoryStorage());
    const listener = vi.fn();
    store.subscribe(listener);
    store.reset();
    expect(listener).not.toHaveBeenCalled();
    store.update({ size: 'huge' });
    expect(store.reset()).toEqual(DEFAULT_SETTINGS);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('ignores a non-object patch', () => {
    const store = new LocalSettingsStore(memoryStorage());
    const before = store.get();
    expect(store.update(null as unknown as Partial<Settings>)).toBe(before);
  });
});
