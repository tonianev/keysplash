import { describe, expect, it } from 'vitest';
import {
  BASE_WORDS,
  LessonContent,
  digitColor,
  digitFor,
  displayLetter,
  letterColor,
  letterFor,
  letterName,
  numberWord,
  praise,
  rainbowColors,
  shapeLabel,
  wordsFor,
} from '../src/content';
import { SPELL_WORDS } from '../src/modes';
import { contrastRatio } from '../src/render/color';
import { DEFAULT_SETTINGS } from '../src/settings';
import { DARK_PALETTE, LIGHT_PALETTE, WORLDS, WORLD_ORDER, nextWorld } from '../src/worlds';
import type { ColorName, ContentContext, KeyContent, Settings, World, WorldId } from '../src/types';

/** An rng that must never be called (key presses are fully deterministic). */
const noRng = (): number => {
  throw new Error('rng must not be used for key presses');
};

/** Cycles through fixed values. */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

function ctx(settings: Partial<Settings> = {}, world: World = WORLDS.paper, rng: () => number = noRng): ContentContext {
  return { world, settings: { ...DEFAULT_SETTINGS, ...settings }, rng };
}

function expectKind<K extends KeyContent['kind']>(c: KeyContent, kind: K): Extract<KeyContent, { kind: K }> {
  expect(c.kind).toBe(kind);
  return c as Extract<KeyContent, { kind: K }>;
}

const press = (code: string, key = '') => ({ code, key });
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const COLOR_NAMES: ColorName[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'brown'];

/**
 * Rejects code points from emoji blocks that only gained characters in
 * Unicode 14+. Within "Symbols and Pictographs Extended-A" (U+1FA70–1FAFF),
 * only the Unicode 12/13 ranges are allowed.
 */
function isUnicode13OrOlder(cp: number): boolean {
  if (cp >= 0x1fa70 && cp <= 0x1faff) {
    const allowed: Array<[number, number]> = [
      [0x1fa70, 0x1fa74], [0x1fa78, 0x1fa7a], [0x1fa80, 0x1fa86], [0x1fa90, 0x1faa8],
      [0x1fab0, 0x1fab6], [0x1fac0, 0x1fac2], [0x1fad0, 0x1fad6],
    ];
    return allowed.some(([lo, hi]) => cp >= lo && cp <= hi);
  }
  const newer = [0x1f6dc, 0x1f6dd, 0x1f6de, 0x1f6df, 0x1f7f0, 0x1f979, 0x1f9cc];
  return !newer.includes(cp) && cp < 0x1fb00;
}

describe('WORLDS', () => {
  it('has the seven v2 worlds, in order, keyed by id', () => {
    expect(WORLD_ORDER).toEqual(['paper', 'garden', 'ocean', 'space', 'jungle', 'snow', 'night']);
    expect(Object.keys(WORLDS).sort()).toEqual([...WORLD_ORDER].sort());
    for (const id of WORLD_ORDER) expect(WORLDS[id].id).toBe(id);
  });

  it('nextWorld wraps around and visits every world', () => {
    expect(nextWorld('paper')).toBe('garden');
    expect(nextWorld('night')).toBe('paper');
    let id: WorldId = 'paper';
    const visited = new Set<WorldId>();
    for (let i = 0; i < 7; i++) {
      visited.add(id);
      id = nextWorld(id);
    }
    expect(visited.size).toBe(7);
    expect(id).toBe('paper');
  });

  it('every palette has the 8 colour names exactly once', () => {
    for (const w of Object.values(WORLDS)) {
      expect(w.palette.map((c) => c.name).sort(), w.id).toEqual([...COLOR_NAMES].sort());
    }
  });

  it('light worlds share LIGHT_PALETTE and dark worlds DARK_PALETTE', () => {
    for (const w of Object.values(WORLDS)) {
      expect(w.palette, w.id).toEqual(w.dark ? [...DARK_PALETTE] : [...LIGHT_PALETTE]);
    }
    expect(WORLD_ORDER.filter((id) => WORLDS[id].dark).sort()).toEqual(['night', 'space']);
  });

  it('palettes are copies (mutating one world cannot recolour another)', () => {
    expect(WORLDS.paper.palette).not.toBe(WORLDS.garden.palette);
    expect(Object.isFrozen(LIGHT_PALETTE)).toBe(true);
    expect(Object.isFrozen(DARK_PALETTE)).toBe(true);
  });

  it('ink vs container contrast is at least 4.5:1 for every colour', () => {
    for (const palette of [LIGHT_PALETTE, DARK_PALETTE]) {
      for (const c of palette) {
        const r = contrastRatio(c.ink, c.container);
        expect(r, `${c.name} ${c.ink} on ${c.container} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('onSurface vs surface contrast is at least 4.5:1', () => {
    for (const w of Object.values(WORLDS)) {
      expect(contrastRatio(w.onSurface, w.surface), w.id).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('has sane fields', () => {
    const hex = /^#[0-9a-f]{6}$/i;
    for (const w of Object.values(WORLDS)) {
      expect(w.label.length).toBeGreaterThan(0);
      for (const c of w.palette) for (const v of [c.hex, c.container, c.ink]) expect(v).toMatch(hex);
      for (const s of [...w.sky, w.surface, w.onSurface]) expect(s).toMatch(hex);
      expect(w.friends.length).toBeGreaterThanOrEqual(8);
      expect(w.energy).toBeGreaterThanOrEqual(0.6);
      expect(w.energy).toBeLessThanOrEqual(1.2);
      expect(Number.isInteger(w.rootMidi)).toBe(true);
      for (const [letter, words] of Object.entries(w.words ?? {})) {
        expect(letter).toMatch(/^[A-Z]$/);
        for (const entry of words ?? []) {
          expect(entry.word).toBe(entry.word.toLowerCase());
          expect(entry.word[entry.at ?? 0].toUpperCase(), `${w.id} ${entry.word}`).toBe(letter);
        }
      }
    }
  });
});

describe('emoji', () => {
  const all: Array<[string, string]> = [];
  for (const [letter, words] of Object.entries(BASE_WORDS)) for (const w of words) all.push([`BASE ${letter}`, w.emoji]);
  for (const w of SPELL_WORDS) all.push([`spell ${w.word}`, w.emoji]);
  for (const w of Object.values(WORLDS)) {
    all.push([`${w.id} icon`, w.icon]);
    for (const f of w.friends) all.push([`${w.id} friend`, f]);
    for (const [letter, words] of Object.entries(w.words ?? {})) {
      for (const entry of words ?? []) all.push([`${w.id} ${letter}`, entry.emoji]);
    }
  }
  // Pictures and countables are private; reach them through LessonContent.
  const lc = new LessonContent();
  for (const code of ['ShiftLeft', 'F1', 'F12', 'Tab', 'Escape', 'Fn', 'PageDown', 'Mystery', '']) {
    const c = lc.forKey(press(code), ctx());
    if (c.kind === 'picture') all.push([`picture ${code}`, c.emoji]);
  }
  for (let d = 0; d <= 9; d++) {
    const c = lc.forKey(press(`Digit${d}`), ctx());
    if (c.kind === 'digit') all.push([`count ${d}`, c.countEmoji]);
  }

  it('are single graphemes without zero-width joiners (no U+200D)', () => {
    const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
    for (const [where, e] of all) {
      expect(e.includes('‍'), `${where} ${e} has ZWJ`).toBe(false);
      expect(Array.from(seg.segment(e)).length, `${where} ${e} is one grapheme`).toBe(1);
      expect(/\p{Extended_Pictographic}/u.test(e), `${where} ${e} is an emoji`).toBe(true);
    }
  });

  it('are from Unicode 13 or older', () => {
    for (const [where, e] of all) {
      for (const ch of e) {
        const cp = ch.codePointAt(0) ?? 0;
        expect(isUnicode13OrOlder(cp), `${where} ${e} U+${cp.toString(16)}`).toBe(true);
      }
    }
  });
});

describe('BASE_WORDS', () => {
  it('covers A–Z with lower-case words that contain the featured letter at `at`', () => {
    expect(Object.keys(BASE_WORDS).sort()).toEqual(LETTERS);
    for (const letter of LETTERS) {
      expect(BASE_WORDS[letter].length).toBeGreaterThan(0);
      for (const w of BASE_WORDS[letter]) {
        expect(w.word).toBe(w.word.toLowerCase());
        expect(w.word[w.at ?? 0].toUpperCase(), w.word).toBe(letter);
      }
    }
  });
});

describe('LessonContent.forKey: letters', () => {
  it('never uses the rng for any key', () => {
    const lc = new LessonContent();
    const codes = [
      ...LETTERS.map((l) => `Key${l}`), 'Digit0', 'Digit7', 'Numpad3', 'Space', 'Enter', 'Backspace',
      'ArrowUp', 'ArrowLeft', 'Minus', 'Slash', 'NumpadAdd', 'ShiftLeft', 'F5', 'Weird', '',
    ];
    for (const speech of ['letter', 'word'] as const) {
      for (const code of codes) expect(() => lc.forKey(press(code), ctx({ speech }))).not.toThrow();
    }
  });

  it('maps KeyA–KeyZ to letters with the base word first', () => {
    const lc = new LessonContent();
    for (const l of LETTERS) {
      const c = expectKind(lc.forKey(press(`Key${l}`, l.toLowerCase()), ctx()), 'letter');
      expect(c.letter).toBe(l);
      expect(c.word).toEqual(wordsFor(l, WORLDS.paper)[0]);
      expect(c.color).toEqual(letterColor(l, WORLDS.paper));
    }
  });

  it('gives the same key the same colour every time, even across instances', () => {
    const a = new LessonContent();
    const b = new LessonContent();
    for (let i = 0; i < 5; i++) {
      const x = expectKind(a.forKey(press('KeyB', 'b'), ctx()), 'letter');
      const y = expectKind(b.forKey(press('KeyB', 'b'), ctx()), 'letter');
      expect(x.color).toEqual(y.color);
      expect(x.color.name).toBe('orange');
    }
  });

  it('rotates words in order per letter and wraps', () => {
    const lc = new LessonContent();
    const words = () => expectKind(lc.forKey(press('KeyB', 'b'), ctx()), 'letter').word.word;
    expect([words(), words(), words(), words()]).toEqual(['ball', 'bear', 'banana', 'ball']);
  });

  it('keeps an independent cursor per letter', () => {
    const lc = new LessonContent();
    const w = (l: string) => expectKind(lc.forKey(press(`Key${l}`), ctx()), 'letter').word.word;
    expect(w('A')).toBe('apple');
    expect(w('C')).toBe('cat');
    expect(w('A')).toBe('ant');
    expect(w('C')).toBe('car');
    expect(lc.peekWord('A', WORLDS.paper).word).toBe('airplane');
    expect(lc.peekWord('a', WORLDS.paper).word).toBe('airplane'); // peek does not advance
    expect(w('A')).toBe('airplane');
  });

  it('shows world words first, then the base words without duplicates', () => {
    const lc = new LessonContent();
    const garden = ctx({}, WORLDS.garden);
    const w = () => expectKind(lc.forKey(press('KeyB', 'b'), garden), 'letter').word.word;
    expect([w(), w(), w(), w(), w(), w()]).toEqual(['butterfly', 'bee', 'ball', 'bear', 'banana', 'butterfly']);
    const ocean = wordsFor('T', WORLDS.ocean).map((e) => e.word);
    expect(ocean).toEqual(['turtle', 'tree', 'train']); // 'turtle' not repeated
  });

  it('features the x inside fox/box (at = 2) and speaks it without "is for"', () => {
    const lc = new LessonContent();
    const c = expectKind(lc.forKey(press('KeyX', 'x'), ctx({ speech: 'word' })), 'letter');
    expect(c.word).toEqual({ word: 'fox', emoji: '🦊', at: 2 });
    expect(c.speak).toBe('ex… fox');
    const d = expectKind(lc.forKey(press('KeyX', 'x'), ctx({ speech: 'word' })), 'letter');
    expect(d.word.word).toBe('box');
    expect(d.word.at).toBe(2);
  });

  it('speaks per speech mode', () => {
    const say = (speech: Settings['speech']) =>
      expectKind(new LessonContent().forKey(press('KeyB', 'b'), ctx({ speech })), 'letter').speak;
    expect(say('letter')).toBe('bee');
    expect(say('word')).toBe('bee… bee is for ball');
  });

  it('cases the display per letterCase', () => {
    const show = (letterCase: Settings['letterCase']) =>
      expectKind(new LessonContent().forKey(press('KeyG', 'g'), ctx({ letterCase })), 'letter').display;
    expect(show('upper')).toBe('G');
    expect(show('lower')).toBe('g');
    expect(show('both')).toBe('Gg');
  });

  it('prefers the printed letter (AZERTY) and falls back to the physical key', () => {
    const lc = new LessonContent();
    expect(expectKind(lc.forKey(press('KeyQ', 'a'), ctx()), 'letter').letter).toBe('A');
    expect(expectKind(lc.forKey(press('KeyQ', 'Q'), ctx()), 'letter').letter).toBe('Q');
    expect(expectKind(lc.forKey(press('KeyD', 'в'), ctx()), 'letter').letter).toBe('D');
  });
});

describe('LessonContent.forKey: digits', () => {
  it('maps Digit0–9 and Numpad0–9 to the same digit card', () => {
    const lc = new LessonContent();
    for (let d = 0; d <= 9; d++) {
      const a = expectKind(lc.forKey(press(`Digit${d}`, String(d)), ctx()), 'digit');
      const b = expectKind(lc.forKey(press(`Numpad${d}`, String(d)), ctx()), 'digit');
      expect(a.digit).toBe(d);
      expect(a.display).toBe(String(d));
      expect(b).toEqual(a);
      expect(a.color).toEqual(digitColor(d, WORLDS.paper));
    }
  });

  it('counts out loud one word per picture', () => {
    const c = expectKind(new LessonContent().forKey(press('Digit3'), ctx({ speech: 'word' })), 'digit');
    expect(c.countWords).toEqual(['one', 'two', 'three']);
    expect(c.countEmoji).toBe('🦆');
    expect(c.countNoun).toBe('ducks');
    expect(c.speak).toBe('three ducks!');
    const nine = expectKind(new LessonContent().forKey(press('Digit9'), ctx()), 'digit');
    expect(nine.countWords).toHaveLength(9);
    expect(nine.countWords[8]).toBe('nine');
  });

  it('uses the singular noun for 1', () => {
    const c = expectKind(new LessonContent().forKey(press('Digit1'), ctx()), 'digit');
    expect(c.countNoun).toBe('apple');
    expect(c.speak).toBe('one apple!');
    expect(c.countWords).toEqual(['one']);
  });

  it('says "zero — none!" for 0 with no count words', () => {
    const c = expectKind(new LessonContent().forKey(press('Digit0'), ctx({ speech: 'word' })), 'digit');
    expect(c.countWords).toEqual([]);
    expect(c.speak).toBe('zero — none!');
    const letterMode = expectKind(new LessonContent().forKey(press('Digit0'), ctx({ speech: 'letter' })), 'digit');
    expect(letterMode.speak).toBe('zero');
  });

  it('counts but skips the summary in letter mode', () => {
    const letter = expectKind(new LessonContent().forKey(press('Digit2'), ctx({ speech: 'letter' })), 'digit');
    expect(letter.countWords).toEqual(['one', 'two']);
    expect(letter.speak).toBeNull();
  });

  it('always returns its lines: whether the voice speaks is Settings.voice, applied by the speaker', () => {
    const silent = { voice: false } as Partial<Settings>;
    const lc = new LessonContent();
    expect(expectKind(lc.forKey(press('Digit2'), ctx(silent)), 'digit').countWords).toEqual(['one', 'two']);
    expect(expectKind(lc.forKey(press('KeyB', 'b'), ctx(silent)), 'letter').speak).toBe('bee… bee is for ball');
    expect(expectKind(lc.forKey(press('ArrowUp'), ctx(silent)), 'direction').speak).toBe('up!');
  });
});

describe('LessonContent.forKey: specials, arrows, shapes, pictures', () => {
  it('Space is rainbow (silent) and Enter/Backspace/Delete clear', () => {
    const lc = new LessonContent();
    expect(lc.forKey(press('Space', ' '), ctx())).toEqual({ kind: 'special', effect: 'rainbow', speak: null });
    for (const code of ['Enter', 'NumpadEnter', 'Backspace', 'Delete']) {
      expect(lc.forKey(press(code), ctx({ speech: 'word' }))).toEqual({ kind: 'special', effect: 'clear', speak: 'all clean!' });
      expect(expectKind(lc.forKey(press(code), ctx({ speech: 'letter' })), 'special').speak).toBeNull();
    }
  });

  it('arrows give a direction with a fixed colour each', () => {
    const lc = new LessonContent();
    const expected: Record<string, [string, ColorName]> = {
      ArrowUp: ['up', 'blue'], ArrowDown: ['down', 'green'], ArrowLeft: ['left', 'orange'], ArrowRight: ['right', 'purple'],
    };
    for (const world of [WORLDS.paper, WORLDS.night]) {
      for (const [code, [dir, color]] of Object.entries(expected)) {
        const c = expectKind(lc.forKey(press(code), ctx({}, world)), 'direction');
        expect(c.direction).toBe(dir);
        expect(c.color.name).toBe(color);
        expect(world.palette).toContainEqual(c.color);
        expect(c.speak).toBe(`${dir}!`);
      }
    }
  });

  it('punctuation keys give a fixed shape and colour, named "blue circle"-style', () => {
    const a = new LessonContent();
    const b = new LessonContent();
    const shapes = new Set<string>();
    for (const code of ['Minus', 'Equal', 'BracketLeft', 'Comma', 'Period', 'Slash', 'NumpadAdd']) {
      const x = expectKind(a.forKey(press(code), ctx()), 'shape');
      const y = expectKind(b.forKey(press(code), ctx()), 'shape');
      expect(y).toEqual(x);
      expect(x.label).toBe(shapeLabel(x.shape));
      expect(x.speak).toBe(`${x.color.name} ${x.label}`);
      shapes.add(x.shape);
    }
    expect(shapes.size).toBeGreaterThan(4);
  });

  it('other keys give a fixed picture per code with the word spoken', () => {
    const lc = new LessonContent();
    const f1 = expectKind(lc.forKey(press('F1'), ctx()), 'picture');
    expect(f1).toEqual(expectKind(new LessonContent().forKey(press('F1'), ctx()), 'picture'));
    expect(f1.word).toBe('cow');
    expect(f1.speak).toBe('cow');
    const shift = expectKind(lc.forKey(press('ShiftLeft'), ctx()), 'picture');
    expect(shift).toEqual({ kind: 'picture', emoji: '🐝', word: 'bee', speak: 'bee' });
  });

  it('F1 is a cow and F2 a pig, as DESIGN.md §4 documents', () => {
    const lc = new LessonContent();
    expect(expectKind(lc.forKey(press('F1'), ctx()), 'picture').word).toBe('cow');
    expect(expectKind(lc.forKey(press('F2'), ctx()), 'picture').word).toBe('pig');
  });

  it('unknown and empty codes still give a stable picture', () => {
    const lc = new LessonContent();
    for (const code of ['MediaPlayPause', 'Unidentified', '']) {
      const a = expectKind(lc.forKey(press(code), ctx()), 'picture');
      const b = expectKind(lc.forKey(press(code), ctx()), 'picture');
      expect(b).toEqual(a);
      expect(a.word.length).toBeGreaterThan(0);
    }
  });
});

describe('LessonContent.forTap', () => {
  it('gives a shape from the rng and names it every third tap', () => {
    const lc = new LessonContent();
    const c = ctx({ speech: 'word' }, WORLDS.paper, seq(0, 0.5, 0.99, 0.99));
    const taps = Array.from({ length: 6 }, () => expectKind(lc.forTap(c), 'shape'));
    expect(taps.map((t) => t.speak !== null)).toEqual([false, false, true, false, false, true]);
    expect(taps[0].shape).toBe('circle');
    expect(taps[0].color.name).toBe('blue'); // floor(0.5 * 8) = 4 → blue
    expect(taps[2].speak).toBe(`${taps[2].color.name} ${taps[2].label}`);
  });

  it('stays in bounds when the rng returns values near 1', () => {
    const lc = new LessonContent();
    const c = ctx({}, WORLDS.paper, () => 0.9999999);
    const t = expectKind(lc.forTap(c), 'shape');
    expect(t.shape).toBe('rectangle');
    expect(t.color.name).toBe('brown');
  });

});

describe('helpers', () => {
  it('letterName spells names phonetically, case-insensitive', () => {
    expect(letterName('B')).toBe('bee');
    expect(letterName('b')).toBe('bee');
    expect(letterName('W')).toBe('double you');
    expect(letterName('H')).toBe('aitch');
    expect(letterName('é')).toBe('é');
    for (const l of LETTERS) expect(letterName(l).length).toBeGreaterThan(1);
  });

  it('numberWord covers 0..10 and falls back to digits', () => {
    expect([0, 1, 2, 3, 9, 10].map(numberWord)).toEqual(['zero', 'one', 'two', 'three', 'nine', 'ten']);
    expect(numberWord(11)).toBe('11');
    expect(numberWord(-1)).toBe('-1');
  });

  it('rainbowColors returns red, orange, yellow, green, blue, purple from the world', () => {
    for (const w of [WORLDS.paper, WORLDS.space]) {
      const r = rainbowColors(w);
      expect(r.map((c) => c.name)).toEqual(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);
      for (const c of r) expect(w.palette).toContainEqual(c);
    }
  });

  it('praise uses the child name sometimes, otherwise a stock phrase', () => {
    expect(praise(() => 0.1, 'Mia')).toBe('Great job, Mia!');
    expect(praise(() => 0.1, '  Leo  ')).toBe('Great job, Leo!');
    expect(praise(() => 0, '')).toBe('Great job!');
    expect(praise(seq(0.9, 0), 'Mia')).toBe('Great job!');
    expect(praise(() => 0.9999)).toBe('Amazing!');
    expect(praise(() => 1)).toBe('Amazing!'); // out-of-contract rng stays in bounds
  });

  it('displayLetter cases upper / lower / both', () => {
    expect(displayLetter('b', 'upper')).toBe('B');
    expect(displayLetter('B', 'lower')).toBe('b');
    expect(displayLetter('b', 'both')).toBe('Bb');
  });

  it('letterFor / digitFor', () => {
    expect(letterFor('KeyZ', 'z')).toBe('Z');
    expect(letterFor('KeyZ', 'Dead')).toBe('Z');
    expect(letterFor('KeyM', ',')).toBeNull(); // AZERTY: ',' sits on the KeyM position
    expect(letterFor('KeyA', 'ф')).toBe('A'); // Cyrillic layout: teach the Latin letter on that key
    expect(letterFor('KeyQ', 'a')).toBe('A'); // AZERTY: the printed letter wins
    expect(letterFor('Digit1', '1')).toBeNull();
    expect(digitFor('Digit5')).toBe(5);
    expect(digitFor('Numpad0')).toBe(0);
    expect(digitFor('NumpadAdd')).toBeNull();
    expect(digitFor('KeyA')).toBeNull();
  });

  it('letterColor cycles the palette from A = red and is case-insensitive', () => {
    expect(letterColor('A', WORLDS.paper).name).toBe('red');
    expect(letterColor('a', WORLDS.paper)).toEqual(letterColor('A', WORLDS.paper));
    expect(letterColor('I', WORLDS.paper).name).toBe('red'); // 8 colours → wraps at I
  });

  it('copes with an empty palette', () => {
    const empty: World = { ...WORLDS.paper, palette: [] };
    expect(letterColor('A', empty).name).toBe('blue');
    expect(rainbowColors(empty)).toHaveLength(6);
    expect(() => new LessonContent().forKey(press('KeyA', 'a'), ctx({}, empty))).not.toThrow();
  });
});
