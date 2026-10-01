import { describe, expect, it } from 'vitest';
import { BASE_WORDS, cheer, contentForKey, contentForTap, numberWord, shapeLabel } from '../src/content';
import { DEFAULT_SETTINGS } from '../src/settings';
import { WORLDS, WORLD_ORDER, nextWorld } from '../src/worlds';
import type { ContentContext, KeyContent, Settings, ShapeKind, World, WorldId } from '../src/types';

/** Small seeded PRNG (mulberry32) so tests are deterministic. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ctx(settings: Partial<Settings> = {}, world: World = WORLDS.space, seed = 1): ContentContext {
  return { world, settings: { ...DEFAULT_SETTINGS, ...settings }, rng: seeded(seed) };
}

function expectKind<K extends KeyContent['kind']>(c: KeyContent, kind: K): Extract<KeyContent, { kind: K }> {
  expect(c.kind).toBe(kind);
  return c as Extract<KeyContent, { kind: K }>;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const SYMBOL_CODES = [
  'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period',
  'Slash', 'Backquote', 'IntlBackslash', 'IntlRo', 'IntlYen', 'NumpadAdd', 'NumpadSubtract',
  'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEqual', 'NumpadComma',
];
const SHAPES: ShapeKind[] = ['circle', 'square', 'triangle', 'star', 'heart', 'diamond', 'moon', 'flower', 'hexagon', 'cloud'];

describe('BASE_WORDS', () => {
  it('has lower-case words with an emoji for every letter A–Z', () => {
    expect(Object.keys(BASE_WORDS).sort()).toEqual(LETTERS);
    for (const letter of LETTERS) {
      const words = BASE_WORDS[letter];
      expect(words.length, letter).toBeGreaterThanOrEqual(1);
      expect(words.length, letter).toBeLessThanOrEqual(3);
      for (const w of words) {
        expect(w.word).toBe(w.word.toLowerCase());
        expect(w.word[0].toUpperCase(), `${w.word} starts with ${letter}`).toBe(letter);
        expect(w.emoji.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('contentForKey: letters', () => {
  it('maps KeyA–KeyZ to letters', () => {
    for (const letter of LETTERS) {
      const c = expectKind(contentForKey({ code: `Key${letter}`, key: letter.toLowerCase() }, ctx()), 'letter');
      expect(c.letter).toBe(letter);
      expect(c.word).not.toBeNull();
    }
  });

  it('cases the display per settings', () => {
    const press = { code: 'KeyA', key: 'a' };
    expect(expectKind(contentForKey(press, ctx({ letterCase: 'upper' })), 'letter').display).toBe('A');
    expect(expectKind(contentForKey(press, ctx({ letterCase: 'lower' })), 'letter').display).toBe('a');
    expect(expectKind(contentForKey(press, ctx({ letterCase: 'both' })), 'letter').display).toBe('Aa');
  });

  it('speaks per speech mode', () => {
    const press = { code: 'KeyA', key: 'a' };
    expect(contentForKey(press, ctx({ speech: 'off' })).speak).toBeNull();
    expect(contentForKey(press, ctx({ speech: 'letter' })).speak).toBe('ay');
    const c = expectKind(contentForKey(press, ctx({ speech: 'word' }, WORLDS.garden)), 'letter');
    expect(BASE_WORDS.A.map((w) => w.word)).toContain(c.word?.word);
    expect(c.speak).toBe(`ay… ${c.word?.word}!`);
    expect(contentForKey({ code: 'KeyW', key: 'w' }, ctx({ speech: 'letter' })).speak).toBe('double you');
    expect(contentForKey({ code: 'KeyH', key: 'h' }, ctx({ speech: 'letter' })).speak).toBe('aitch');
  });

  it('uses world word overrides', () => {
    const word = (code: string, world: WorldId) =>
      expectKind(contentForKey({ code, key: code.slice(3).toLowerCase() }, ctx({}, WORLDS[world])), 'letter').word;
    expect(word('KeyO', 'ocean')).toEqual({ word: 'octopus', emoji: '🐙' });
    expect(word('KeyW', 'ocean')).toEqual({ word: 'whale', emoji: '🐳' });
    expect(word('KeyD', 'dino')).toEqual({ word: 'dinosaur', emoji: '🦕' });
    expect(word('KeyT', 'dino')).toEqual({ word: 't-rex', emoji: '🦖' });
    expect(word('KeyR', 'space')).toEqual({ word: 'rocket', emoji: '🚀' });
    // No override → base words.
    expect(BASE_WORDS.Z).toContainEqual(word('KeyZ', 'ocean'));
  });

  it('picks words with the rng', () => {
    const seen = new Set<string>();
    const c = ctx();
    for (let i = 0; i < 100; i++) {
      seen.add(expectKind(contentForKey({ code: 'KeyB', key: 'b' }, c), 'letter').word?.word ?? '');
    }
    expect(seen).toEqual(new Set(BASE_WORDS.B.map((w) => w.word)));
  });

  it('survives an rng that returns 1 (out of contract)', () => {
    const c: ContentContext = { ...ctx(), rng: () => 1 };
    expect(expectKind(contentForKey({ code: 'KeyC', key: 'c' }, c), 'letter').word).not.toBeNull();
    expect(contentForTap(c).kind).toMatch(/shape|emoji/);
  });

  it('gives the same key the same colour within a world', () => {
    for (const id of WORLD_ORDER) {
      for (const letter of LETTERS) {
        const colours = new Set<string>();
        for (let seed = 1; seed <= 5; seed++) {
          const c = expectKind(contentForKey({ code: `Key${letter}`, key: letter }, ctx({}, WORLDS[id], seed)), 'letter');
          expect(WORLDS[id].palette).toContainEqual(c.color);
          colours.add(c.color.hex);
        }
        expect(colours.size).toBe(1);
      }
    }
  });

  it('uses several colours across the alphabet', () => {
    const colours = new Set(LETTERS.map((l) => expectKind(contentForKey({ code: `Key${l}`, key: l }, ctx()), 'letter').color.hex));
    expect(colours.size).toBeGreaterThanOrEqual(5);
  });

  it('shows the printed letter on non-QWERTY Latin layouts, the physical letter otherwise', () => {
    // AZERTY: the key labelled A sits where QWERTY has Q.
    expect(expectKind(contentForKey({ code: 'KeyQ', key: 'a' }, ctx()), 'letter').letter).toBe('A');
    expect(expectKind(contentForKey({ code: 'KeyQ', key: 'A' }, ctx()), 'letter').letter).toBe('A');
    // Cyrillic layout or Option/AltGr symbols: fall back to the physical key.
    expect(expectKind(contentForKey({ code: 'KeyA', key: 'ф' }, ctx()), 'letter').letter).toBe('A');
    expect(expectKind(contentForKey({ code: 'KeyA', key: 'å' }, ctx()), 'letter').letter).toBe('A');
    expect(expectKind(contentForKey({ code: 'KeyA', key: 'Unidentified' }, ctx()), 'letter').letter).toBe('A');
  });
});

describe('contentForKey: digits', () => {
  it('maps Digit0–9 and Numpad0–9 to counting digits', () => {
    for (let d = 0; d <= 9; d++) {
      for (const code of [`Digit${d}`, `Numpad${d}`]) {
        const c = expectKind(contentForKey({ code, key: String(d) }, ctx()), 'digit');
        expect(c.digit).toBe(d);
        expect(c.display).toBe(String(d));
        expect(c.speak).toBe(numberWord(d));
        expect(WORLDS.space.friends).toContain(c.countEmoji);
        expect(WORLDS.space.palette).toContainEqual(c.color);
      }
    }
  });

  it('is deterministic per digit, and the numpad matches the top row', () => {
    for (let d = 0; d <= 9; d++) {
      const a = contentForKey({ code: `Digit${d}`, key: String(d) }, ctx({}, WORLDS.ocean, 1));
      const b = contentForKey({ code: `Digit${d}`, key: String(d) }, ctx({}, WORLDS.ocean, 99));
      const n = contentForKey({ code: `Numpad${d}`, key: String(d) }, ctx({}, WORLDS.ocean, 7));
      expect(b).toEqual(a);
      expect(n).toEqual(a);
    }
  });

  it('speaks the number in letter mode and is silent when speech is off', () => {
    expect(contentForKey({ code: 'Digit3', key: '3' }, ctx({ speech: 'letter' })).speak).toBe('three');
    expect(contentForKey({ code: 'Digit3', key: '3' }, ctx({ speech: 'off' })).speak).toBeNull();
  });
});

describe('contentForKey: symbols', () => {
  it('maps punctuation keys to stable shapes and colours', () => {
    for (const code of SYMBOL_CODES) {
      const a = expectKind(contentForKey({ code, key: '?' }, ctx({}, WORLDS.party, 1)), 'shape');
      const b = expectKind(contentForKey({ code, key: '?' }, ctx({}, WORLDS.party, 42)), 'shape');
      expect(b).toEqual(a);
      expect(SHAPES).toContain(a.shape);
      expect(WORLDS.party.palette).toContainEqual(a.color);
      expect(a.speak).toBe(`${a.color.name} ${shapeLabel(a.shape)}`);
    }
  });

  it('gives neighbouring keys different shapes and uses every shape', () => {
    const shape = (code: string) => expectKind(contentForKey({ code, key: '' }, ctx()), 'shape').shape;
    expect(shape('Minus')).not.toBe(shape('Equal'));
    expect(shape('BracketLeft')).not.toBe(shape('BracketRight'));
    expect(shape('Comma')).not.toBe(shape('Period'));
    expect(new Set(SYMBOL_CODES.map(shape)).size).toBe(SHAPES.length);
  });

  it('is silent when speech is off', () => {
    expect(contentForKey({ code: 'Slash', key: '/' }, ctx({ speech: 'off' })).speak).toBeNull();
  });
});

describe('contentForKey: specials and everything else', () => {
  it('maps special keys to effects', () => {
    const effect = (code: string, speech: Settings['speech'] = 'word') =>
      expectKind(contentForKey({ code, key: '' }, ctx({ speech })), 'special');
    expect(effect('Space')).toEqual({ kind: 'special', effect: 'rainbow', speak: 'rainbow!' });
    expect(effect('Space', 'letter').speak).toBeNull();
    expect(effect('Space', 'off').speak).toBeNull();
    expect(effect('Enter').effect).toBe('sweep');
    expect(effect('NumpadEnter').effect).toBe('sweep');
    expect(effect('Backspace').effect).toBe('pop-all');
    expect(effect('Delete').effect).toBe('pop-all');
    expect(effect('ArrowUp').effect).toBe('comet-up');
    expect(effect('ArrowDown').effect).toBe('comet-down');
    expect(effect('ArrowLeft').effect).toBe('comet-left');
    expect(effect('ArrowRight').effect).toBe('comet-right');
    for (const code of ['Enter', 'Backspace', 'ArrowUp']) expect(effect(code).speak).toBeNull();
  });

  it('turns every other key into a silent world friend', () => {
    const others = [
      'ShiftLeft', 'ShiftRight', 'ControlLeft', 'AltLeft', 'MetaLeft', 'MetaRight', 'CapsLock', 'Tab', 'Escape',
      'F1', 'F12', 'Home', 'PageDown', 'MediaPlayPause', 'AudioVolumeUp', 'Fn', 'Unidentified', '', 'toString',
    ];
    for (const code of others) {
      for (const id of WORLD_ORDER) {
        const c = expectKind(contentForKey({ code, key: '' }, ctx({}, WORLDS[id])), 'emoji');
        expect(WORLDS[id].friends).toContain(c.emoji);
        expect(c.speak).toBeNull();
      }
    }
  });

  it('copes with missing fields', () => {
    const c = contentForKey({ code: undefined, key: undefined } as unknown as { code: string; key: string }, ctx());
    expect(c.kind).toBe('emoji');
  });
});

describe('contentForTap', () => {
  it('mixes shapes and friends, naming about a third of the shapes', () => {
    const c = ctx({ speech: 'word' }, WORLDS.garden, 3);
    let shapes = 0;
    let emoji = 0;
    let spoken = 0;
    for (let i = 0; i < 600; i++) {
      const t = contentForTap(c);
      if (t.kind === 'shape') {
        shapes++;
        expect(SHAPES).toContain(t.shape);
        expect(WORLDS.garden.palette).toContainEqual(t.color);
        if (t.speak) {
          spoken++;
          expect(t.speak).toBe(`${t.color.name} ${shapeLabel(t.shape)}`);
        }
      } else {
        const e = expectKind(t, 'emoji');
        emoji++;
        expect(WORLDS.garden.friends).toContain(e.emoji);
        expect(e.speak).toBeNull();
      }
    }
    expect(shapes).toBeGreaterThan(200);
    expect(emoji).toBeGreaterThan(200);
    expect(spoken / shapes).toBeGreaterThan(0.2);
    expect(spoken / shapes).toBeLessThan(0.47);
  });

  it('never speaks when speech is off', () => {
    const c = ctx({ speech: 'off' }, WORLDS.space, 5);
    for (let i = 0; i < 200; i++) expect(contentForTap(c).speak).toBeNull();
  });
});

describe('helpers', () => {
  it('numberWord', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(numberWord)).toEqual([
      'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    ]);
    expect(numberWord(11)).toBe('11');
    expect(numberWord(-1)).toBe('-1');
    expect(numberWord(2.5)).toBe('2.5');
  });

  it('shapeLabel', () => {
    for (const s of SHAPES) expect(shapeLabel(s)).toBe(s);
  });

  it('cheer', () => {
    const rng = seeded(9);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = cheer(rng);
      expect(c).toMatch(/^[A-Z][a-z-]+!$/);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
    expect(cheer(() => 0.999999)).toMatch(/!$/);
  });
});

// ---------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------

describe('WORLDS', () => {
  it('lists every world once, in order, keyed by id', () => {
    expect(new Set(WORLD_ORDER).size).toBe(7);
    expect(Object.keys(WORLDS).sort()).toEqual([...WORLD_ORDER].sort());
    for (const id of WORLD_ORDER) expect(WORLDS[id].id).toBe(id);
  });

  it('nextWorld wraps around', () => {
    expect(nextWorld('space')).toBe('ocean');
    expect(nextWorld('night')).toBe('space');
    let id: WorldId = 'space';
    const visited = new Set<WorldId>();
    for (let i = 0; i < 7; i++) {
      visited.add(id);
      id = nextWorld(id);
    }
    expect(visited.size).toBe(7);
    expect(id).toBe('space');
  });

  it('has sane fields', () => {
    for (const w of Object.values(WORLDS)) {
      expect(w.label.length).toBeGreaterThan(0);
      expect(w.palette.length).toBeGreaterThanOrEqual(5);
      expect(w.palette.length).toBeLessThanOrEqual(7);
      expect(new Set(w.palette.map((c) => c.name)).size, `${w.id} colour names unique`).toBe(w.palette.length);
      for (const c of w.palette) expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
      for (const s of w.sky) expect(s).toMatch(/^#[0-9a-f]{6}$/);
      expect(w.friends.length).toBeGreaterThanOrEqual(8);
      expect(w.energy).toBeGreaterThanOrEqual(0.5);
      expect(w.energy).toBeLessThanOrEqual(1.5);
      expect(Number.isInteger(w.rootMidi)).toBe(true);
      expect(w.rootMidi).toBeGreaterThanOrEqual(52);
      expect(w.rootMidi).toBeLessThanOrEqual(69);
      for (const [letter, words] of Object.entries(w.words ?? {})) {
        expect(letter).toMatch(/^[A-Z]$/);
        expect(words?.length).toBeGreaterThan(0);
        for (const entry of words ?? []) {
          expect(entry.word).toBe(entry.word.toLowerCase());
          expect(entry.word[0].toUpperCase()).toBe(letter);
        }
      }
    }
  });

  it('marks dark skies correctly', () => {
    for (const w of Object.values(WORLDS)) {
      expect(luminance(midColour(w.sky)) < 0.2, w.id).toBe(w.dark);
    }
  });

  it('keeps every palette colour readable against its sky (≥ 3:1)', () => {
    for (const w of Object.values(WORLDS)) {
      const sky = luminance(midColour(w.sky));
      for (const c of w.palette) {
        const ratio = contrast(luminance(hexToRgb(c.hex)), sky);
        expect(ratio, `${w.id} ${c.name} ${c.hex} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('emoji', () => {
  const all: Array<[string, string]> = [];
  for (const [letter, words] of Object.entries(BASE_WORDS)) for (const w of words) all.push([`BASE ${letter}`, w.emoji]);
  for (const w of Object.values(WORLDS)) {
    all.push([`${w.id} icon`, w.icon]);
    for (const f of w.friends) all.push([`${w.id} friend`, f]);
    for (const [letter, words] of Object.entries(w.words ?? {})) {
      for (const entry of words ?? []) all.push([`${w.id} ${letter}`, entry.emoji]);
    }
  }

  it('are single graphemes without zero-width joiners', () => {
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

// --- helpers ---------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function midColour(sky: [string, string]): [number, number, number] {
  const a = hexToRgb(sky[0]);
  const b = hexToRgb(sky[1]);
  return [Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2), Math.round((a[2] + b[2]) / 2)];
}

/** WCAG relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

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
