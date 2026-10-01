/**
 * Learning progress (what a child has seen and found), kept on this device
 * only and shown to grown-ups in the parent panel.
 *
 * A toddler can press 20 keys a second, so writes are debounced and listener
 * notifications are batched; pending changes are flushed when the page hides.
 * Storage failures fall back to memory silently.
 */
import type { LearningProgress, ProgressStore } from './types';

export const PROGRESS_STORAGE_KEY = 'keysplash:progress:v1';

const SYMBOL = /^[A-Z0-9]$/;
const WORD = /^[a-z][a-z' -]{0,15}$/;
const COUNT_CAP = 1_000_000;
const MAX_WORDS = 200;

export function emptyProgress(): LearningProgress {
  return { seen: {}, found: {}, spelled: {}, since: null };
}

function cleanCounts(raw: unknown, keyOk: (key: string) => boolean, maxKeys: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let n = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= maxKeys) break;
    if (!keyOk(key) || typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    out[key] = Math.min(COUNT_CAP, Math.floor(value));
    n++;
  }
  return out;
}

/** Any input → valid progress. Never throws. */
export function sanitizeProgress(raw: unknown): LearningProgress {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyProgress();
  const src = raw as Record<string, unknown>;
  const since = typeof src.since === 'number' && Number.isFinite(src.since) && src.since > 0 ? src.since : null;
  return {
    seen: cleanCounts(src.seen, (k) => SYMBOL.test(k), 36),
    found: cleanCounts(src.found, (k) => SYMBOL.test(k), 36),
    spelled: cleanCounts(src.spelled, (k) => WORD.test(k), MAX_WORDS),
    since,
  };
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class LocalProgressStore implements ProgressStore {
  private state: LearningProgress;
  private readonly listeners = new Set<(progress: LearningProgress) => void>();
  private readonly debounceMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(
    private readonly storage: Storage | null = safeStorage(),
    private readonly key = PROGRESS_STORAGE_KEY,
    options: { debounceMs?: number; now?: () => number } = {},
  ) {
    this.debounceMs = options.debounceMs ?? 1500;
    this.now = options.now ?? Date.now;
    this.state = this.load();
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.flush());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flush();
      });
    }
  }

  get(): LearningProgress {
    return {
      seen: { ...this.state.seen },
      found: { ...this.state.found },
      spelled: { ...this.state.spelled },
      since: this.state.since,
    };
  }

  markSeen(symbol: string): void {
    this.bump('seen', symbol.toUpperCase(), SYMBOL);
  }

  markFound(symbol: string): void {
    this.bump('found', symbol.toUpperCase(), SYMBOL);
  }

  markSpelled(word: string): void {
    const w = word.toLowerCase();
    if (!(w in this.state.spelled) && Object.keys(this.state.spelled).length >= MAX_WORDS) return;
    this.bump('spelled', w, WORD);
  }

  reset(): void {
    this.state = emptyProgress();
    this.dirty = true;
    this.flush();
  }

  subscribe(listener: (progress: LearningProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Write pending changes and notify now (also used on page hide). */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      this.storage?.setItem(this.key, JSON.stringify(this.state));
    } catch {
      // Quota or privacy mode: keep going in memory.
    }
    const snapshot = this.get();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // One broken listener must not stop the others.
      }
    }
  }

  private bump(field: 'seen' | 'found' | 'spelled', key: string, pattern: RegExp): void {
    if (!pattern.test(key)) return;
    const counts = this.state[field];
    counts[key] = Math.min(COUNT_CAP, (counts[key] ?? 0) + 1);
    if (this.state.since === null) this.state.since = this.now();
    this.dirty = true;
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private load(): LearningProgress {
    try {
      const raw = this.storage?.getItem(this.key);
      return raw ? sanitizeProgress(JSON.parse(raw)) : emptyProgress();
    } catch {
      return emptyProgress();
    }
  }
}
