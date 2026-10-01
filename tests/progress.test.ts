import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalProgressStore, PROGRESS_STORAGE_KEY, emptyProgress, sanitizeProgress } from '../src/progress';
import type { LearningProgress } from '../src/types';

/** Minimal in-memory Storage with a write counter. */
function memoryStorage(initial: Record<string, string> = {}): Storage & { data: Map<string, string>; writes: number } {
  const data = new Map(Object.entries(initial));
  const s = {
    data,
    writes: 0,
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
      s.writes++;
      data.set(k, String(v));
    },
  };
  return s as unknown as Storage & { data: Map<string, string>; writes: number };
}

function throwingStorage(): Storage {
  const boom = () => {
    throw new DOMException('denied', 'SecurityError');
  };
  return { length: 0, clear: boom, getItem: boom, key: boom, removeItem: boom, setItem: boom } as Storage;
}

function stored(storage: { data: Map<string, string> }): LearningProgress {
  return JSON.parse(storage.data.get(PROGRESS_STORAGE_KEY) ?? 'null') as LearningProgress;
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  setVisibility('visible');
});

describe('sanitizeProgress', () => {
  it('returns empty progress for garbage', () => {
    for (const raw of [undefined, null, 1, 'x', true, [], [1], () => 0]) {
      expect(sanitizeProgress(raw)).toEqual(emptyProgress());
    }
  });

  it('keeps only A–Z / 0–9 keys with positive finite counts, floored and capped', () => {
    const p = sanitizeProgress({
      seen: { A: 3, b: 2, '7': 1.9, AB: 4, Z: -1, Y: 0, X: 'many', W: Number.NaN, V: 5e9, __proto__: 3 },
      found: { Q: Number.POSITIVE_INFINITY, R: 2 },
      spelled: { cat: 2, 'ice cream': 1, Dog: 3, '1up': 1, ['x'.repeat(30)]: 1, "o'clock": 1 },
      since: 1234,
    });
    expect(p.seen).toEqual({ A: 3, '7': 1, V: 1_000_000 });
    expect(p.found).toEqual({ R: 2 });
    expect(p.spelled).toEqual({ cat: 2, 'ice cream': 1, "o'clock": 1 });
    expect(p.since).toBe(1234);
  });

  it('rejects a bad `since`', () => {
    for (const since of [0, -5, 'yesterday', Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(sanitizeProgress({ since }).since).toBeNull();
    }
  });

  it('caps the number of keys (36 symbols, 200 words)', () => {
    const seen: Record<string, number> = {};
    for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') seen[c] = 1;
    const spelled: Record<string, number> = {};
    for (let i = 0; i < 300; i++) spelled[`w${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`] = 1;
    const p = sanitizeProgress({ seen, spelled });
    expect(Object.keys(p.seen)).toHaveLength(36);
    expect(Object.keys(p.spelled)).toHaveLength(200);
  });
});

describe('LocalProgressStore', () => {
  it('starts empty and loads sanitised data from storage', () => {
    expect(new LocalProgressStore(memoryStorage()).get()).toEqual(emptyProgress());
    const storage = memoryStorage({
      [PROGRESS_STORAGE_KEY]: JSON.stringify({ seen: { A: 2, bad: 9 }, found: { '3': 1 }, spelled: { cat: 1 }, since: 5 }),
    });
    expect(new LocalProgressStore(storage).get()).toEqual({ seen: { A: 2 }, found: { '3': 1 }, spelled: { cat: 1 }, since: 5 });
  });

  it('survives corrupt JSON, throwing storage and no storage', () => {
    expect(new LocalProgressStore(memoryStorage({ [PROGRESS_STORAGE_KEY]: '{nope' })).get()).toEqual(emptyProgress());
    for (const storage of [throwingStorage(), null]) {
      const store = new LocalProgressStore(storage);
      expect(() => {
        store.markSeen('A');
        store.flush();
        store.reset();
      }).not.toThrow();
    }
  });

  it('counts, normalises case and ignores invalid symbols/words', () => {
    const store = new LocalProgressStore(memoryStorage(), PROGRESS_STORAGE_KEY, { now: () => 42 });
    store.markSeen('a');
    store.markSeen('A');
    store.markSeen('7');
    store.markSeen('AB');
    store.markSeen('!');
    store.markFound('q');
    store.markSpelled('CAT');
    store.markSpelled('123');
    store.markSpelled('');
    expect(store.get()).toEqual({ seen: { A: 2, '7': 1 }, found: { Q: 1 }, spelled: { cat: 1 }, since: 42 });
  });

  it('sets `since` once, on the first recorded activity', () => {
    let t = 100;
    const store = new LocalProgressStore(memoryStorage(), PROGRESS_STORAGE_KEY, { now: () => t });
    store.markSeen('!'); // invalid: no activity
    expect(store.get().since).toBeNull();
    store.markSeen('A');
    t = 999;
    store.markFound('B');
    expect(store.get().since).toBe(100);
  });

  it('get() returns a copy that callers cannot use to mutate the store', () => {
    const store = new LocalProgressStore(memoryStorage());
    store.markSeen('A');
    const p = store.get();
    p.seen.A = 999;
    p.seen.B = 1;
    expect(store.get().seen).toEqual({ A: 1 });
  });

  it('debounces writes: many marks → one write after the debounce', () => {
    const storage = memoryStorage();
    const store = new LocalProgressStore(storage, PROGRESS_STORAGE_KEY, { debounceMs: 1000 });
    for (let i = 0; i < 50; i++) store.markSeen('ABC'[i % 3]);
    expect(storage.writes).toBe(0);
    vi.advanceTimersByTime(999);
    expect(storage.writes).toBe(0);
    vi.advanceTimersByTime(1);
    expect(storage.writes).toBe(1);
    expect(stored(storage).seen).toEqual({ A: 17, B: 17, C: 16 });
    vi.advanceTimersByTime(10_000);
    expect(storage.writes).toBe(1); // nothing pending → no extra writes
  });

  it('uses a 1500 ms debounce by default and persists across instances', () => {
    const storage = memoryStorage();
    const store = new LocalProgressStore(storage);
    store.markSpelled('dog');
    vi.advanceTimersByTime(1499);
    expect(storage.writes).toBe(0);
    vi.advanceTimersByTime(1);
    expect(new LocalProgressStore(storage).get().spelled).toEqual({ dog: 1 });
  });

  it('batches subscriber notifications with the write', () => {
    const store = new LocalProgressStore(memoryStorage(), PROGRESS_STORAGE_KEY, { debounceMs: 500 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.markSeen('A');
    store.markSeen('B');
    store.markFound('A');
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({ seen: { A: 1, B: 1 }, found: { A: 1 } });
  });

  it('unsubscribes and isolates a throwing listener', () => {
    const store = new LocalProgressStore(memoryStorage(), PROGRESS_STORAGE_KEY, { debounceMs: 10 });
    const bad = vi.fn(() => {
      throw new Error('bug');
    });
    const good = vi.fn();
    const gone = vi.fn();
    store.subscribe(bad);
    store.subscribe(good);
    const off = store.subscribe(gone);
    off();
    store.markSeen('A');
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(gone).not.toHaveBeenCalled();
  });

  it('flush() writes pending changes immediately and cancels the timer', () => {
    const storage = memoryStorage();
    const store = new LocalProgressStore(storage, PROGRESS_STORAGE_KEY, { debounceMs: 1000 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.flush(); // nothing pending
    expect(storage.writes).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    store.markSeen('A');
    store.flush();
    expect(storage.writes).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(storage.writes).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('flushes when the page becomes hidden (not when visible)', () => {
    const storage = memoryStorage();
    const store = new LocalProgressStore(storage, PROGRESS_STORAGE_KEY, { debounceMs: 60_000 });
    store.markSeen('Z');
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(storage.writes).toBe(0);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(storage.writes).toBe(1);
    expect(stored(storage).seen).toEqual({ Z: 1 });
  });

  it('flushes on pagehide', () => {
    const storage = memoryStorage();
    const store = new LocalProgressStore(storage, PROGRESS_STORAGE_KEY, { debounceMs: 60_000 });
    store.markFound('5');
    window.dispatchEvent(new Event('pagehide'));
    expect(stored(storage).found).toEqual({ '5': 1 });
  });

  it('reset() clears, persists immediately and notifies', () => {
    const storage = memoryStorage();
    const store = new LocalProgressStore(storage, PROGRESS_STORAGE_KEY, { debounceMs: 1000 });
    const listener = vi.fn();
    store.markSeen('A');
    store.subscribe(listener);
    store.reset();
    expect(store.get()).toEqual(emptyProgress());
    expect(stored(storage)).toEqual(emptyProgress());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toEqual(emptyProgress());
    vi.advanceTimersByTime(5000);
    expect(stored(storage)).toEqual(emptyProgress()); // the cancelled timer cannot resurrect old data
  });

  it('caps counts at 1,000,000', () => {
    const storage = memoryStorage({ [PROGRESS_STORAGE_KEY]: JSON.stringify({ seen: { A: 999_999 } }) });
    const store = new LocalProgressStore(storage);
    store.markSeen('A');
    store.markSeen('A');
    store.markSeen('A');
    expect(store.get().seen.A).toBe(1_000_000);
  });

  it('caps spelled words at 200 distinct entries but keeps counting known ones', () => {
    const spelled: Record<string, number> = {};
    for (let i = 0; i < 200; i++) spelled[`w${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`] = 1;
    const storage = memoryStorage({ [PROGRESS_STORAGE_KEY]: JSON.stringify({ spelled }) });
    const store = new LocalProgressStore(storage);
    expect(Object.keys(store.get().spelled)).toHaveLength(200);
    store.markSpelled('newword');
    expect(store.get().spelled.newword).toBeUndefined();
    store.markSpelled('waa');
    expect(store.get().spelled.waa).toBe(2);
    expect(Object.keys(store.get().spelled)).toHaveLength(200);
  });

  it('keeps going in memory when a write fails', () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    const store = new LocalProgressStore(storage, PROGRESS_STORAGE_KEY, { debounceMs: 10 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.markSeen('A');
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    expect(store.get().seen.A).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
