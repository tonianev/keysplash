/**
 * Keyboard input for play mode.
 *
 * Every key event is swallowed (so browser shortcuts like Cmd+R, Ctrl+P, F5,
 * Space-to-scroll do nothing) unless it targets a parent-facing control: an
 * element inside `[data-allow-keys]` or a form field. Key presses become
 * `onKey`, palm smashes become a single `onSmash`, and typing the secret word
 * fires `onSecret`.
 */
import type { KeyboardHandlers, KeyboardInput, KeyMap, KeyPosition, KeyPress } from '../types';

const ALLOW_SELECTOR = '[data-allow-keys], input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * True when an event target belongs to parent UI that needs normal keyboard /
 * pointer behaviour (an element inside `[data-allow-keys]`, or a form field).
 */
export function isAllowedTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Partial<Element>).closest !== 'function') return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  try {
    return el.closest(ALLOW_SELECTOR) !== null;
  } catch {
    return false;
  }
}

/** The innermost target, looking through open shadow roots. */
function eventTarget(e: Event): EventTarget | null {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
  return path && path.length > 0 ? path[0] : e.target;
}

const DEFAULT_SMASH_WINDOW_MS = 90;
const DEFAULT_SMASH_THRESHOLD = 4;
const DEFAULT_SMASH_COOLDOWN_MS = 450;
/** Hard cap on keys tracked inside one smash window (a forearm covers ~20 keys). */
const SMASH_CAPACITY = 32;

/**
 * Detects a palm smash: `threshold` distinct keys within `windowMs`. Reports the
 * codes once, then cools down so one palm (or forearm) is one smash.
 */
export class SmashDetector {
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly codes: string[] = [];
  private readonly times: number[] = [];
  private cooldownUntil = -Infinity;

  constructor(
    windowMs: number = DEFAULT_SMASH_WINDOW_MS,
    threshold: number = DEFAULT_SMASH_THRESHOLD,
    cooldownMs: number = DEFAULT_SMASH_COOLDOWN_MS,
  ) {
    this.windowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_SMASH_WINDOW_MS;
    this.threshold = Number.isFinite(threshold) ? Math.min(SMASH_CAPACITY, Math.max(2, Math.round(threshold))) : DEFAULT_SMASH_THRESHOLD;
    this.cooldownMs = Number.isFinite(cooldownMs) && cooldownMs >= 0 ? cooldownMs : DEFAULT_SMASH_COOLDOWN_MS;
  }

  /** True while a smash was just reported and further keys belong to it. */
  isCoolingDown(time: number): boolean {
    return time < this.cooldownUntil;
  }

  /** Record a fresh key press. Returns the smashed codes when this press completes a smash. */
  push(code: string, time: number): string[] | null {
    if (this.isCoolingDown(time)) return null;

    // Drop presses that fell out of the window (or are from the "future" after a clock reset).
    let keep = 0;
    for (let i = 0; i < this.codes.length; i++) {
      const age = time - this.times[i];
      if (age >= 0 && age <= this.windowMs && this.codes[i] !== code) {
        this.codes[keep] = this.codes[i];
        this.times[keep] = this.times[i];
        keep++;
      }
    }
    this.codes.length = keep;
    this.times.length = keep;
    if (keep >= SMASH_CAPACITY) {
      this.codes.shift();
      this.times.shift();
    }
    this.codes.push(code);
    this.times.push(time);

    if (this.codes.length < this.threshold) return null;
    const smashed = this.codes.slice();
    this.reset();
    this.cooldownUntil = time + this.cooldownMs;
    return smashed;
  }

  reset(): void {
    this.codes.length = 0;
    this.times.length = 0;
    this.cooldownUntil = -Infinity;
  }
}

/**
 * Watches typed letters for the parent's secret word (case-insensitive).
 * Non-letter keys (Shift, digits, Space…) are ignored rather than resetting,
 * so "Parent" with Shift still matches. Allocation-free ring buffer.
 */
export class SecretWordDetector {
  private word: string[] = [];
  private ring: string[] = [];
  private head = 0; // next write position
  private filled = 0;

  constructor(word: string) {
    this.setWord(word);
  }

  setWord(word: string): void {
    const clean = typeof word === 'string' ? word.normalize('NFC').toLowerCase() : '';
    this.word = Array.from(clean);
    this.ring = new Array<string>(this.word.length).fill('');
    this.reset();
  }

  reset(): void {
    this.head = 0;
    this.filled = 0;
  }

  /** Feed `KeyboardEvent.key`. Returns true when the buffer now ends with the word (then resets). */
  push(key: string): boolean {
    const n = this.word.length;
    if (n === 0 || typeof key !== 'string') return false;
    // A single letter: one code point that is a letter in any script.
    if (key.length === 0 || key.length > 2 || !/^\p{L}$/u.test(key)) return false;
    this.ring[this.head] = key.toLowerCase();
    this.head = (this.head + 1) % n;
    if (this.filled < n) this.filled++;
    if (this.filled < n) return false;
    // The ring holds exactly the last n letters, oldest at `head`.
    for (let i = 0; i < n; i++) {
      if (this.ring[(this.head + i) % n] !== this.word[i]) return false;
    }
    this.reset();
    return true;
  }
}

/** A `held` entry older than this is a key-up we never saw (focus loss), not a held key. */
const STALE_HOLD_MS = 1500;
const MAX_TRACKED_KEYS = 128;
const ASCII_WORD = /^[a-z]+$/;
const LETTER_CODE = /^Key([A-Z])$/;

export interface DomKeyboardInputOptions {
  secretWord?: string;
  smashWindowMs?: number;
  smashThreshold?: number;
  /** How long after a smash further presses count as part of it. Default 450 ms. */
  smashCooldownMs?: number;
  /** Clock (ms). Defaults to `performance.now()`. */
  now?: () => number;
}

export class DomKeyboardInput implements KeyboardInput {
  private readonly target: Window;
  private readonly handlers: KeyboardHandlers;
  private readonly keyMap: KeyMap;
  private readonly now: () => number;
  private readonly smash: SmashDetector;
  /** Matches on the printed letter (`key`): works on any Latin layout (AZERTY, Dvorak…). */
  private readonly secretByKey: SecretWordDetector;
  /** Matches on the physical QWERTY letter (`code`): works when the layout is Cyrillic, Greek… */
  private readonly secretByCode: SecretWordDetector;
  /** code → time of the last keydown, for keys currently held. */
  private readonly held = new Map<string, number>();
  /** Codes held as part of a smash: their auto-repeats are ignored until released. */
  private readonly smashHeld = new Set<string>();
  private attached = false;
  private enabled = true;

  constructor(
    target: Window,
    handlers: KeyboardHandlers,
    keyMap: KeyMap,
    options: DomKeyboardInputOptions = {},
  ) {
    this.target = target;
    this.handlers = handlers;
    this.keyMap = keyMap;
    this.now = options.now ?? (() => performance.now());
    this.smash = new SmashDetector(options.smashWindowMs, options.smashThreshold, options.smashCooldownMs);
    this.secretByKey = new SecretWordDetector('');
    this.secretByCode = new SecretWordDetector('');
    this.setSecretWord(options.secretWord ?? 'parent');
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.target.addEventListener('keydown', this.onKeyDown, { capture: true });
    this.target.addEventListener('keyup', this.onKeyUp, { capture: true });
    this.target.addEventListener('blur', this.onBlur);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.target.removeEventListener('keydown', this.onKeyDown, { capture: true });
    this.target.removeEventListener('keyup', this.onKeyUp, { capture: true });
    this.target.removeEventListener('blur', this.onBlur);
    this.clearHeld();
  }

  setEnabled(enabled: boolean): void {
    if (enabled && !this.enabled) {
      // Start fresh: nothing typed before (or in the parent panel) counts.
      this.secretByKey.reset();
      this.secretByCode.reset();
      this.smash.reset();
    }
    this.enabled = enabled;
  }

  setSecretWord(word: string): void {
    const clean = typeof word === 'string' ? word.normalize('NFC').toLowerCase() : '';
    this.secretByKey.setWord(clean);
    this.secretByCode.setWord(ASCII_WORD.test(clean) ? clean : '');
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (isAllowedTarget(eventTarget(e))) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.isComposing) return;

    const code = typeof e.code === 'string' ? e.code : '';
    const key = typeof e.key === 'string' ? e.key : '';
    const time = this.now();
    const lastDown = this.held.get(code);
    const repeat = e.repeat || (lastDown !== undefined && time - lastDown < STALE_HOLD_MS);
    this.markHeld(code, time);

    if (!this.enabled) return;

    if (repeat) {
      if (!this.smashHeld.has(code)) {
        this.handlers.onKey({ code, key, repeat: true, position: this.keyMap.position(code), time });
      }
      return;
    }

    const secret = this.feedSecret(code, key);

    if (this.smash.isCoolingDown(time)) {
      // Rest of the same palm: already celebrated by the smash.
      this.smashHeld.add(code);
    } else {
      const codes = this.smash.push(code, time);
      if (codes) {
        for (const c of codes) this.smashHeld.add(c);
        this.handlers.onSmash({ codes, center: this.centerOf(codes), time });
      } else {
        const press: KeyPress = { code, key, repeat: false, position: this.keyMap.position(code), time };
        this.handlers.onKey(press);
      }
    }

    if (secret) this.handlers.onSecret();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (isAllowedTarget(eventTarget(e))) return;
    e.preventDefault();
    e.stopPropagation();
    const code = typeof e.code === 'string' ? e.code : '';
    this.held.delete(code);
    this.smashHeld.delete(code);
    // macOS swallows key-ups of other keys while Cmd is down: forget them all.
    if (e.key === 'Meta' || code === 'MetaLeft' || code === 'MetaRight' || code === 'OSLeft' || code === 'OSRight') {
      this.clearHeld();
    }
  };

  /** Window lost focus (app switch, devtools): key-ups will never arrive. Element blurs don't bubble here. */
  private readonly onBlur = (): void => {
    this.clearHeld();
  };

  private feedSecret(code: string, key: string): boolean {
    const byKey = this.secretByKey.push(key);
    const m = LETTER_CODE.exec(code);
    const byCode = m ? this.secretByCode.push(m[1]) : false;
    if (byKey || byCode) {
      this.secretByKey.reset();
      this.secretByCode.reset();
      return true;
    }
    return false;
  }

  private markHeld(code: string, time: number): void {
    if (!this.held.has(code) && this.held.size >= MAX_TRACKED_KEYS) {
      // Only possible if many key-ups were lost; drop the oldest entry.
      const oldest = this.held.keys().next();
      if (!oldest.done) this.held.delete(oldest.value);
    }
    this.held.set(code, time);
  }

  private clearHeld(): void {
    this.held.clear();
    this.smashHeld.clear();
  }

  private centerOf(codes: string[]): KeyPosition | null {
    let x = 0;
    let y = 0;
    let n = 0;
    for (const code of codes) {
      const p = this.keyMap.position(code);
      if (p) {
        x += p.x;
        y += p.y;
        n++;
      }
    }
    return n > 0 ? { x: x / n, y: y / n } : null;
  }
}
