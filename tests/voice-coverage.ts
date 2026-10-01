/**
 * Replays everything KeySplash can say (every key in every world and speech
 * mode, taps, greetings, praise, and all three learning games until every
 * target has come up) and asserts each line resolves to clips in `clips`.
 * Used against the inventory (tests/inventory.test.ts) and the generated
 * manifest (tests/voice-manifest.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LessonContent, SHAPES, letterName, numberWord, praise, rainbowColors, shapeLabel, wordsFor } from '../src/content';
import { describeKeyLocation } from '../src/keymap';
import { LearningGames, SPELL_WORDS } from '../src/modes';
import { PRAISE, greetingFor, helloFor, lines, withPraise } from '../src/phrases';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { Challenge, ContentContext, KeyContent, Settings, World } from '../src/types';
import { WORLDS, WORLD_ORDER } from '../src/worlds';
import { seeded } from './fakes';
import { resolveClips } from '../src/voice/normalize';

export function describeVoiceCoverage(title: string, clips: Record<string, [string, number]>): void {
  describe(title, () => {
    const missing = new Set<string>();
    afterEach(() => {
      const lines = [...missing];
      missing.clear();
      expect(lines).toEqual([]);
    });
    const check = (line: string | null | undefined): void => {
      if (line && resolveClips(line, clips) === null) missing.add(line);
    };
    const ctxFor = (world: World, settings: Partial<Settings> = {}, rng: () => number = () => 0): ContentContext => ({
      world,
      settings: { ...DEFAULT_SETTINGS, ...settings },
      rng,
    });
    const LETTERS = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    const OTHER_CODES = [
      'Space', 'Enter', 'NumpadEnter', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash',
      'Backquote', 'IntlBackslash', 'IntlRo', 'IntlYen', 'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide',
      'NumpadDecimal', 'NumpadEqual', 'NumpadComma',
      ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
      'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'Tab',
      'CapsLock', 'Escape', 'ContextMenu', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Fn',
      'MediaPlayPause', 'AudioVolumeUp', 'Unidentified', '', ...Array.from({ length: 40 }, (_, i) => `Weird${i}`),
    ];

    it('key presses in every world and speech mode', () => {
      for (const world of WORLD_ORDER.map((id) => WORLDS[id])) {
        for (const speech of ['letter', 'word'] as const) {
          const lc = new LessonContent();
          const c = ctxFor(world, { speech });
          const say = (content: KeyContent): void => {
            check(content.speak);
            if (content.kind === 'digit') content.countWords.forEach(check);
          };
          for (const l of LETTERS) {
            // Cycle the word cursor through every word for this letter (and then some).
            for (let i = 0; i < wordsFor(l, world).length + 1; i++) say(lc.forKey({ code: `Key${l}`, key: l.toLowerCase() }, c));
          }
          for (let d = 0; d <= 9; d++) {
            say(lc.forKey({ code: `Digit${d}`, key: String(d) }, c));
            say(lc.forKey({ code: `Numpad${d}`, key: String(d) }, c));
          }
          for (const code of OTHER_CODES) say(lc.forKey({ code, key: '' }, c));
          // Game extras: the rainbow names its colours; a poked shape is named.
          for (const color of rainbowColors(world)) check(color.name);
          for (const color of world.palette) for (const s of SHAPES) check(`${color.name} ${shapeLabel(s)}`);
        }
      }
    });

    it('every tap colour × shape', () => {
      for (const world of WORLD_ORDER.map((id) => WORLDS[id])) {
        for (let s = 0; s < SHAPES.length; s++) {
          for (let p = 0; p < world.palette.length; p++) {
            const lc = new LessonContent();
            const rng = (() => {
              let i = 0;
              const v = [(s + 0.5) / SHAPES.length, (p + 0.5) / world.palette.length];
              return () => v[i++ % 2];
            })();
            const c = ctxFor(world, {}, rng);
            lc.forTap(c);
            lc.forTap(c);
            const named = lc.forTap(c);
            expect(named.speak).not.toBeNull();
            check(named.speak);
          }
        }
      }
    });

    it('greetings, cheers and nameless praise', () => {
      check(greetingFor(''));
      check(helloFor(''));
      check(lines.yay());
      for (let i = 0; i < PRAISE.length; i++) check(praise(() => (i + 0.5) / PRAISE.length, ''));
    });

    it('learning games: every letter, number and spell word — right, wrong and with hints', () => {
      let t = 0;
      const now = () => (t += 10_000); // never rate-limit redirects
      const withHint = (line: string | null, code: string): string => `${line ?? ''} ${describeKeyLocation(code)}`.trim();
      const press = (lc: LessonContent, c: ContentContext, code: string, key: string): KeyContent => lc.forKey({ code, key }, c);
      for (const world of WORLD_ORDER.map((id) => WORLDS[id])) {
        const rng = seeded(7);
        const c = ctxFor(world, { childName: '' }, rng);
        const lc = new LessonContent();

        // Find letters: rounds until every letter was the target.
        const games = new LearningGames(null, { now });
        let ch = games.setMode('find-letters', c);
        const seenLetters = new Set<string>();
        for (let round = 0; round < 2000 && seenLetters.size < 26; round++) {
          if (ch?.kind !== 'find-letter') throw new Error('expected find-letter');
          seenLetters.add(ch.target);
          check(ch.prompt);
          for (const l of LETTERS) {
            if (l === ch.target) continue;
            const out = games.judge(press(lc, c, `Key${l}`, l.toLowerCase()), c);
            if (out.result !== 'wrong') throw new Error('expected wrong');
            check(out.say);
            check(withHint(out.say, `Key${ch.target}`));
            check(withHint(null, `Key${ch.target}`));
          }
          const right = games.judge(press(lc, c, `Key${ch.target}`, ch.target.toLowerCase()), c);
          if (right.result !== 'correct') throw new Error('expected correct');
          check(right.say);
          // Every praise variant after a yes line.
          for (const p of PRAISE) check(withPraise(lines.yes(letterName(ch.target)), p));
          ch = right.next;
        }
        expect(seenLetters.size).toBe(26);

        // Find numbers.
        ch = games.setMode('find-numbers', c);
        const seenDigits = new Set<number>();
        for (let round = 0; round < 2000 && seenDigits.size < 10; round++) {
          if (ch?.kind !== 'find-number') throw new Error('expected find-number');
          seenDigits.add(ch.target);
          check(ch.prompt);
          for (let d = 0; d <= 9; d++) {
            if (d === ch.target) continue;
            const out = games.judge(press(lc, c, `Digit${d}`, String(d)), c);
            if (out.result !== 'wrong') throw new Error('expected wrong');
            check(out.say);
            check(withHint(out.say, `Digit${ch.target}`));
          }
          const right = games.judge(press(lc, c, `Numpad${ch.target}`, String(ch.target)), c);
          if (right.result !== 'correct') throw new Error('expected correct');
          check(right.say);
          for (const p of PRAISE) check(withPraise(lines.yes(numberWord(ch.target)), p));
          ch = right.next;
        }
        expect(seenDigits.size).toBe(10);

        // Spell every word.
        ch = games.setMode('spell', c);
        const spelled = new Set<string>();
        for (let round = 0; round < 3000 && spelled.size < SPELL_WORDS.length; round++) {
          if (ch?.kind !== 'spell') throw new Error('expected spell');
          check(ch.prompt);
          let next: Challenge | null = null;
          for (let i = 0; i < ch.letters.length; i++) {
            const want = ch.letters[i];
            const wrongLetter = want === 'Q' ? 'Z' : 'Q';
            const out = games.judge(press(lc, c, `Key${wrongLetter}`, wrongLetter.toLowerCase()), c);
            if (out.result !== 'wrong') throw new Error('expected wrong');
            check(out.say);
            check(withHint(out.say, `Key${want}`));
            const right = games.judge(press(lc, c, `Key${want}`, want.toLowerCase()), c);
            if (right.result !== 'correct') throw new Error('expected correct');
            check(right.say);
            if (right.complete) next = right.next;
          }
          spelled.add(ch.word.word);
          ch = next;
        }
        expect(spelled.size).toBe(SPELL_WORDS.length);
      }
    });
  });
}
