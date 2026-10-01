import { describe, expect, it } from 'vitest';
import { KEYBOARD_ROWS, describeKeyLocation, keyMap, knownKeyCodes, pentatonic } from '../src/keymap';
import { WORLDS } from '../src/worlds';

const SCALE = new Set([0, 2, 4, 7, 9]);
const inScale = (note: number, root: number) => SCALE.has((((note - root) % 12) + 12) % 12);
const pos = (code: string) => {
  const p = keyMap.position(code);
  if (!p) throw new Error(`no position for ${code}`);
  return p;
};
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

const ROWS = {
  digits: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'],
  top: ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'],
  home: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL'],
  bottom: ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM'],
};

describe('pentatonic', () => {
  it('walks the major pentatonic scale and wraps octaves', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((s) => pentatonic(60, s))).toEqual([60, 62, 64, 67, 69, 72, 74]);
    expect(pentatonic(60, 10)).toBe(84);
    expect(pentatonic(60, -1)).toBe(57);
    expect(pentatonic(60, -5)).toBe(48);
    expect(pentatonic(60, -6)).toBe(45);
  });

  it('rounds fractional steps and survives NaN', () => {
    expect(pentatonic(60, 1.4)).toBe(62);
    expect(pentatonic(60, Number.NaN)).toBe(60);
  });
});

describe('keyMap.position', () => {
  it('keeps every known key inside [0, 1]', () => {
    const codes = knownKeyCodes();
    expect(codes.length).toBeGreaterThan(100);
    for (const code of codes) {
      const p = pos(code);
      expect(p.x, code).toBeGreaterThanOrEqual(0);
      expect(p.x, code).toBeLessThanOrEqual(1);
      expect(p.y, code).toBeGreaterThanOrEqual(0);
      expect(p.y, code).toBeLessThanOrEqual(1);
    }
  });

  it('knows letters, digits, symbols, modifiers, F-keys, arrows, nav and numpad', () => {
    const codes = [
      ...ROWS.digits, ...ROWS.top, ...ROWS.home, ...ROWS.bottom,
      'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote',
      'Comma', 'Period', 'Slash', 'IntlBackslash', 'Space', 'Enter', 'Backspace', 'Tab', 'CapsLock',
      'ShiftLeft', 'ShiftRight', 'ControlLeft', 'AltLeft', 'MetaLeft', 'MetaRight', 'AltRight', 'Escape',
      'F1', 'F12', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
      'Delete', 'Insert', 'NumLock', 'Numpad0', 'Numpad5', 'Numpad9', 'NumpadAdd', 'NumpadEnter', 'NumpadDecimal',
    ];
    for (const code of codes) expect(keyMap.position(code), code).not.toBeNull();
  });

  it('returns null for unknown keys', () => {
    expect(keyMap.position('MediaPlayPause')).toBeNull();
    expect(keyMap.position('')).toBeNull();
    expect(keyMap.position('Unidentified')).toBeNull();
  });

  it('matches the physical layout', () => {
    expect(pos('KeyQ').x).toBeLessThan(pos('KeyP').x);
    expect(pos('KeyA').x).toBeLessThan(pos('KeyL').x);
    expect(pos('KeyZ').x).toBeLessThan(pos('KeyM').x);
    expect(pos('Escape').x).toBeLessThan(0.1);
    expect(pos('Backspace').x).toBeGreaterThan(0.85);
    // Rows go top → bottom.
    expect(pos('F1').y).toBe(0);
    expect(pos('Digit1').y).toBeLessThan(pos('KeyQ').y);
    expect(pos('KeyQ').y).toBeLessThan(pos('KeyA').y);
    expect(pos('KeyA').y).toBeLessThan(pos('KeyZ').y);
    expect(pos('Space').y).toBe(1);
    // Each row reads left → right.
    for (const row of Object.values(ROWS)) {
      for (let i = 1; i < row.length; i++) expect(pos(row[i]).x).toBeGreaterThan(pos(row[i - 1]).x);
    }
  });

  it('squeezes the numpad into the right ~12%', () => {
    for (const code of ['NumLock', 'Numpad7', 'Numpad5', 'Numpad3', 'Numpad0', 'NumpadEnter', 'NumpadAdd']) {
      expect(pos(code).x, code).toBeGreaterThanOrEqual(0.88);
    }
  });

  it('returns the same object every time (no allocation per key press)', () => {
    expect(keyMap.position('KeyK')).toBe(keyMap.position('KeyK'));
  });
});

describe('keyMap.note', () => {
  const roots = [45, 55, 57, 60, 64, 67, 72];

  it('plays higher notes on higher rows (on average)', () => {
    for (const root of [57, 64, 67]) {
      const mean = (row: string[]) => avg(row.map((c) => keyMap.note(c, root)));
      expect(mean(ROWS.digits)).toBeGreaterThan(mean(ROWS.top));
      expect(mean(ROWS.top)).toBeGreaterThan(mean(ROWS.home));
      expect(mean(ROWS.home)).toBeGreaterThan(mean(ROWS.bottom));
    }
  });

  it('ascends left → right within a row', () => {
    for (const row of Object.values(ROWS)) {
      const notes = row.map((c) => keyMap.note(c, 60));
      for (let i = 1; i < notes.length; i++) expect(notes[i], row[i]).toBeGreaterThanOrEqual(notes[i - 1]);
      expect(notes[notes.length - 1]).toBeGreaterThan(notes[0]);
    }
  });

  it('puts the middle of the home row on the root', () => {
    expect(keyMap.note('KeyG', 64)).toBe(64);
  });

  it('keeps every note in the root’s major pentatonic scale', () => {
    const codes = [...knownKeyCodes(), 'MediaPlayPause', 'Unidentified', '', 'SomethingNew'];
    for (const root of roots) {
      for (const code of codes) {
        const n = keyMap.note(code, root);
        expect(Number.isInteger(n)).toBe(true);
        expect(inScale(n, root), `${code} @ ${root} → ${n}`).toBe(true);
      }
    }
  });

  it('stays within MIDI 45..96 for any root', () => {
    for (const root of [0, 30, 45, 57, 64, 69, 90, 127]) {
      for (const code of knownKeyCodes()) {
        const n = keyMap.note(code, root);
        expect(n, `${code} @ ${root}`).toBeGreaterThanOrEqual(45);
        expect(n, `${code} @ ${root}`).toBeLessThanOrEqual(96);
      }
    }
  });

  it('gives each world a usable range for letter keys', () => {
    for (const w of Object.values(WORLDS)) {
      const notes = [...ROWS.top, ...ROWS.home, ...ROWS.bottom].map((c) => keyMap.note(c, w.rootMidi));
      expect(new Set(notes).size, w.id).toBeGreaterThanOrEqual(12);
    }
  });

  it('gives unknown keys a stable note', () => {
    const a = keyMap.note('LaunchMail', 60);
    expect(keyMap.note('LaunchMail', 60)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(45);
    expect(a).toBeLessThanOrEqual(96);
  });

  it('survives a bad root', () => {
    expect(keyMap.note('KeyG', Number.NaN)).toBe(60);
  });
});

describe('KEYBOARD_ROWS', () => {
  it('is digits, QWERTY rows and Space, frozen', () => {
    expect(KEYBOARD_ROWS.map((r) => r.length)).toEqual([10, 10, 9, 7, 1]);
    expect(KEYBOARD_ROWS[0][0]).toBe('Digit1');
    expect(KEYBOARD_ROWS[0][9]).toBe('Digit0');
    expect(KEYBOARD_ROWS[1].join(',')).toBe('KeyQ,KeyW,KeyE,KeyR,KeyT,KeyY,KeyU,KeyI,KeyO,KeyP');
    expect(KEYBOARD_ROWS[2][0]).toBe('KeyA');
    expect(KEYBOARD_ROWS[3][6]).toBe('KeyM');
    expect(KEYBOARD_ROWS[4]).toEqual(['Space']);
    expect(Object.isFrozen(KEYBOARD_ROWS)).toBe(true);
    for (const row of KEYBOARD_ROWS) expect(Object.isFrozen(row)).toBe(true);
  });

  it('contains every letter and digit exactly once, all with known positions', () => {
    const flat = KEYBOARD_ROWS.flat();
    expect(new Set(flat).size).toBe(flat.length);
    for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') expect(flat).toContain(`Key${c}`);
    for (let d = 0; d <= 9; d++) expect(flat).toContain(`Digit${d}`);
    for (const code of flat) expect(keyMap.position(code), code).not.toBeNull();
  });

  it('rows run top to bottom and left to right on the physical keyboard', () => {
    for (let r = 0; r < KEYBOARD_ROWS.length; r++) {
      const row = KEYBOARD_ROWS[r];
      for (let i = 1; i < row.length; i++) {
        expect(keyMap.position(row[i])!.x).toBeGreaterThan(keyMap.position(row[i - 1])!.x);
      }
      if (r > 0) expect(keyMap.position(row[0])!.y).toBeGreaterThan(keyMap.position(KEYBOARD_ROWS[r - 1][0])!.y);
    }
  });
});

describe('describeKeyLocation', () => {
  it('names the row and side', () => {
    expect(describeKeyLocation('KeyQ')).toBe('It is in the top row, on the left.');
    expect(describeKeyLocation('KeyP')).toBe('It is in the top row, on the right.');
    expect(describeKeyLocation('KeyG')).toBe('It is in the middle row, in the middle.');
    expect(describeKeyLocation('KeyA')).toBe('It is in the middle row, on the left.');
    expect(describeKeyLocation('KeyL')).toBe('It is in the middle row, on the right.');
    expect(describeKeyLocation('KeyZ')).toBe('It is in the bottom row, on the left.');
    expect(describeKeyLocation('KeyM')).toBe('It is in the bottom row, on the right.');
    expect(describeKeyLocation('Digit1')).toBe('It is on the number row, on the left.');
    expect(describeKeyLocation('Digit5')).toBe('It is on the number row, in the middle.');
    expect(describeKeyLocation('Digit0')).toBe('It is on the number row, on the right.');
  });

  it('describes numpad digits like the number row', () => {
    for (let d = 0; d <= 9; d++) expect(describeKeyLocation(`Numpad${d}`)).toBe(describeKeyLocation(`Digit${d}`));
  });

  it('describes Space as the long key at the bottom', () => {
    expect(describeKeyLocation('Space')).toBe('It is the long key at the bottom.');
  });

  it('falls back gently for keys outside the diagram', () => {
    for (const code of ['Enter', 'NumpadAdd', 'F1', '', 'Bogus']) {
      expect(describeKeyLocation(code)).toBe('Look carefully at the keys.');
    }
  });

  it('gives every letter a sentence with a row', () => {
    for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      expect(describeKeyLocation(`Key${c}`)).toMatch(/^It is in the (top|middle|bottom) row, (on the left|in the middle|on the right)\.$/);
    }
  });
});
