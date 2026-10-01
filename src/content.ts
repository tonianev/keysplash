/**
 * What a key press (or a tap) *means*: a letter with a picture and a word, a
 * number that counts, a named shape, a special effect or a world friend.
 *
 * Keys are identified by `KeyboardEvent.code`, so the same physical key always
 * gives the same colour and shape. Speech strings are spelled so that speech
 * synthesis pronounces them the way a parent would ("ay… apple!").
 */
import type { ContentContext, KeyContent, NamedColor, ShapeKind, SpecialEffect, WordEntry } from './types';

/** 'A'…'Z' → toddler words with one clear emoji each (Unicode ≤ 12, no ZWJ). */
export const BASE_WORDS: Record<string, WordEntry[]> = {
  A: [
    { word: 'apple', emoji: '🍎' },
    { word: 'ant', emoji: '🐜' },
    { word: 'airplane', emoji: '✈️' },
  ],
  B: [
    { word: 'ball', emoji: '⚽' },
    { word: 'banana', emoji: '🍌' },
    { word: 'bear', emoji: '🐻' },
  ],
  C: [
    { word: 'cat', emoji: '🐱' },
    { word: 'car', emoji: '🚗' },
    { word: 'cake', emoji: '🍰' },
  ],
  D: [
    { word: 'dog', emoji: '🐶' },
    { word: 'duck', emoji: '🦆' },
    { word: 'drum', emoji: '🥁' },
  ],
  E: [
    { word: 'elephant', emoji: '🐘' },
    { word: 'egg', emoji: '🥚' },
  ],
  F: [
    { word: 'fish', emoji: '🐟' },
    { word: 'frog', emoji: '🐸' },
    { word: 'flower', emoji: '🌸' },
  ],
  G: [
    { word: 'giraffe', emoji: '🦒' },
    { word: 'grapes', emoji: '🍇' },
    { word: 'goat', emoji: '🐐' },
  ],
  H: [
    { word: 'horse', emoji: '🐴' },
    { word: 'hat', emoji: '🎩' },
    { word: 'house', emoji: '🏠' },
  ],
  I: [
    { word: 'ice cream', emoji: '🍦' },
    { word: 'iguana', emoji: '🦎' },
  ],
  J: [
    { word: 'juice', emoji: '🧃' },
    { word: 'jacket', emoji: '🧥' },
  ],
  K: [
    { word: 'kite', emoji: '🪁' },
    { word: 'koala', emoji: '🐨' },
    { word: 'key', emoji: '🔑' },
  ],
  L: [
    { word: 'lion', emoji: '🦁' },
    { word: 'leaf', emoji: '🍃' },
    { word: 'lemon', emoji: '🍋' },
  ],
  M: [
    { word: 'moon', emoji: '🌙' },
    { word: 'monkey', emoji: '🐵' },
    { word: 'milk', emoji: '🥛' },
  ],
  N: [
    { word: 'nose', emoji: '👃' },
    { word: 'nut', emoji: '🥜' },
  ],
  O: [
    { word: 'octopus', emoji: '🐙' },
    { word: 'owl', emoji: '🦉' },
    { word: 'orange', emoji: '🍊' },
  ],
  P: [
    { word: 'pig', emoji: '🐷' },
    { word: 'penguin', emoji: '🐧' },
    { word: 'pizza', emoji: '🍕' },
  ],
  Q: [
    { word: 'queen', emoji: '👸' },
    { word: 'quack', emoji: '🦆' },
  ],
  R: [
    { word: 'rainbow', emoji: '🌈' },
    { word: 'rabbit', emoji: '🐰' },
    { word: 'rocket', emoji: '🚀' },
  ],
  S: [
    { word: 'sun', emoji: '☀️' },
    { word: 'star', emoji: '⭐' },
    { word: 'snail', emoji: '🐌' },
  ],
  T: [
    { word: 'turtle', emoji: '🐢' },
    { word: 'train', emoji: '🚂' },
    { word: 'tiger', emoji: '🐯' },
  ],
  U: [
    { word: 'umbrella', emoji: '☂️' },
    { word: 'unicorn', emoji: '🦄' },
  ],
  V: [
    { word: 'violin', emoji: '🎻' },
    { word: 'volcano', emoji: '🌋' },
    { word: 'van', emoji: '🚐' },
  ],
  W: [
    { word: 'whale', emoji: '🐳' },
    { word: 'watermelon', emoji: '🍉' },
    { word: 'wave', emoji: '👋' },
  ],
  X: [{ word: 'xylophone', emoji: '🎶' }],
  Y: [
    { word: 'yo-yo', emoji: '🪀' },
    { word: 'yarn', emoji: '🧶' },
  ],
  Z: [{ word: 'zebra', emoji: '🦓' }],
};

/** Letter names spelled phonetically so speech synthesis says the name, not a sound. */
const LETTER_NAMES: Record<string, string> = {
  A: 'ay', B: 'bee', C: 'see', D: 'dee', E: 'ee', F: 'ef', G: 'gee', H: 'aitch', I: 'eye',
  J: 'jay', K: 'kay', L: 'el', M: 'em', N: 'en', O: 'oh', P: 'pee', Q: 'cue', R: 'ar',
  S: 'ess', T: 'tee', U: 'you', V: 'vee', W: 'double you', X: 'ex', Y: 'why', Z: 'zee',
};

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

const SHAPE_LABELS: Record<ShapeKind, string> = {
  circle: 'circle',
  square: 'square',
  triangle: 'triangle',
  star: 'star',
  heart: 'heart',
  diamond: 'diamond',
  moon: 'moon',
  flower: 'flower',
  hexagon: 'hexagon',
  cloud: 'cloud',
};

const SHAPES = Object.keys(SHAPE_LABELS) as ShapeKind[];

/**
 * Punctuation / symbol keys in rough physical order. Each gets the shape at its
 * index (mod 10), so neighbouring keys show different shapes.
 */
const SYMBOL_CODES = [
  'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash',
  'Semicolon', 'Quote', 'Comma', 'Period', 'Slash',
  'IntlBackslash', 'IntlRo', 'IntlYen',
  'NumpadDivide', 'NumpadMultiply', 'NumpadSubtract', 'NumpadAdd',
  'NumpadDecimal', 'NumpadEqual', 'NumpadComma',
];
const SYMBOL_SHAPE = new Map<string, ShapeKind>(SYMBOL_CODES.map((code, i) => [code, SHAPES[i % SHAPES.length]]));

const SPECIALS: Record<string, SpecialEffect> = {
  Space: 'rainbow',
  Enter: 'sweep',
  NumpadEnter: 'sweep',
  Backspace: 'pop-all',
  Delete: 'pop-all',
  ArrowUp: 'comet-up',
  ArrowDown: 'comet-down',
  ArrowLeft: 'comet-left',
  ArrowRight: 'comet-right',
};

const CHEERS = ['Wow!', 'Whee!', 'Boom!', 'Yay!', 'Hooray!', 'Woo-hoo!', 'Ta-da!', 'Amazing!', 'Super!', 'Yippee!'];

const FALLBACK_COLOR: NamedColor = { name: 'blue', hex: '#5cc8ff' };
const FALLBACK_EMOJI = '⭐';

const LETTER_CODE = /^Key([A-Z])$/;
const DIGIT_CODE = /^(?:Digit|Numpad)([0-9])$/;
const ASCII_LETTER = /^[a-z]$/i;

/** FNV-1a: a small, stable string hash (same code → same number, every session). */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Index in [0, length) from a random source, robust to rng() returning exactly 1. */
function pickIndex(rng: () => number, length: number): number {
  const i = Math.floor(rng() * length);
  return i >= 0 && i < length ? i : 0;
}

function pick<T>(rng: () => number, list: readonly T[], fallback: T): T {
  return list.length > 0 ? list[pickIndex(rng, list.length)] : fallback;
}

function colorFor(id: string, ctx: ContentContext): NamedColor {
  const palette = ctx.world.palette;
  return palette.length > 0 ? palette[hash(id) % palette.length] : FALLBACK_COLOR;
}

function friend(ctx: ContentContext): string {
  return pick(ctx.rng, ctx.world.friends, FALLBACK_EMOJI);
}

export function numberWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

export function shapeLabel(shape: ShapeKind): string {
  return SHAPE_LABELS[shape] ?? String(shape);
}

export function cheer(rng: () => number): string {
  return pick(rng, CHEERS, 'Yay!');
}

/**
 * Upper-case letter for a letter key. Prefers the printed letter (`key`) when it
 * is a plain Latin letter, so AZERTY/QWERTZ keyboards show what is on the keycap;
 * otherwise (non-Latin layouts, Option/AltGr symbols) falls back to the physical code.
 */
function letterFor(code: string, key: string): string | null {
  const m = LETTER_CODE.exec(code);
  if (!m) return null;
  return ASCII_LETTER.test(key) ? key.toUpperCase() : m[1];
}

export function contentForKey(press: { code: string; key: string }, ctx: ContentContext): KeyContent {
  const code = typeof press.code === 'string' ? press.code : '';
  const key = typeof press.key === 'string' ? press.key : '';
  const speech = ctx.settings.speech;

  const letter = letterFor(code, key);
  if (letter) {
    const override = ctx.world.words?.[letter];
    const words = override && override.length > 0 ? override : (BASE_WORDS[letter] ?? []);
    const word = words.length > 0 ? words[pickIndex(ctx.rng, words.length)] : null;
    const lower = letter.toLowerCase();
    const display =
      ctx.settings.letterCase === 'lower' ? lower : ctx.settings.letterCase === 'both' ? letter + lower : letter;
    const name = LETTER_NAMES[letter];
    let speak: string | null = null;
    if (speech === 'letter') speak = name;
    else if (speech === 'word') speak = word ? `${name}… ${word.word}!` : name;
    return { kind: 'letter', letter, display, word, color: colorFor(`Key${letter}`, ctx), speak };
  }

  const digitMatch = DIGIT_CODE.exec(code);
  if (digitMatch) {
    const digit = Number(digitMatch[1]);
    const friends = ctx.world.friends;
    return {
      kind: 'digit',
      digit,
      display: String(digit),
      countEmoji: friends.length > 0 ? friends[digit % friends.length] : FALLBACK_EMOJI,
      // Top-row 3 and numpad 3 share a colour: "three is always orange".
      color: colorFor(`Digit${digit}`, ctx),
      speak: speech === 'off' ? null : numberWord(digit),
    };
  }

  const shape = SYMBOL_SHAPE.get(code);
  if (shape) {
    const color = colorFor(code, ctx);
    return {
      kind: 'shape',
      shape,
      color,
      speak: speech === 'off' ? null : `${color.name} ${shapeLabel(shape)}`,
    };
  }

  const effect = Object.prototype.hasOwnProperty.call(SPECIALS, code) ? SPECIALS[code] : undefined;
  if (effect) {
    return { kind: 'special', effect, speak: effect === 'rainbow' && speech === 'word' ? 'rainbow!' : null };
  }

  // Modifiers, F-keys, Tab, Escape, media keys, 'Unidentified', '' …
  return { kind: 'emoji', emoji: friend(ctx), speak: null };
}

/** A tap on empty space: half the time a named shape, otherwise a world friend. */
export function contentForTap(ctx: ContentContext): KeyContent {
  if (ctx.rng() < 0.5) {
    const shape = pick(ctx.rng, SHAPES, 'circle');
    const color = pick(ctx.rng, ctx.world.palette, FALLBACK_COLOR);
    // Naming every tap gets chatty; name roughly one in three.
    const speak = ctx.settings.speech !== 'off' && ctx.rng() < 1 / 3 ? `${color.name} ${shapeLabel(shape)}` : null;
    return { kind: 'shape', shape, color, speak };
  }
  return { kind: 'emoji', emoji: friend(ctx), speak: null };
}
