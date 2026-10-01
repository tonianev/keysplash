import { describe, expect, it } from 'vitest';
import { keyMap, knownKeyCodes, pentatonic } from '../src/keymap';
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
