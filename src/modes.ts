/**
 * Gentle learning games (DESIGN.md §4): Find letters, Find numbers, Spell.
 *
 * Games never fail and never time out. A wrong key gets a kind redirect (rate
 * limited so mashing doesn't turn into nagging) and, after a few tries, a hint
 * showing where the key is. Targets cycle so every letter comes up, leaning
 * toward the ones a child has found least.
 */
import {
  displayLetter,
  digitColor,
  letterColor,
  letterName,
  numberWord,
  praise,
  wordsFor,
} from './content';
import type {
  Challenge,
  ContentContext,
  HintLevel,
  KeyContent,
  LearningGame,
  ModeOutcome,
  PlayMode,
  ProgressStore,
  WordEntry,
} from './types';

/** Short picture words for Spell (3–4 letters, all Unicode ≤ 13 emoji). */
export const SPELL_WORDS: readonly WordEntry[] = Object.freeze([
  { word: 'cat', emoji: '🐱' }, { word: 'dog', emoji: '🐶' }, { word: 'sun', emoji: '☀️' },
  { word: 'bus', emoji: '🚌' }, { word: 'hat', emoji: '🎩' }, { word: 'pig', emoji: '🐷' },
  { word: 'cup', emoji: '☕' }, { word: 'bed', emoji: '🛏️' }, { word: 'fox', emoji: '🦊' },
  { word: 'egg', emoji: '🥚' }, { word: 'bee', emoji: '🐝' }, { word: 'cow', emoji: '🐄' },
  { word: 'owl', emoji: '🦉' }, { word: 'ant', emoji: '🐜' }, { word: 'car', emoji: '🚗' },
  { word: 'map', emoji: '🗺️' }, { word: 'pen', emoji: '🖊️' }, { word: 'box', emoji: '📦' },
  { word: 'fish', emoji: '🐟' }, { word: 'frog', emoji: '🐸' }, { word: 'duck', emoji: '🦆' },
  { word: 'star', emoji: '⭐' }, { word: 'moon', emoji: '🌙' }, { word: 'cake', emoji: '🍰' },
  { word: 'ball', emoji: '⚽' }, { word: 'tree', emoji: '🌳' }, { word: 'boat', emoji: '⛵' },
]);

const LETTERS = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export interface LearningGamesOptions {
  /** How many recent targets to avoid repeating (default 8 letters / 4 digits / 6 words). */
  recentWindow?: number;
  /** Clock for redirect rate limiting (ms). */
  now?: () => number;
  /** Minimum gap between spoken wrong-key redirects (default 2500 ms). */
  redirectGapMs?: number;
}

/** Weighted pick: index i chosen with probability weights[i] / Σweights. */
function weightedPick(weights: number[], rng: () => number): number {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

function hintFor(attempts: number): HintLevel {
  return attempts >= 4 ? 2 : attempts >= 2 ? 1 : 0;
}

export class LearningGames implements LearningGame {
  private modeValue: PlayMode = 'explore';
  private challenge: Challenge | null = null;
  private attempts = 0;
  private lastRedirectAt = Number.NEGATIVE_INFINITY;
  private readonly recent: string[] = [];
  private readonly recentWindow: number | undefined;
  private readonly now: () => number;
  private readonly redirectGapMs: number;

  constructor(
    private readonly progress: ProgressStore | null = null,
    options: LearningGamesOptions = {},
  ) {
    this.recentWindow = options.recentWindow;
    this.now = options.now ?? (() => performance.now());
    this.redirectGapMs = options.redirectGapMs ?? 2500;
  }

  get mode(): PlayMode {
    return this.modeValue;
  }

  setMode(mode: PlayMode, ctx: ContentContext): Challenge | null {
    if (mode !== this.modeValue) this.recent.length = 0;
    this.modeValue = mode;
    return this.begin(ctx);
  }

  current(): Challenge | null {
    return this.challenge;
  }

  begin(ctx: ContentContext): Challenge | null {
    this.attempts = 0;
    this.lastRedirectAt = Number.NEGATIVE_INFINITY;
    this.challenge = this.make(ctx);
    return this.challenge;
  }

  skip(ctx: ContentContext): Challenge | null {
    return this.begin(ctx);
  }

  judge(content: KeyContent, ctx: ContentContext): ModeOutcome {
    const ch = this.challenge;
    if (!ch || this.modeValue === 'explore') return { result: 'free' };

    if (ch.kind === 'find-number') {
      if (content.kind !== 'digit') return { result: 'free' };
      if (content.digit === ch.target) return this.found(ch, `Yes! That's ${numberWord(ch.target)}!`, ctx);
      return this.wrong(ch, `That's ${numberWord(content.digit)}. Can you find ${numberWord(ch.target)}?`);
    }

    if (content.kind !== 'letter') return { result: 'free' };

    if (ch.kind === 'find-letter') {
      if (content.letter === ch.target) return this.found(ch, `Yes! That's ${letterName(ch.target)}!`, ctx);
      return this.wrong(ch, `That's ${letterName(content.letter)}. Can you find ${letterName(ch.target)}?`);
    }

    // Spell: one letter at a time.
    const expected = ch.letters[ch.index];
    if (content.letter !== expected) return this.wrong(ch, `Find ${letterName(expected)}.`);
    const advanced: Challenge = { ...ch, index: ch.index + 1 };
    this.attempts = 0;
    if (advanced.index < ch.letters.length) {
      this.challenge = advanced;
      const nextName = letterName(ch.letters[advanced.index]);
      return { result: 'correct', challenge: advanced, complete: false, next: null, say: `${letterName(expected)}! Now find ${nextName}.` };
    }
    const word = ch.word.word;
    const spelled = ch.letters.map(letterName).join(', ');
    const next = this.begin(ctx);
    return {
      result: 'correct',
      challenge: advanced,
      complete: true,
      next,
      say: `${spelled}… ${word}! You spelled ${word}!`,
    };
  }

  // -------------------------------------------------------------------------

  private found(ch: Challenge, yes: string, ctx: ContentContext): ModeOutcome {
    const extra = ctx.rng() < 0.3 ? ` ${praise(ctx.rng, ctx.settings.childName)}` : '';
    const next = this.begin(ctx);
    return { result: 'correct', challenge: ch, complete: true, next, say: yes + extra };
  }

  private wrong(ch: Challenge, redirect: string): ModeOutcome {
    this.attempts++;
    const t = this.now();
    let say: string | null = null;
    if (t - this.lastRedirectAt >= this.redirectGapMs) {
      say = redirect;
      this.lastRedirectAt = t;
    }
    return { result: 'wrong', challenge: ch, attempts: this.attempts, hint: hintFor(this.attempts), say };
  }

  private remember(key: string, window: number): void {
    this.recent.push(key);
    while (this.recent.length > window) this.recent.shift();
  }

  private make(ctx: ContentContext): Challenge | null {
    switch (this.modeValue) {
      case 'find-letters':
        return this.makeLetter(ctx);
      case 'find-numbers':
        return this.makeNumber(ctx);
      case 'spell':
        return this.makeSpell(ctx);
      default:
        return null;
    }
  }

  private makeLetter(ctx: ContentContext): Challenge {
    const window = this.recentWindow ?? 8;
    const p = this.progress?.get();
    const weights = LETTERS.map((l) => {
      if (this.recent.includes(l)) return 0;
      const found = p?.found[l] ?? 0;
      const seen = Math.min(5, p?.seen[l] ?? 0);
      return (1 / (1 + found)) * (1 + 0.15 * seen);
    });
    const target = LETTERS[weightedPick(weights, ctx.rng)];
    this.remember(target, window);
    const name = letterName(target);
    return {
      kind: 'find-letter',
      target,
      display: displayLetter(target, ctx.settings.letterCase),
      word: wordsFor(target, ctx.world)[0] ?? { word: target.toLowerCase(), emoji: '⭐' },
      color: letterColor(target, ctx.world),
      prompt: `Can you find ${name}?`,
    };
  }

  private makeNumber(ctx: ContentContext): Challenge {
    const window = this.recentWindow ?? 4;
    const p = this.progress?.get();
    const weights = DIGITS.map((d) => (this.recent.includes(String(d)) ? 0 : 1 / (1 + (p?.found[String(d)] ?? 0))));
    const target = DIGITS[weightedPick(weights, ctx.rng)];
    this.remember(String(target), window);
    return {
      kind: 'find-number',
      target,
      display: String(target),
      color: digitColor(target, ctx.world),
      prompt: `Can you find ${numberWord(target)}?`,
    };
  }

  private makeSpell(ctx: ContentContext): Challenge {
    const window = this.recentWindow ?? 6;
    const p = this.progress?.get();
    const weights = SPELL_WORDS.map((w) => (this.recent.includes(w.word) ? 0 : 1 / (1 + (p?.spelled[w.word] ?? 0))));
    const word = SPELL_WORDS[weightedPick(weights, ctx.rng)];
    this.remember(word.word, window);
    const letters = Array.from(word.word.toUpperCase()).filter((c) => c >= 'A' && c <= 'Z');
    return {
      kind: 'spell',
      word,
      letters,
      index: 0,
      color: letterColor(letters[0], ctx.world),
      prompt: `Let's spell ${word.word}. Find ${letterName(letters[0])}.`,
    };
  }
}
