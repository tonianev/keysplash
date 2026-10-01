/**
 * Physical keyboard geometry (US-ANSI) → screen positions and musical notes.
 *
 * Positions are normalised: x 0 (left) … 1 (right) over the main block, with
 * the navigation cluster and numpad squeezed against the right edge (laptops,
 * the common case, have neither, so the letters use the full width); y is
 * 0 (function row) … 1 (space-bar row).
 *
 * Notes come from the world's major pentatonic scale and rise left → right
 * and bottom → top, so a sweep across the keyboard plays a scale and any
 * smash sounds musical.
 */
import type { KeyMap, KeyPosition } from './types';

const PENTATONIC_STEPS = [0, 2, 4, 7, 9];

/** Major pentatonic note `step` scale degrees above `rootMidi` (negative steps go down; wraps octaves). */
export function pentatonic(rootMidi: number, step: number): number {
  const s = Number.isFinite(step) ? Math.round(step) : 0;
  const octave = Math.floor(s / 5);
  return rootMidi + octave * 12 + PENTATONIC_STEPS[s - octave * 5];
}

// Playable range. Notes outside it are folded back by octaves (see foldIntoRange).
const MIDI_MIN = 45; // A2: anything lower is mud on laptop speakers
const MIDI_MAX = 96; // C7: anything higher is shrill

/** Main block width in key units (Escape … Backspace). */
const MAIN_UNITS = 15;
const ROWS = 5; // row index 0 (F-row) … 5 (space row)

// Squeezed columns (already normalised) for the nav cluster and the numpad.
const NAV_X = [0.8, 0.83, 0.86];
const PAD_X = [0.895, 0.925, 0.955, 0.985];

const positions = new Map<string, KeyPosition>();
/**
 * Horizontal position used for pitch when it differs from the screen position:
 * the numpad is squeezed into a sliver of the screen, but its columns should
 * still step through the scale.
 */
const pitchX = new Map<string, number>();

function put(code: string, x: number, row: number): void {
  positions.set(code, Object.freeze({ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, row / ROWS)) }));
}

/** Numpad key in column `col` (0..3, may be fractional for wide keys). */
function pad(code: string, col: number, row: number): void {
  const lo = Math.floor(col);
  const hi = Math.min(PAD_X.length - 1, Math.ceil(col));
  put(code, PAD_X[lo] + (PAD_X[hi] - PAD_X[lo]) * (col - lo), row);
  pitchX.set(code, 0.5 + col * 0.12);
}

/** Place a run of keys on a main-block row; `keys` are [code, widthInUnits], starting at `left` units. */
function row(rowIndex: number, left: number, keys: Array<[string, number]>): void {
  let u = left;
  for (const [code, width] of keys) {
    if (code) put(code, (u + width / 2) / MAIN_UNITS, rowIndex);
    u += width;
  }
}

const letters = (s: string): Array<[string, number]> => Array.from(s, (c) => [`Key${c}`, 1] as [string, number]);

// Row 0: Escape and the function keys (with the usual gaps between groups of four).
put('Escape', 0.5 / MAIN_UNITS, 0);
['F1', 'F2', 'F3', 'F4'].forEach((c, i) => put(c, (2.5 + i) / MAIN_UNITS, 0));
['F5', 'F6', 'F7', 'F8'].forEach((c, i) => put(c, (7 + i) / MAIN_UNITS, 0));
['F9', 'F10', 'F11', 'F12'].forEach((c, i) => put(c, (11.5 + i) / MAIN_UNITS, 0));
// Mac full-size keyboards: F13–F19 sit above the nav cluster / numpad.
['F13', 'F14', 'F15'].forEach((c, i) => put(c, NAV_X[i], 0));
['F16', 'F17', 'F18', 'F19'].forEach((c, i) => put(c, PAD_X[i], 0));

// Row 1: number row.
row(1, 0, [
  ['Backquote', 1],
  ...Array.from('1234567890', (d) => [`Digit${d}`, 1] as [string, number]),
  ['Minus', 1],
  ['Equal', 1],
  ['Backspace', 2],
]);
put('IntlYen', 13.5 / MAIN_UNITS, 1); // JIS: between Equal and a shorter Backspace

// Row 2: QWERTY row.
row(2, 0, [['Tab', 1.5], ...letters('QWERTYUIOP'), ['BracketLeft', 1], ['BracketRight', 1], ['Backslash', 1.5]]);

// Row 3: home row.
row(3, 0, [['CapsLock', 1.75], ...letters('ASDFGHJKL'), ['Semicolon', 1], ['Quote', 1], ['Enter', 2.25]]);

// Row 4: bottom letter row.
row(4, 0, [['ShiftLeft', 2.25], ...letters('ZXCVBNM'), ['Comma', 1], ['Period', 1], ['Slash', 1], ['ShiftRight', 2.75]]);
put('IntlBackslash', 1.75 / MAIN_UNITS, 4); // ISO: the extra key left of Z
put('IntlRo', 12.75 / MAIN_UNITS, 4); // JIS: right of Slash

// Row 5: space-bar row.
row(5, 0, [
  ['ControlLeft', 1.25],
  ['MetaLeft', 1.25],
  ['AltLeft', 1.25],
  ['Space', 6.25],
  ['AltRight', 1.25],
  ['MetaRight', 1.25],
  ['ContextMenu', 1.25],
  ['ControlRight', 1.25],
]);
put('Fn', 0.3 / MAIN_UNITS, 5);
put('OSLeft', 1.875 / MAIN_UNITS, 5); // legacy name for MetaLeft
put('OSRight', 11.875 / MAIN_UNITS, 5);
put('Lang2', 4.2 / MAIN_UNITS, 5);
put('NonConvert', 4.2 / MAIN_UNITS, 5);
put('Lang1', 9.6 / MAIN_UNITS, 5);
put('Convert', 9.6 / MAIN_UNITS, 5);
put('KanaMode', 10.4 / MAIN_UNITS, 5);

// Arrows where laptops put them: bottom-right corner of the main block.
put('ArrowLeft', 12.5 / MAIN_UNITS, 5);
put('ArrowDown', 13.5 / MAIN_UNITS, 5);
put('ArrowRight', 14.5 / MAIN_UNITS, 5);
put('ArrowUp', 13.5 / MAIN_UNITS, 4.5);

// Navigation cluster, squeezed to the right edge.
put('PrintScreen', NAV_X[0], 0);
put('ScrollLock', NAV_X[1], 0);
put('Pause', NAV_X[2], 0);
put('Insert', NAV_X[0], 1);
put('Help', NAV_X[0], 1); // old Mac keyboards: Help sits where Insert is
put('Home', NAV_X[1], 1);
put('PageUp', NAV_X[2], 1);
put('Delete', NAV_X[0], 2);
put('End', NAV_X[1], 2);
put('PageDown', NAV_X[2], 2);

// Numpad, in the right ~12%.
pad('NumLock', 0, 1);
pad('NumpadDivide', 1, 1);
pad('NumpadEqual', 1, 1.4); // Mac numpads put '=' next to Clear
pad('NumpadMultiply', 2, 1);
pad('NumpadSubtract', 3, 1);
pad('Numpad7', 0, 2);
pad('Numpad8', 1, 2);
pad('Numpad9', 2, 2);
pad('NumpadAdd', 3, 2.5);
pad('Numpad4', 0, 3);
pad('Numpad5', 1, 3);
pad('Numpad6', 2, 3);
pad('Numpad1', 0, 4);
pad('Numpad2', 1, 4);
pad('Numpad3', 2, 4);
pad('NumpadEnter', 3, 4.5);
pad('Numpad0', 0.5, 5);
pad('NumpadDecimal', 2, 5);
pad('NumpadComma', 2, 5);

// Pitch layout: ~13 scale steps across the width, 2.5 steps per row (an octave
// every two rows), centred so the middle of the home row plays the root.
const STEPS_ACROSS = 13;
const STEPS_PER_ROW = 2.5;
const STEP_OFFSET = -10;
/** Unknown keys land within roughly an octave either side of the root. */
const UNKNOWN_STEPS = 10;
const UNKNOWN_OFFSET = -2;

function hashCode(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function stepFor(code: string): number {
  const pos = positions.get(code);
  if (!pos) return (hashCode(code) % UNKNOWN_STEPS) + UNKNOWN_OFFSET;
  const x = pitchX.get(code) ?? pos.x;
  return Math.round(x * STEPS_ACROSS + (1 - pos.y) * ROWS * STEPS_PER_ROW) + STEP_OFFSET;
}

export const keyMap: KeyMap = {
  position(code: string): KeyPosition | null {
    return positions.get(code) ?? null;
  },
  note(code: string, rootMidi: number): number {
    return foldIntoRange(pentatonic(Number.isFinite(rootMidi) ? Math.round(rootMidi) : 60, stepFor(code)));
  },
};

/**
 * Brings a note into MIDI_MIN..MIDI_MAX by whole octaves, so it stays in the
 * world's scale (a hard clamp would land on off-scale notes).
 */
function foldIntoRange(midi: number): number {
  if (midi < MIDI_MIN) return midi + 12 * Math.ceil((MIDI_MIN - midi) / 12);
  if (midi > MIDI_MAX) return midi - 12 * Math.ceil((midi - MIDI_MAX) / 12);
  return midi;
}

/** Every code with a known position (for tests and tooling). */
export function knownKeyCodes(): string[] {
  return Array.from(positions.keys());
}

/** Rows of a simplified keyboard for the learning-game hint diagram. */
export const KEYBOARD_ROWS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(Array.from('1234567890', (d) => `Digit${d}`)),
  Object.freeze(Array.from('QWERTYUIOP', (c) => `Key${c}`)),
  Object.freeze(Array.from('ASDFGHJKL', (c) => `Key${c}`)),
  Object.freeze(Array.from('ZXCVBNM', (c) => `Key${c}`)),
  Object.freeze(['Space']),
]);

const ROW_NAMES = ['on the number row', 'in the top row', 'in the middle row', 'in the bottom row', 'at the bottom'];

/**
 * A short spoken hint for where a key is, e.g. 'It is in the middle row, on
 * the left.' Numpad digits are described like the number row.
 */
export function describeKeyLocation(code: string): string {
  const pad = /^Numpad([0-9])$/.exec(code);
  const lookup = pad ? `Digit${pad[1]}` : code;
  for (let r = 0; r < KEYBOARD_ROWS.length; r++) {
    const row = KEYBOARD_ROWS[r];
    const i = row.indexOf(lookup);
    if (i < 0) continue;
    if (row.length === 1) return `It is the long key ${ROW_NAMES[r]}.`;
    const t = i / (row.length - 1);
    const side = t < 0.34 ? 'on the left' : t > 0.66 ? 'on the right' : 'in the middle';
    return `It is ${ROW_NAMES[r]}, ${side}.`;
  }
  return 'Look carefully at the keys.';
}
