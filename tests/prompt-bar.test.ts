import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Challenge, NamedColor } from '../src/types';
import { DomPromptBar, targetCode } from '../src/ui/prompt-bar';
import { KEYBOARD_ROWS } from '../src/keymap';

const BLUE: NamedColor = { name: 'blue', hex: '#4A86D8', container: '#DCE8F8', ink: '#1C3F72' };
const RED: NamedColor = { name: 'red', hex: '#E0604F', container: '#F9DEDA', ink: '#7A2418' };

function findLetter(target = 'B', display = 'B'): Challenge {
  return { kind: 'find-letter', target, display, word: { word: 'ball', emoji: '⚽' }, color: BLUE, prompt: 'Can you find bee?' };
}
function findNumber(target = 3): Challenge {
  return { kind: 'find-number', target, display: String(target), color: RED, prompt: 'Can you find three?' };
}
function spell(index = 0): Challenge {
  return { kind: 'spell', word: { word: 'cat', emoji: '🐱' }, letters: ['C', 'A', 'T'], index, color: BLUE, prompt: "Let's spell cat." };
}

let root: HTMLElement;
let bar: DomPromptBar;
const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel) as T;
const keyEl = (code: string) => q<HTMLElement>(`.ks-kbd__key[data-code="${code}"]`);
const targets = () => [...root.querySelectorAll<HTMLElement>('.ks-kbd__key.is-target')].map((k) => k.dataset.code);
const pulses = () => [...root.querySelectorAll<HTMLElement>('.ks-kbd__key.is-pulse')].map((k) => k.dataset.code);

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
  bar = new DomPromptBar(root);
});

afterEach(() => {
  bar.hide();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('targetCode', () => {
  it('maps letters to KeyX and digits to DigitN', () => {
    expect(targetCode(findLetter('Q', 'q'))).toBe('KeyQ');
    expect(targetCode(findNumber(0))).toBe('Digit0');
    expect(targetCode(findNumber(9))).toBe('Digit9');
  });

  it('follows spell progress and is null once the word is complete', () => {
    expect(targetCode(spell(0))).toBe('KeyC');
    expect(targetCode(spell(2))).toBe('KeyT');
    expect(targetCode(spell(3))).toBeNull();
  });
});

describe('DomPromptBar construction', () => {
  it('starts hidden with an aria-hidden mini keyboard of the standard rows', () => {
    const el = q<HTMLElement>('.ks-prompt');
    expect(bar.isVisible).toBe(false);
    expect(el.hidden).toBe(true);
    expect(q('.ks-kbd').getAttribute('aria-hidden')).toBe('true');
    const codes = [...root.querySelectorAll<HTMLElement>('.ks-kbd__key')].map((k) => k.dataset.code);
    expect(codes).toEqual(KEYBOARD_ROWS.flat());
    expect(keyEl('KeyB').textContent).toBe('B');
    expect(keyEl('Digit3').textContent).toBe('3');
    expect(keyEl('Space').textContent).toBe('');
    expect(keyEl('Space').classList.contains('ks-kbd__key--space')).toBe(true);
  });

  it('accepts custom rows', () => {
    const other = document.createElement('div');
    new DomPromptBar(other, { rows: [['KeyA', 'KeyB']] });
    expect(other.querySelectorAll('.ks-kbd__key')).toHaveLength(2);
  });
});

describe('DomPromptBar.show', () => {
  it('find-letter: Find + tile + picture, colour variables, live text', () => {
    bar.show(findLetter('B', 'Bb'));
    const el = q<HTMLElement>('.ks-prompt');
    expect(bar.isVisible).toBe(true);
    expect(el.hidden).toBe(false);
    expect(el.classList.contains('is-shown')).toBe(true);
    expect(el.dataset.kind).toBe('find-letter');
    expect(q('.ks-prompt__label').textContent).toBe('Find');
    expect(q('.ks-prompt__tile').textContent).toBe('Bb');
    expect(q('.ks-prompt__pic').textContent).toBe('⚽');
    expect(q('.ks-prompt__pic').getAttribute('aria-hidden')).toBe('true');
    expect(q('.ks-prompt__check')).not.toBeNull();
    expect(el.style.getPropertyValue('--c-hex')).toBe(BLUE.hex);
    expect(el.style.getPropertyValue('--c-container')).toBe(BLUE.container);
    expect(el.style.getPropertyValue('--c-ink')).toBe(BLUE.ink);
    expect(q('[aria-live="polite"]').textContent).toBe('Find the letter B');
  });

  it('find-number: tile without a picture, its own colour', () => {
    bar.show(findNumber(7));
    const el = q<HTMLElement>('.ks-prompt');
    expect(el.dataset.kind).toBe('find-number');
    expect(q('.ks-prompt__tile').textContent).toBe('7');
    expect(q('.ks-prompt__pic')).toBeNull();
    expect(el.style.getPropertyValue('--c-hex')).toBe(RED.hex);
    expect(q('[aria-live="polite"]').textContent).toBe('Find the number 7');
  });

  it('spell: picture and one slot per letter, every letter visible, done/next marked', () => {
    bar.show(spell(1));
    expect(q<HTMLElement>('.ks-prompt').dataset.kind).toBe('spell');
    expect(q('.ks-prompt__pic').textContent).toBe('🐱');
    expect(q('.ks-prompt__tile')).toBeNull();
    const slots = [...root.querySelectorAll<HTMLElement>('.ks-slot')];
    expect(slots.map((s) => s.textContent)).toEqual(['c', 'a', 't']);
    expect(slots[0].classList.contains('is-done')).toBe(true);
    expect(slots[1].classList.contains('is-next')).toBe(true);
    expect(slots[2].className).toBe('ks-slot');
    expect(q('[aria-live="polite"]').textContent).toBe('Spell cat');
  });

  it('replacing a challenge rebuilds the card and resets the hint', () => {
    bar.show(findLetter());
    bar.update(findLetter(), 2);
    expect(targets()).toEqual(['KeyB']);
    bar.show(findNumber(4));
    expect(root.querySelectorAll('.ks-prompt__tile')).toHaveLength(1);
    expect(q('.ks-prompt__tile').textContent).toBe('4');
    expect(targets()).toEqual([]);
    expect(q<HTMLElement>('.ks-prompt').classList.contains('has-hint')).toBe(false);
  });
});

describe('DomPromptBar.update (hints and spell progress)', () => {
  it('hint 0 shows no keyboard; hint 1 marks the target; hint 2 also pulses it', () => {
    const el = q<HTMLElement>('.ks-prompt');
    bar.show(findLetter('K', 'K'));
    bar.update(findLetter('K', 'K'), 0);
    expect(el.classList.contains('has-hint')).toBe(false);
    expect(targets()).toEqual([]);
    bar.update(findLetter('K', 'K'), 1);
    expect(el.classList.contains('has-hint')).toBe(true);
    expect(targets()).toEqual(['KeyK']);
    expect(pulses()).toEqual([]);
    bar.update(findLetter('K', 'K'), 2);
    expect(targets()).toEqual(['KeyK']);
    expect(pulses()).toEqual(['KeyK']);
    bar.update(findLetter('K', 'K'), 0);
    expect(el.classList.contains('has-hint')).toBe(false);
    expect(targets()).toEqual([]);
    expect(pulses()).toEqual([]);
  });

  it('digits light up DigitN on the number row', () => {
    bar.show(findNumber(0));
    bar.update(findNumber(0), 2);
    expect(targets()).toEqual(['Digit0']);
    expect(keyEl('Digit0').classList.contains('is-pulse')).toBe(true);
  });

  it('spell: update fills slots and moves the hint to the next letter, only one target at a time', () => {
    bar.show(spell(0));
    bar.update(spell(0), 1);
    expect(targets()).toEqual(['KeyC']);
    bar.update(spell(1), 1);
    expect([...root.querySelectorAll('.ks-slot.is-done')].map((s) => s.textContent)).toEqual(['c']);
    expect(targets()).toEqual(['KeyA']);
    bar.update(spell(2), 0);
    expect([...root.querySelectorAll('.ks-slot.is-done')].map((s) => s.textContent)).toEqual(['c', 'a']);
    expect(targets()).toEqual([]);
    bar.update(spell(3), 2); // complete: nothing left to point at
    expect([...root.querySelectorAll('.ks-slot.is-done')].map((s) => s.textContent)).toEqual(['c', 'a', 't']);
    expect(targets()).toEqual([]);
    expect(q<HTMLElement>('.ks-prompt').classList.contains('has-hint')).toBe(false);
  });

  it('update does not re-trigger the entrance animation', () => {
    bar.show(spell(0));
    const el = q<HTMLElement>('.ks-prompt');
    const card = q('.ks-prompt__card').firstElementChild;
    bar.update(spell(1), 1);
    expect(el.classList.contains('is-shown')).toBe(true);
    expect(q('.ks-prompt__card').firstElementChild).toBe(card); // picture node kept
  });

  it('a target missing from the mini keyboard shows no hint', () => {
    const other = document.createElement('div');
    const small = new DomPromptBar(other, { rows: [['KeyA']] });
    small.show(findLetter('Z', 'Z'));
    small.update(findLetter('Z', 'Z'), 2);
    expect(other.querySelector('.ks-prompt')?.classList.contains('has-hint')).toBe(false);
    expect(other.querySelectorAll('.is-target')).toHaveLength(0);
  });
});

describe('DomPromptBar.celebrate and hide', () => {
  it('celebrate adds is-celebrating, clears the hint, and removes it after ~900 ms', () => {
    vi.useFakeTimers();
    const el = q<HTMLElement>('.ks-prompt');
    bar.show(findLetter());
    bar.update(findLetter(), 2);
    bar.celebrate();
    expect(el.classList.contains('is-celebrating')).toBe(true);
    expect(el.classList.contains('has-hint')).toBe(false);
    expect(targets()).toEqual([]);
    vi.advanceTimersByTime(899);
    expect(el.classList.contains('is-celebrating')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.classList.contains('is-celebrating')).toBe(false);
    expect(bar.isVisible).toBe(true);
  });

  it('a second celebrate restarts the 900 ms window', () => {
    vi.useFakeTimers();
    const el = q<HTMLElement>('.ks-prompt');
    bar.show(findNumber());
    bar.celebrate();
    vi.advanceTimersByTime(600);
    bar.celebrate();
    vi.advanceTimersByTime(600);
    expect(el.classList.contains('is-celebrating')).toBe(true);
    vi.advanceTimersByTime(300);
    expect(el.classList.contains('is-celebrating')).toBe(false);
  });

  it('showing the next challenge ends the celebration immediately and cancels its timer', () => {
    vi.useFakeTimers();
    const el = q<HTMLElement>('.ks-prompt');
    bar.show(findLetter());
    bar.celebrate();
    bar.show(findLetter('C', 'C'));
    expect(el.classList.contains('is-celebrating')).toBe(false);
    bar.celebrate();
    vi.advanceTimersByTime(500);
    bar.show(findLetter('D', 'D'));
    bar.celebrate();
    vi.advanceTimersByTime(500); // the first timer would have fired here
    expect(el.classList.contains('is-celebrating')).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('celebrate before any show is harmless', () => {
    vi.useFakeTimers();
    expect(() => bar.celebrate()).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(q<HTMLElement>('.ks-prompt').classList.contains('is-celebrating')).toBe(false);
  });

  it('hide() hides immediately, clears celebration state and pending timers', () => {
    vi.useFakeTimers();
    const el = q<HTMLElement>('.ks-prompt');
    bar.show(spell(1));
    bar.celebrate();
    bar.hide();
    expect(bar.isVisible).toBe(false);
    expect(el.hidden).toBe(true);
    expect(el.classList.contains('is-shown')).toBe(false);
    expect(el.classList.contains('is-celebrating')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    bar.hide(); // idempotent
    expect(bar.isVisible).toBe(false);
  });

  it('can be shown again after hide with a fresh card', () => {
    bar.show(spell(2));
    bar.hide();
    bar.show(findNumber(5));
    expect(bar.isVisible).toBe(true);
    expect(q<HTMLElement>('.ks-prompt').hidden).toBe(false);
    expect(root.querySelectorAll('.ks-slot')).toHaveLength(0);
    expect(q('.ks-prompt__tile').textContent).toBe('5');
  });

  it('many show/update cycles keep the DOM bounded', () => {
    for (let i = 0; i < 200; i++) {
      bar.show(i % 2 ? spell(i % 4) : findNumber(i % 10));
      bar.update(i % 2 ? spell(i % 4) : findNumber(i % 10), (i % 3) as 0 | 1 | 2);
    }
    expect(root.querySelectorAll('.ks-prompt')).toHaveLength(1);
    expect(root.querySelectorAll('.ks-prompt__card > *').length).toBeLessThanOrEqual(4);
    expect(root.querySelectorAll('.ks-kbd__key')).toHaveLength(KEYBOARD_ROWS.flat().length);
    expect(targets().length).toBeLessThanOrEqual(1);
  });
});
