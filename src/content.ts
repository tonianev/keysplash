/**
 * What a key press (or a tap) *teaches* — v2, see DESIGN.md §4.
 *
 * Nothing here is random for key presses: the same key always gives the same
 * letter colour, shape, picture and note, and each letter's words rotate in a
 * fixed order so repetition builds familiarity. Speech strings are spelled so
 * speech synthesis says them the way a parent would ("bee… bee is for ball").
 */
import type {
  ColorName,
  ContentContext,
  DirectionName,
  KeyContent,
  NamedColor,
  ShapeKind,
  SpecialEffect,
  WordEntry,
  World,
} from './types';

/** 'A'…'Z' → toddler-familiar nouns, each with one clear emoji (Unicode ≤ 13, no ZWJ). */
export const BASE_WORDS: Record<string, WordEntry[]> = {
  A: [{ word: 'apple', emoji: '🍎' }, { word: 'ant', emoji: '🐜' }, { word: 'airplane', emoji: '✈️' }],
  B: [{ word: 'ball', emoji: '⚽' }, { word: 'bear', emoji: '🐻' }, { word: 'banana', emoji: '🍌' }],
  C: [{ word: 'cat', emoji: '🐱' }, { word: 'car', emoji: '🚗' }, { word: 'cake', emoji: '🍰' }],
  D: [{ word: 'dog', emoji: '🐶' }, { word: 'duck', emoji: '🦆' }, { word: 'drum', emoji: '🥁' }],
  E: [{ word: 'egg', emoji: '🥚' }, { word: 'elephant', emoji: '🐘' }, { word: 'ear', emoji: '👂' }],
  F: [{ word: 'fish', emoji: '🐟' }, { word: 'frog', emoji: '🐸' }, { word: 'flower', emoji: '🌸' }],
  G: [{ word: 'giraffe', emoji: '🦒' }, { word: 'grapes', emoji: '🍇' }, { word: 'goat', emoji: '🐐' }],
  H: [{ word: 'hat', emoji: '🎩' }, { word: 'horse', emoji: '🐴' }, { word: 'house', emoji: '🏠' }],
  I: [{ word: 'ice cream', emoji: '🍦' }, { word: 'insect', emoji: '🐛' }, { word: 'iguana', emoji: '🦎' }],
  J: [{ word: 'juice', emoji: '🧃' }, { word: 'jacket', emoji: '🧥' }, { word: 'jeans', emoji: '👖' }],
  K: [{ word: 'kite', emoji: '🪁' }, { word: 'koala', emoji: '🐨' }, { word: 'key', emoji: '🔑' }],
  L: [{ word: 'lion', emoji: '🦁' }, { word: 'leaf', emoji: '🍃' }, { word: 'lemon', emoji: '🍋' }],
  M: [{ word: 'moon', emoji: '🌙' }, { word: 'monkey', emoji: '🐵' }, { word: 'milk', emoji: '🥛' }],
  N: [{ word: 'nose', emoji: '👃' }, { word: 'nut', emoji: '🥜' }, { word: 'net', emoji: '🥅' }],
  O: [{ word: 'owl', emoji: '🦉' }, { word: 'octopus', emoji: '🐙' }, { word: 'orange', emoji: '🍊' }],
  P: [{ word: 'pig', emoji: '🐷' }, { word: 'penguin', emoji: '🐧' }, { word: 'pizza', emoji: '🍕' }],
  Q: [{ word: 'queen', emoji: '👸' }],
  R: [{ word: 'rainbow', emoji: '🌈' }, { word: 'rabbit', emoji: '🐰' }, { word: 'rocket', emoji: '🚀' }],
  S: [{ word: 'sun', emoji: '☀️' }, { word: 'star', emoji: '⭐' }, { word: 'snail', emoji: '🐌' }],
  T: [{ word: 'tree', emoji: '🌳' }, { word: 'turtle', emoji: '🐢' }, { word: 'train', emoji: '🚂' }],
  U: [{ word: 'umbrella', emoji: '☂️' }, { word: 'unicorn', emoji: '🦄' }],
  V: [{ word: 'van', emoji: '🚐' }, { word: 'violin', emoji: '🎻' }, { word: 'volcano', emoji: '🌋' }],
  W: [{ word: 'whale', emoji: '🐳' }, { word: 'watermelon', emoji: '🍉' }, { word: 'worm', emoji: '🪱' }],
  // Few toddler nouns start with x, so feature the x inside familiar words.
  X: [{ word: 'fox', emoji: '🦊', at: 2 }, { word: 'box', emoji: '📦', at: 2 }],
  Y: [{ word: 'yo-yo', emoji: '🪀' }, { word: 'yarn', emoji: '🧶' }],
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
  circle: 'circle', square: 'square', triangle: 'triangle', star: 'star', heart: 'heart',
  diamond: 'diamond', moon: 'moon', oval: 'oval', hexagon: 'hexagon', rectangle: 'rectangle',
};
const SHAPES = Object.keys(SHAPE_LABELS) as ShapeKind[];

/** Countable things for digit cards: [singular, plural, emoji]. Fixed per digit. */
const COUNTABLES: ReadonlyArray<readonly [string, string, string]> = [
  ['star', 'stars', '⭐'],
  ['apple', 'apples', '🍎'],
  ['ball', 'balls', '⚽'],
  ['duck', 'ducks', '🦆'],
  ['fish', 'fish', '🐟'],
  ['flower', 'flowers', '🌸'],
  ['balloon', 'balloons', '🎈'],
  ['car', 'cars', '🚗'],
  ['bear', 'bears', '🐻'],
  ['heart', 'hearts', '❤️'],
];

/**
 * Pictures for every other key (modifiers, F-keys, Tab, Esc…): farm/home
 * animals and objects. Fixed per key code; unknown codes hash into the list.
 */
const PICTURES: ReadonlyArray<readonly [string, string]> = [
  ['cow', '🐄'], ['pig', '🐖'], ['sheep', '🐑'], ['horse', '🐎'], ['hen', '🐔'], ['duck', '🦆'],
  ['dog', '🐕'], ['cat', '🐈'], ['rabbit', '🐇'], ['mouse', '🐁'], ['frog', '🐸'], ['owl', '🦉'],
  ['bee', '🐝'], ['ladybug', '🐞'], ['turtle', '🐢'], ['fish', '🐟'], ['bird', '🐦'], ['bear', '🐻'],
  ['lion', '🦁'], ['elephant', '🐘'], ['giraffe', '🦒'], ['zebra', '🦓'], ['monkey', '🐒'], ['penguin', '🐧'],
  ['car', '🚗'], ['bus', '🚌'], ['train', '🚂'], ['boat', '⛵'], ['airplane', '✈️'], ['ball', '⚽'],
];

/** Codes with a deliberate picture, so the most-hit keys feel intentional. */
const PICTURE_FOR_CODE: Record<string, number> = {
  F1: 0, F2: 1, F3: 2, F4: 3, F5: 4, F6: 5, F7: 6, F8: 7, F9: 8, F10: 9, F11: 10, F12: 11,
  ShiftLeft: 12, ShiftRight: 13, ControlLeft: 14, ControlRight: 15, AltLeft: 16, AltRight: 17,
  MetaLeft: 18, MetaRight: 19, Tab: 20, CapsLock: 21, Escape: 22, ContextMenu: 23,
  Insert: 24, Home: 25, End: 26, PageUp: 27, PageDown: 28, Fn: 29,
};

/** Punctuation/symbol keys → a fixed shape and colour each. */
const SYMBOL_CODES = [
  'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma',
  'Period', 'Slash', 'Backquote', 'IntlBackslash', 'IntlRo', 'IntlYen', 'NumpadAdd', 'NumpadSubtract',
  'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEqual', 'NumpadComma',
];
const SYMBOL_INDEX = new Map<string, number>(SYMBOL_CODES.map((code, i) => [code, i]));

const SPECIALS: Record<string, SpecialEffect> = {
  Space: 'rainbow',
  Enter: 'clear', NumpadEnter: 'clear', Backspace: 'clear', Delete: 'clear',
};

const DIRECTIONS: Record<string, DirectionName> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};
const DIRECTION_COLOR: Record<DirectionName, ColorName> = { up: 'blue', down: 'green', left: 'orange', right: 'purple' };

const RAINBOW_ORDER: ColorName[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

const PRAISE = ['Great job!', 'You did it!', 'Wonderful!', 'Well done!', 'Hooray!', 'Super!', 'Yay!', 'Amazing!'];

const FALLBACK_COLOR: NamedColor = { name: 'blue', hex: '#4A86D8', container: '#DFEAFB', ink: '#1D4F99' };

const LETTER_CODE = /^Key([A-Z])$/;
const DIGIT_CODE = /^(?:Digit|Numpad)([0-9])$/;
const ASCII_LETTER = /^[a-z]$/i;

/** Small stable string hash (FNV-1a). */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function paletteAt(world: World, index: number): NamedColor {
  const p = world.palette;
  return p.length ? p[((index % p.length) + p.length) % p.length] : FALLBACK_COLOR;
}

function colorNamed(world: World, name: ColorName): NamedColor {
  return world.palette.find((c) => c.name === name) ?? paletteAt(world, RAINBOW_ORDER.indexOf(name));
}

// ---------------------------------------------------------------------------
// Public helpers (shared with the learning games and the UI)
// ---------------------------------------------------------------------------

/** Phonetic letter name for speech: 'B' → 'bee'. */
export function letterName(letter: string): string {
  return LETTER_NAMES[letter.toUpperCase()] ?? letter.toLowerCase();
}

/** 0..10 → 'zero'…'ten'; other numbers as digits. */
export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

export function shapeLabel(shape: ShapeKind): string {
  return SHAPE_LABELS[shape] ?? shape;
}

export function directionWord(direction: DirectionName): string {
  return direction;
}

/** A letter's colour: fixed per letter (A red, B orange, C yellow… cycling the palette). */
export function letterColor(letter: string, world: World): NamedColor {
  const i = letter.toUpperCase().charCodeAt(0) - 65;
  return paletteAt(world, i >= 0 && i < 26 ? i : hash(letter));
}

/** A digit's colour: fixed per digit. */
export function digitColor(digit: number, world: World): NamedColor {
  return paletteAt(world, digit + 1);
}

/** Cased display for a letter: 'B', 'b' or 'Bb'. */
export function displayLetter(letter: string, letterCase: 'upper' | 'lower' | 'both'): string {
  const upper = letter.toUpperCase();
  if (letterCase === 'lower') return upper.toLowerCase();
  if (letterCase === 'both') return upper + upper.toLowerCase();
  return upper;
}

/** World-themed words first, then the base words (no duplicates). */
export function wordsFor(letter: string, world: World): WordEntry[] {
  const upper = letter.toUpperCase();
  const themed = world.words?.[upper] ?? [];
  const base = BASE_WORDS[upper] ?? [];
  const seen = new Set(themed.map((w) => w.word));
  return [...themed, ...base.filter((w) => !seen.has(w.word))];
}

/** The six rainbow colours of a world, outermost band first. */
export function rainbowColors(world: World): NamedColor[] {
  return RAINBOW_ORDER.map((name) => colorNamed(world, name));
}

/** Warm praise; sometimes with the child's name. */
export function praise(rng: () => number, childName = ''): string {
  const name = childName.trim();
  if (name && rng() < 0.35) return `Great job, ${name}!`;
  return PRAISE[Math.min(PRAISE.length - 1, Math.floor(rng() * PRAISE.length))];
}

/** The upper-case letter a key press means, or null. */
export function letterFor(code: string, key: string): string | null {
  // Prefer the printed letter (AZERTY/QWERTZ), fall back to the physical key.
  if (ASCII_LETTER.test(key)) return key.toUpperCase();
  const m = LETTER_CODE.exec(code);
  return m ? m[1] : null;
}

/** The digit a key press means (number row or numpad), or null. */
export function digitFor(code: string): number | null {
  const m = DIGIT_CODE.exec(code);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// LessonContent: key press → what it teaches
// ---------------------------------------------------------------------------

/**
 * Turns key presses and taps into lessons. Holds one word cursor per letter so
 * each letter's words rotate in order (ball → bear → banana → ball…). Key
 * presses never use randomness; only taps do (a random shape at your finger).
 */
export class LessonContent {
  /** Next word index per upper-case letter (bounded: at most 26 entries). */
  private readonly cursors = new Map<string, number>();
  private taps = 0;

  forKey(press: { code: string; key: string }, ctx: ContentContext): KeyContent {
    const { code, key } = press;
    const { world, settings } = ctx;
    const speech = settings.speech;

    const special = SPECIALS[code];
    if (special) {
      return { kind: 'special', effect: special, speak: special === 'clear' && speech === 'word' ? 'all clean!' : null };
    }

    const direction = DIRECTIONS[code];
    if (direction) {
      return {
        kind: 'direction',
        direction,
        color: colorNamed(world, DIRECTION_COLOR[direction]),
        speak: speech === 'off' ? null : `${direction}!`,
      };
    }

    const digit = digitFor(code);
    if (digit !== null) return this.digit(digit, ctx);

    const letter = letterFor(code, key);
    if (letter) return this.letter(letter, ctx);

    const symbol = SYMBOL_INDEX.get(code);
    if (symbol !== undefined) {
      const shape = SHAPES[symbol % SHAPES.length];
      return this.shape(shape, paletteAt(world, symbol * 3), ctx, true);
    }

    const [word, emoji] = PICTURES[PICTURE_FOR_CODE[code] ?? hash(code || 'none') % PICTURES.length];
    return { kind: 'picture', emoji, word, speak: speech === 'off' ? null : word };
  }

  /** A tap on empty space: a random shape and colour, named every third tap. */
  forTap(ctx: ContentContext): KeyContent {
    const { rng, world } = ctx;
    const shape = SHAPES[Math.min(SHAPES.length - 1, Math.floor(rng() * SHAPES.length))];
    const color = paletteAt(world, Math.floor(rng() * world.palette.length));
    this.taps = (this.taps + 1) % 3;
    return this.shape(shape, color, ctx, this.taps === 0);
  }

  /** The word a letter would show next, without advancing (for prompts). */
  peekWord(letter: string, world: World): WordEntry {
    const list = wordsFor(letter, world);
    const i = this.cursors.get(letter.toUpperCase()) ?? 0;
    return list[i % Math.max(1, list.length)] ?? { word: letter.toLowerCase(), emoji: '⭐' };
  }

  private letter(letter: string, ctx: ContentContext): KeyContent {
    const { world, settings } = ctx;
    const list = wordsFor(letter, world);
    const i = this.cursors.get(letter) ?? 0;
    const word = list[i % Math.max(1, list.length)] ?? { word: letter.toLowerCase(), emoji: '⭐' };
    this.cursors.set(letter, (i + 1) % Math.max(1, list.length));

    const name = letterName(letter);
    let speak: string | null = null;
    if (settings.speech === 'letter') speak = name;
    else if (settings.speech === 'word') {
      speak = (word.at ?? 0) === 0 ? `${name}… ${name} is for ${word.word}` : `${name}… ${word.word}`;
    }
    return {
      kind: 'letter',
      letter,
      display: displayLetter(letter, settings.letterCase),
      word,
      color: letterColor(letter, world),
      speak,
    };
  }

  private digit(digit: number, ctx: ContentContext): KeyContent {
    const { world, settings } = ctx;
    const [singular, plural, emoji] = COUNTABLES[digit % COUNTABLES.length];
    const noun = digit === 1 ? singular : plural;
    const counting = settings.speech !== 'off';
    const countWords = counting ? NUMBER_WORDS.slice(1, digit + 1) : [];
    let speak: string | null = null;
    if (settings.speech === 'word') speak = digit === 0 ? 'zero — none!' : `${numberWord(digit)} ${noun}!`;
    else if (settings.speech === 'letter' && digit === 0) speak = 'zero';
    return {
      kind: 'digit',
      digit,
      display: String(digit),
      countEmoji: emoji,
      countNoun: noun,
      color: digitColor(digit, world),
      countWords,
      speak,
    };
  }

  private shape(shape: ShapeKind, color: NamedColor, ctx: ContentContext, named: boolean): KeyContent {
    const label = shapeLabel(shape);
    const speak = named && ctx.settings.speech !== 'off' ? `${color.name} ${label}` : null;
    return { kind: 'shape', shape, color, label, speak };
  }
}
