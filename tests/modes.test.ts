import { describe, expect, it } from 'vitest';
import { LessonContent, digitColor, letterColor } from '../src/content';
import { LearningGames, SPELL_WORDS } from '../src/modes';
import { DEFAULT_SETTINGS } from '../src/settings';
import { WORLDS } from '../src/worlds';
import { seeded } from './fakes';
import type {
  Challenge,
  ContentContext,
  KeyContent,
  LearningProgress,
  ModeOutcome,
  ProgressStore,
  Settings,
} from '../src/types';

/** Cycles through fixed values. */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

function ctx(rng: () => number = () => 0, settings: Partial<Settings> = {}): ContentContext {
  return { world: WORLDS.paper, settings: { ...DEFAULT_SETTINGS, ...settings }, rng };
}

/** Read-only progress fake. */
function progressWith(found: Record<string, number> = {}, spelled: Record<string, number> = {}): ProgressStore {
  const p: LearningProgress = { seen: {}, found, spelled, since: null };
  return {
    get: () => p,
    markSeen: () => undefined,
    markFound: () => undefined,
    markSpelled: () => undefined,
    reset: () => undefined,
    subscribe: () => () => undefined,
  };
}

const lessons = new LessonContent();
/** What pressing a key teaches (LessonContent never touches the rng). */
function key(code: string, keyText = ''): KeyContent {
  return lessons.forKey({ code, key: keyText }, ctx(() => 0.5));
}
const letter = (l: string) => key(`Key${l}`, l.toLowerCase());

function expectResult<R extends ModeOutcome['result']>(o: ModeOutcome, r: R): Extract<ModeOutcome, { result: R }> {
  expect(o.result).toBe(r);
  return o as Extract<ModeOutcome, { result: R }>;
}

function asKind<K extends Challenge['kind']>(c: Challenge | null, kind: K): Extract<Challenge, { kind: K }> {
  expect(c?.kind).toBe(kind);
  return c as Extract<Challenge, { kind: K }>;
}

/** rng value that makes the first spell pick (no history) choose `word`. */
function pickWord(word: string): number {
  const i = SPELL_WORDS.findIndex((w) => w.word === word);
  expect(i).toBeGreaterThanOrEqual(0);
  return (i + 0.5) / SPELL_WORDS.length;
}

describe('explore mode', () => {
  it('has no challenge and free-plays every key', () => {
    const g = new LearningGames();
    expect(g.mode).toBe('explore');
    expect(g.begin(ctx())).toBeNull();
    expect(g.current()).toBeNull();
    for (const c of [letter('A'), key('Digit3'), key('Space'), key('ArrowUp')]) {
      expect(g.judge(c, ctx())).toEqual({ result: 'free' });
    }
  });

  it('switching back to explore clears the challenge', () => {
    const g = new LearningGames();
    expect(g.setMode('find-letters', ctx())).not.toBeNull();
    expect(g.setMode('explore', ctx())).toBeNull();
    expect(g.current()).toBeNull();
    expect(g.judge(letter('A'), ctx())).toEqual({ result: 'free' });
    expect(g.skip(ctx())).toBeNull();
  });
});

describe('find letters', () => {
  it('starts a challenge with prompt, picture, colour and cased display', () => {
    const g = new LearningGames(null, { now: () => 0 });
    const ch = asKind(g.setMode('find-letters', ctx(() => 0)), 'find-letter');
    expect(g.mode).toBe('find-letters');
    expect(ch.target).toBe('A');
    expect(ch.display).toBe('Aa'); // default letterCase 'both'
    expect(ch.prompt).toBe('Can you find ay?');
    expect(ch.word.word).toBe('apple');
    expect(ch.color).toEqual(letterColor('A', WORLDS.paper));
    expect(g.current()).toBe(ch);
  });

  it('reflects letterCase in the display', () => {
    const g = new LearningGames();
    expect(asKind(g.setMode('find-letters', ctx(() => 0, { letterCase: 'upper' })), 'find-letter').display).toBe('A');
    expect(asKind(g.skip(ctx(() => 0, { letterCase: 'lower' })), 'find-letter').display).toBe('b');
  });

  it('non-letter keys are free play', () => {
    const g = new LearningGames();
    g.setMode('find-letters', ctx());
    for (const c of [key('Digit3'), key('Numpad1'), key('Space'), key('Enter'), key('ArrowUp'), key('Minus'), key('F1')]) {
      expect(g.judge(c, ctx())).toEqual({ result: 'free' });
    }
  });

  it('a correct key completes, says yes, and moves to the next challenge', () => {
    const g = new LearningGames();
    const first = g.setMode('find-letters', ctx(() => 0));
    // 0.9 → no extra praise; then 0 picks the next letter (A is recent → B).
    const o = expectResult(g.judge(letter('A'), ctx(seq(0.9, 0))), 'correct');
    expect(o.complete).toBe(true);
    expect(o.challenge).toBe(first);
    expect(o.say).toBe("Yes! That's ay!");
    expect(asKind(o.next, 'find-letter').target).toBe('B');
    expect(g.current()).toBe(o.next);
  });

  it('sometimes adds praise with the child name', () => {
    const g = new LearningGames();
    g.setMode('find-letters', ctx(() => 0));
    const o = expectResult(g.judge(letter('A'), ctx(() => 0.1, { childName: 'Mia' })), 'correct');
    expect(o.say).toBe("Yes! That's ay! Great job, Mia!");
  });

  it('wrong keys redirect gently and escalate hints at 2 and 4 attempts', () => {
    let t = 0;
    const g = new LearningGames(null, { now: () => t, redirectGapMs: 0 });
    g.setMode('find-letters', ctx(() => 0));
    const hints: number[] = [];
    for (let i = 1; i <= 5; i++) {
      t += 10;
      const o = expectResult(g.judge(letter('M'), ctx()), 'wrong');
      expect(o.attempts).toBe(i);
      expect(o.say).toBe("That's em. Can you find ay?");
      expect(asKind(o.challenge, 'find-letter').target).toBe('A');
      hints.push(o.hint);
    }
    expect(hints).toEqual([0, 1, 1, 2, 2]);
  });

  it('rate-limits spoken redirects using the injected clock', () => {
    let t = 1000;
    const g = new LearningGames(null, { now: () => t });
    g.setMode('find-letters', ctx(() => 0));
    expect(expectResult(g.judge(letter('M'), ctx()), 'wrong').say).not.toBeNull();
    t += 2499;
    expect(expectResult(g.judge(letter('M'), ctx()), 'wrong').say).toBeNull();
    t += 1;
    expect(expectResult(g.judge(letter('Q'), ctx()), 'wrong').say).toBe("That's cue. Can you find ay?");
    t += 100;
    const o = expectResult(g.judge(letter('Q'), ctx()), 'wrong');
    expect(o.say).toBeNull();
    expect(o.attempts).toBe(4); // still counted while quiet
  });

  it('a correct answer resets attempts, hints and the redirect limiter', () => {
    const t = 0;
    const g = new LearningGames(null, { now: () => t });
    g.setMode('find-letters', ctx(() => 0));
    for (let i = 0; i < 4; i++) g.judge(letter('M'), ctx());
    g.judge(letter('A'), ctx(seq(0.9, 0))); // now B
    const o = expectResult(g.judge(letter('M'), ctx()), 'wrong');
    expect(o.attempts).toBe(1);
    expect(o.hint).toBe(0);
    expect(o.say).toBe("That's em. Can you find bee?"); // same clock, but a fresh challenge
  });

  it('skip replaces the challenge and resets attempts', () => {
    const g = new LearningGames(null, { now: () => 0 });
    g.setMode('find-letters', ctx(() => 0));
    g.judge(letter('M'), ctx());
    g.judge(letter('M'), ctx());
    const next = asKind(g.skip(ctx(() => 0)), 'find-letter');
    expect(next.target).toBe('B');
    expect(expectResult(g.judge(letter('M'), ctx()), 'wrong').attempts).toBe(1);
  });
});

describe('target selection', () => {
  it('cycles letters without repeating any of the last 8 targets', () => {
    const g = new LearningGames();
    const c = ctx(seeded(11));
    const targets: string[] = [asKind(g.setMode('find-letters', c), 'find-letter').target];
    for (let i = 0; i < 200; i++) targets.push(asKind(g.skip(c), 'find-letter').target);
    for (let i = 0; i < targets.length; i++) {
      const window = targets.slice(Math.max(0, i - 8), i);
      expect(window, `pick ${i}`).not.toContain(targets[i]);
    }
    expect(new Set(targets).size).toBe(26); // every letter comes up
  });

  it('with rng 0 walks the alphabet in order, then reuses the oldest', () => {
    const g = new LearningGames();
    const picks = [asKind(g.setMode('find-letters', ctx()), 'find-letter').target];
    for (let i = 0; i < 9; i++) picks.push(asKind(g.skip(ctx()), 'find-letter').target);
    expect(picks.join('')).toBe('ABCDEFGHIA');
  });

  it('honours a custom recentWindow', () => {
    const g = new LearningGames(null, { recentWindow: 2 });
    const picks = [asKind(g.setMode('find-letters', ctx()), 'find-letter').target];
    for (let i = 0; i < 4; i++) picks.push(asKind(g.skip(ctx()), 'find-letter').target);
    expect(picks.join('')).toBe('ABCAB');
  });

  it('numbers avoid the last 4 targets', () => {
    const g = new LearningGames();
    const c = ctx(seeded(5));
    const picks = [asKind(g.setMode('find-numbers', c), 'find-number').target];
    for (let i = 0; i < 100; i++) picks.push(asKind(g.skip(c), 'find-number').target);
    for (let i = 0; i < picks.length; i++) expect(picks.slice(Math.max(0, i - 4), i)).not.toContain(picks[i]);
    expect(new Set(picks).size).toBe(10);
  });

  it('leans toward letters the child has found least', () => {
    const found: Record<string, number> = {};
    for (const l of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') found[l] = 50;
    delete found.Q;
    delete found.Z;
    const g = new LearningGames(progressWith(found), { recentWindow: 0 });
    const c = ctx(seeded(3));
    const counts: Record<string, number> = {};
    const first = asKind(g.setMode('find-letters', c), 'find-letter').target;
    counts[first] = 1;
    for (let i = 0; i < 300; i++) {
      const t = asKind(g.skip(c), 'find-letter').target;
      counts[t] = (counts[t] ?? 0) + 1;
    }
    const rare = (counts.Q ?? 0) + (counts.Z ?? 0);
    expect(rare).toBeGreaterThan(200); // ~2 / (2 + 24/51) ≈ 81% of picks
    for (const l of 'ABCDEFGHIJKLMNOPRSTUVWXY') expect(counts[l] ?? 0).toBeLessThan(counts.Q ?? 0);
  });

  it('leans toward digits and words found or spelled least', () => {
    const found: Record<string, number> = {};
    for (let d = 0; d <= 9; d++) if (d !== 7) found[String(d)] = 100;
    const g = new LearningGames(progressWith(found), { recentWindow: 0 });
    const c = ctx(seeded(9));
    let sevens = 0;
    for (let i = 0; i < 100; i++) if (asKind(g.setMode('find-numbers', c), 'find-number').target === 7) sevens++;
    expect(sevens).toBeGreaterThan(80);

    const spelled: Record<string, number> = {};
    for (const w of SPELL_WORDS) if (w.word !== 'frog') spelled[w.word] = 100;
    const s = new LearningGames(progressWith({}, spelled), { recentWindow: 0 });
    let frogs = 0;
    for (let i = 0; i < 100; i++) if (asKind(s.setMode('spell', c), 'spell').word.word === 'frog') frogs++;
    expect(frogs).toBeGreaterThan(70);
  });

  it('changing mode forgets recent targets', () => {
    const g = new LearningGames();
    g.setMode('find-letters', ctx()); // A recent
    g.setMode('find-numbers', ctx());
    expect(asKind(g.setMode('find-letters', ctx()), 'find-letter').target).toBe('A');
  });
});

describe('find numbers', () => {
  it('asks for a digit; number row and numpad both count', () => {
    for (const code of ['Digit0', 'Numpad0']) {
      const g = new LearningGames();
      const ch = asKind(g.setMode('find-numbers', ctx(() => 0)), 'find-number');
      expect(ch).toMatchObject({ target: 0, display: '0', prompt: 'Can you find zero?' });
      expect(ch.color).toEqual(digitColor(0, WORLDS.paper));
      const o = expectResult(g.judge(key(code), ctx(seq(0.9, 0))), 'correct');
      expect(o.say).toBe("Yes! That's zero!");
      expect(asKind(o.next, 'find-number').target).toBe(1);
    }
  });

  it('wrong digits redirect; letters and other keys are free play', () => {
    const g = new LearningGames(null, { now: () => 0 });
    g.setMode('find-numbers', ctx(() => 0));
    const o = expectResult(g.judge(key('Numpad3'), ctx()), 'wrong');
    expect(o.say).toBe("That's three. Can you find zero?");
    expect(o.attempts).toBe(1);
    for (const c of [letter('A'), key('Space'), key('ArrowLeft'), key('Comma')]) {
      expect(g.judge(c, ctx())).toEqual({ result: 'free' });
    }
  });
});

describe('spell', () => {
  it('starts with the word, its letters and a prompt', () => {
    const g = new LearningGames();
    const ch = asKind(g.setMode('spell', ctx(() => pickWord('cat'))), 'spell');
    expect(ch.word.word).toBe('cat');
    expect(ch.letters).toEqual(['C', 'A', 'T']);
    expect(ch.index).toBe(0);
    expect(ch.prompt).toBe("Let's spell cat. Find see.");
    expect(ch.color).toEqual(letterColor('C', WORLDS.paper));
  });

  it('fills letters one at a time and finishes with the spelled-out line', () => {
    const g = new LearningGames();
    g.setMode('spell', ctx(() => pickWord('cat')));
    const c1 = expectResult(g.judge(letter('C'), ctx()), 'correct');
    expect(c1).toMatchObject({ complete: false, next: null, say: 'see! Now find ay.' });
    expect(asKind(c1.challenge, 'spell').index).toBe(1);
    expect(g.current()).toBe(c1.challenge);
    expectResult(g.judge(letter('A'), ctx()), 'correct');
    const done = expectResult(g.judge(letter('T'), ctx(() => 0)), 'correct');
    expect(done.complete).toBe(true);
    expect(done.say).toBe('see, ay, tee… cat! You spelled cat!');
    expect(asKind(done.challenge, 'spell').index).toBe(3);
    const next = asKind(done.next, 'spell');
    expect(next.index).toBe(0);
    expect(next.word.word).not.toBe('cat');
    expect(g.current()).toBe(next);
  });

  for (const [word, line] of [
    ['egg', 'ee, gee, gee… egg! You spelled egg!'],
    ['ball', 'bee, ay, el, el… ball! You spelled ball!'],
    ['bee', 'bee, ee, ee… bee! You spelled bee!'],
  ] as const) {
    it(`completes '${word}' with repeated letters`, () => {
      const g = new LearningGames();
      const ch = asKind(g.setMode('spell', ctx(() => pickWord(word))), 'spell');
      const letters = Array.from(word.toUpperCase());
      expect(ch.letters).toEqual(letters);
      let last: ModeOutcome | null = null;
      letters.forEach((l, i) => {
        last = g.judge(letter(l), ctx(() => 0));
        const o = expectResult(last, 'correct');
        expect(o.complete).toBe(i === letters.length - 1);
      });
      expect(expectResult(last!, 'correct').say).toBe(line);
    });
  }

  it('wrong letters stay on the same index with a gentle "Find …" and hints', () => {
    const g = new LearningGames(null, { now: () => 0, redirectGapMs: 0 });
    g.setMode('spell', ctx(() => pickWord('egg')));
    g.judge(letter('E'), ctx());
    const w1 = expectResult(g.judge(letter('X'), ctx()), 'wrong');
    expect(w1.say).toBe('Find gee.');
    expect(asKind(w1.challenge, 'spell').index).toBe(1);
    const w2 = expectResult(g.judge(letter('E'), ctx()), 'wrong');
    expect(w2.hint).toBe(1);
    // A right letter resets attempts.
    expectResult(g.judge(letter('G'), ctx()), 'correct');
    expect(expectResult(g.judge(letter('Z'), ctx()), 'wrong').attempts).toBe(1);
  });

  it('digits and other keys are free play', () => {
    const g = new LearningGames();
    g.setMode('spell', ctx(() => pickWord('cat')));
    for (const c of [key('Digit1'), key('Space'), key('ArrowDown'), key('Enter')]) {
      expect(g.judge(c, ctx())).toEqual({ result: 'free' });
    }
    expect(asKind(g.current(), 'spell').index).toBe(0);
  });

  it('every spell word is 3–4 plain letters, no duplicates', () => {
    for (const w of SPELL_WORDS) expect(w.word).toMatch(/^[a-z]{3,4}$/);
    expect(new Set(SPELL_WORDS.map((w) => w.word)).size).toBe(SPELL_WORDS.length);
  });

  it('contains every word DESIGN.md lists', () => {
    const design = 'cat dog sun bus hat pig cup bed fox egg bee cow owl ant car map pen box fish frog duck star moon cake ball tree boat';
    expect(SPELL_WORDS.map((w) => w.word).sort()).toEqual(design.split(' ').sort());
  });
});

describe('LearningGames: voice switch', () => {
  it('still builds prompts and lines when the voice is off (the speaker applies Settings.voice)', () => {
    const games = new LearningGames(null, { now: () => 0 });
    const c = ctx(() => 0, { voice: false });
    const ch = games.setMode('find-letters', c);
    expect(ch?.prompt).toBe('Can you find ay?');
    const out = games.judge(lessons.forKey({ code: 'KeyA', key: 'a' }, c), c);
    expect(out).toMatchObject({ result: 'correct', say: "Yes! That's ay! Great job!" });
  });
});
