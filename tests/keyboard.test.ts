import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomKeyboardInput, SecretWordDetector, SmashDetector, isAllowedTarget } from '../src/input/keyboard';
import { keyMap } from '../src/keymap';
import type { KeyPress, SmashEvent } from '../src/types';

describe('SmashDetector', () => {
  it('fires when 4 distinct keys land within 90 ms', () => {
    const d = new SmashDetector();
    expect(d.push('KeyA', 0)).toBeNull();
    expect(d.push('KeyS', 20)).toBeNull();
    expect(d.push('KeyD', 40)).toBeNull();
    expect(d.push('KeyF', 60)).toEqual(['KeyA', 'KeyS', 'KeyD', 'KeyF']);
  });

  it('counts distinct codes only', () => {
    const d = new SmashDetector();
    expect(d.push('KeyA', 0)).toBeNull();
    expect(d.push('KeyA', 10)).toBeNull();
    expect(d.push('KeyA', 20)).toBeNull();
    expect(d.push('KeyS', 30)).toBeNull();
    expect(d.push('KeyD', 40)).toBeNull();
    expect(d.push('KeyF', 50)).toEqual(['KeyA', 'KeyS', 'KeyD', 'KeyF']);
  });

  it('ignores keys that are spread out over more than the window', () => {
    const d = new SmashDetector();
    expect(d.push('KeyA', 0)).toBeNull();
    expect(d.push('KeyS', 50)).toBeNull();
    expect(d.push('KeyD', 100)).toBeNull();
    expect(d.push('KeyF', 150)).toBeNull(); // KeyA is 150 ms old
    expect(d.push('KeyG', 200)).toBeNull();
  });

  it('reports once, then cools down so one palm is one smash', () => {
    const d = new SmashDetector(90, 4, 450);
    for (const [i, c] of ['KeyA', 'KeyS', 'KeyD'].entries()) d.push(c, i * 5);
    expect(d.push('KeyF', 15)).not.toBeNull();
    expect(d.isCoolingDown(16)).toBe(true);
    // The rest of the palm (and an immediate second palm) is absorbed.
    for (const [i, c] of ['KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'KeyQ'].entries()) {
      expect(d.push(c, 20 + i * 5)).toBeNull();
    }
    expect(d.isCoolingDown(465)).toBe(false);
    for (const [i, c] of ['KeyZ', 'KeyX', 'KeyC'].entries()) expect(d.push(c, 500 + i)).toBeNull();
    expect(d.push('KeyV', 503)).toEqual(['KeyZ', 'KeyX', 'KeyC', 'KeyV']);
  });

  it('honours a custom threshold and window', () => {
    const d = new SmashDetector(30, 3);
    expect(d.push('KeyA', 0)).toBeNull();
    expect(d.push('KeyS', 10)).toBeNull();
    expect(d.push('KeyD', 20)).toEqual(['KeyA', 'KeyS', 'KeyD']);
    const e = new SmashDetector(30, 3);
    e.push('KeyA', 0);
    e.push('KeyS', 20);
    expect(e.push('KeyD', 40)).toBeNull();
  });

  it('stays bounded under sustained mashing', () => {
    const d = new SmashDetector(90, 4);
    let smashes = 0;
    // 10 keys at 20 Hz for 10 simulated minutes.
    for (let t = 0; t < 10 * 60 * 1000; t += 5) {
      if (d.push(`Key${String.fromCharCode(65 + ((t / 5) % 26))}`, t)) smashes++;
    }
    expect(smashes).toBeGreaterThan(0);
    // At most one smash per cooldown period.
    expect(smashes).toBeLessThanOrEqual(Math.ceil((10 * 60 * 1000) / 450));
  });
});

describe('SecretWordDetector', () => {
  const type = (d: SecretWordDetector, text: string) => Array.from(text).map((k) => d.push(k));

  it('matches when the typed letters end with the word', () => {
    const d = new SecretWordDetector('parent');
    expect(type(d, 'paren')).toEqual([false, false, false, false, false]);
    expect(d.push('t')).toBe(true);
  });

  it('is a rolling buffer (noise before the word is fine)', () => {
    const d = new SecretWordDetector('parent');
    expect(type(d, 'xqzparparent').pop()).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(type(new SecretWordDetector('parent'), 'PaReNT').pop()).toBe(true);
    expect(type(new SecretWordDetector('PARENT'), 'parent').pop()).toBe(true);
  });

  it('ignores non-letter keys but not wrong letters', () => {
    const d = new SecretWordDetector('parent');
    for (const k of ['Shift', 'p', 'a', 'Shift', 'r', 'e', '1', ' ', 'n']) expect(d.push(k)).toBe(false);
    expect(d.push('t')).toBe(true);
    expect(type(new SecretWordDetector('parent'), 'parxent').pop()).toBe(false);
  });

  it('resets after a match', () => {
    const d = new SecretWordDetector('mama');
    expect(type(d, 'mama').pop()).toBe(true);
    expect(d.push('m')).toBe(false);
    expect(d.push('a')).toBe(false);
    expect(type(d, 'ma').pop()).toBe(true);
  });

  it('can change the word', () => {
    const d = new SecretWordDetector('parent');
    d.setWord('dada');
    expect(type(d, 'parent').pop()).toBe(false);
    expect(type(d, 'dada').pop()).toBe(true);
  });

  it('supports non-Latin letters', () => {
    expect(type(new SecretWordDetector('мама'), 'МАМА').pop()).toBe(true);
  });

  it('never matches an empty word', () => {
    const d = new SecretWordDetector('');
    expect(type(d, 'anything').some(Boolean)).toBe(false);
  });
});

describe('isAllowedTarget', () => {
  it('allows form fields and [data-allow-keys] subtrees only', () => {
    const panel = document.createElement('div');
    panel.setAttribute('data-allow-keys', '');
    const button = document.createElement('button');
    panel.append(button);
    const input = document.createElement('input');
    const plain = document.createElement('div');
    document.body.append(panel, input, plain);
    expect(isAllowedTarget(panel)).toBe(true);
    expect(isAllowedTarget(button)).toBe(true);
    expect(isAllowedTarget(input)).toBe(true);
    expect(isAllowedTarget(document.createElement('textarea'))).toBe(true);
    expect(isAllowedTarget(document.createElement('select'))).toBe(true);
    expect(isAllowedTarget(plain)).toBe(false);
    expect(isAllowedTarget(document.body)).toBe(false);
    expect(isAllowedTarget(window)).toBe(false);
    expect(isAllowedTarget(document)).toBe(false);
    expect(isAllowedTarget(null)).toBe(false);
    document.body.replaceChildren();
  });
});

describe('DomKeyboardInput', () => {
  let clock = 0;
  let onKey: ReturnType<typeof vi.fn<(press: KeyPress) => void>>;
  let onSmash: ReturnType<typeof vi.fn<(smash: SmashEvent) => void>>;
  let onSecret: ReturnType<typeof vi.fn<() => void>>;
  let input: DomKeyboardInput;

  const keyEvent = (type: 'keydown' | 'keyup', code: string, key: string, init: KeyboardEventInit = {}) =>
    new KeyboardEvent(type, { code, key, bubbles: true, cancelable: true, ...init });
  const down = (code: string, key = '', init: KeyboardEventInit = {}, target: EventTarget = window) => {
    const e = keyEvent('keydown', code, key, init);
    target.dispatchEvent(e);
    return e;
  };
  const up = (code: string, key = '', target: EventTarget = window) => {
    const e = keyEvent('keyup', code, key);
    target.dispatchEvent(e);
    return e;
  };
  const tap = (code: string, key = '') => {
    down(code, key);
    up(code, key);
  };
  const typeWord = (word: string, codeFor = (ch: string) => `Key${ch.toUpperCase()}`) => {
    for (const ch of word) {
      clock += 150;
      tap(codeFor(ch), ch);
    }
  };

  beforeEach(() => {
    clock = 1000;
    onKey = vi.fn();
    onSmash = vi.fn();
    onSecret = vi.fn();
    input = new DomKeyboardInput(window, { onKey, onSmash, onSecret }, keyMap, { now: () => clock });
    input.attach();
  });

  afterEach(() => {
    input.detach();
    document.body.replaceChildren();
  });

  it('dispatches key presses with position and time, and swallows the event', () => {
    const e = down('KeyA', 'a');
    expect(e.defaultPrevented).toBe(true);
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onKey.mock.calls[0][0]).toEqual({
      code: 'KeyA',
      key: 'a',
      repeat: false,
      position: keyMap.position('KeyA'),
      time: 1000,
    });
    expect(up('KeyA', 'a').defaultPrevented).toBe(true);
  });

  it('swallows browser shortcuts, Escape and unknown keys too', () => {
    // Spaced out so they don't count as a palm smash.
    expect(down('KeyR', 'r', { metaKey: true }).defaultPrevented).toBe(true);
    clock += 200;
    expect(down('F5', 'F5').defaultPrevented).toBe(true);
    clock += 200;
    expect(down('Escape', 'Escape').defaultPrevented).toBe(true);
    clock += 200;
    expect(down('', 'Unidentified').defaultPrevented).toBe(true);
    expect(onKey).toHaveBeenCalledTimes(4);
    expect(onKey.mock.calls[2][0].code).toBe('Escape');
    expect(onKey.mock.calls[3][0].position).toBeNull();
  });

  it('stops propagation so page-level listeners never see play keys', () => {
    const docListener = vi.fn();
    document.addEventListener('keydown', docListener);
    down('KeyA', 'a', {}, document.body);
    expect(docListener).not.toHaveBeenCalled();
    document.removeEventListener('keydown', docListener);
  });

  it('leaves [data-allow-keys] subtrees and form fields completely alone', () => {
    const panel = document.createElement('div');
    panel.setAttribute('data-allow-keys', '');
    const button = document.createElement('button');
    panel.append(button);
    const field = document.createElement('input');
    document.body.append(panel, field);
    const docListener = vi.fn();
    document.addEventListener('keydown', docListener);

    for (const target of [button, field, panel]) {
      const e = down('KeyA', 'a', {}, target);
      expect(e.defaultPrevented).toBe(false);
      expect(up('KeyA', 'a', target).defaultPrevented).toBe(false);
    }
    expect(onKey).not.toHaveBeenCalled();
    expect(docListener).toHaveBeenCalledTimes(3);
    document.removeEventListener('keydown', docListener);

    // Typing the secret word into a panel field must not trigger it.
    for (const ch of 'parent') down(`Key${ch.toUpperCase()}`, ch, {}, field);
    expect(onSecret).not.toHaveBeenCalled();
  });

  it('still swallows but fires nothing while disabled', () => {
    input.setEnabled(false);
    expect(down('KeyA', 'a').defaultPrevented).toBe(true);
    expect(up('KeyA', 'a').defaultPrevented).toBe(true);
    typeWord('parent');
    expect(onKey).not.toHaveBeenCalled();
    expect(onSecret).not.toHaveBeenCalled();
    input.setEnabled(true);
    clock += 200;
    down('KeyB', 'b');
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it('reports auto-repeat, and a second keydown for a held key, as repeats', () => {
    down('KeyA', 'a');
    clock += 500;
    down('KeyA', 'a', { repeat: true });
    clock += 33;
    down('KeyA', 'a'); // repeat flag missing, but the key is still held
    expect(onKey.mock.calls.map((c) => c[0].repeat)).toEqual([false, true, true]);
    up('KeyA', 'a');
    clock += 100;
    down('KeyA', 'a');
    expect(onKey.mock.calls[3][0].repeat).toBe(false);
  });

  it('treats a very old held key as a lost key-up', () => {
    down('KeyA', 'a');
    clock += 5000;
    down('KeyA', 'a');
    expect(onKey.mock.calls[1][0].repeat).toBe(false);
  });

  it('forgets held keys when the window loses focus', () => {
    down('KeyA', 'a');
    window.dispatchEvent(new Event('blur'));
    clock += 50;
    down('KeyA', 'a');
    expect(onKey.mock.calls[1][0].repeat).toBe(false);
  });

  it('forgets held keys when Meta is released (macOS drops key-ups under Cmd)', () => {
    down('MetaLeft', 'Meta');
    clock += 50;
    down('KeyC', 'c', { metaKey: true });
    clock += 50;
    up('MetaLeft', 'Meta'); // no key-up ever arrives for KeyC
    clock += 50;
    down('KeyC', 'c');
    const kc = onKey.mock.calls.filter((c) => c[0].code === 'KeyC').map((c) => c[0].repeat);
    expect(kc).toEqual([false, false]);
  });

  it('ignores IME composition', () => {
    const e = down('KeyA', 'a', { isComposing: true });
    expect(e.defaultPrevented).toBe(true);
    expect(onKey).not.toHaveBeenCalled();
  });

  it('turns a palm smash into one onSmash and absorbs the rest of the palm', () => {
    const palm = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH'];
    palm.forEach((code, i) => {
      clock = 1000 + i * 10;
      down(code, code.slice(3).toLowerCase());
    });
    expect(onKey.mock.calls.map((c) => c[0].code)).toEqual(['KeyA', 'KeyS', 'KeyD']);
    expect(onSmash).toHaveBeenCalledTimes(1);
    const smash = onSmash.mock.calls[0][0];
    expect(smash.codes).toEqual(['KeyA', 'KeyS', 'KeyD', 'KeyF']);
    expect(smash.time).toBe(1030);
    expect(smash.center).not.toBeNull();
    const xs = smash.codes.map((c) => keyMap.position(c)?.x ?? 0);
    expect(smash.center?.x).toBeCloseTo(xs.reduce((a, b) => a + b, 0) / xs.length, 6);

    // The palm stays down: auto-repeats of smashed keys are ignored.
    clock += 500;
    for (const code of palm) down(code, '', { repeat: true });
    expect(onKey).toHaveBeenCalledTimes(3);

    // After lifting the palm, keys work normally again.
    for (const code of palm) up(code);
    clock += 100;
    down('KeyJ', 'j');
    expect(onKey).toHaveBeenCalledTimes(4);
    expect(onKey.mock.calls[3][0]).toMatchObject({ code: 'KeyJ', repeat: false });
  });

  it('fires onSecret (after onKey) when the secret word is typed', () => {
    typeWord('parent');
    expect(onSecret).toHaveBeenCalledTimes(1);
    expect(onKey).toHaveBeenCalledTimes(6);
    expect(onKey.mock.invocationCallOrder[5]).toBeLessThan(onSecret.mock.invocationCallOrder[0]);
  });

  it('matches the secret word with Shift held and through noise', () => {
    clock += 150;
    tap('Digit1', '1');
    clock += 150;
    down('ShiftLeft', 'Shift');
    clock += 150;
    tap('KeyP', 'P');
    clock += 150;
    up('ShiftLeft', 'Shift');
    typeWord('arent');
    expect(onSecret).toHaveBeenCalledTimes(1);
  });

  it('matches the secret word by physical key on non-Latin layouts', () => {
    const russian: Record<string, string> = { p: 'з', a: 'ф', r: 'к', e: 'у', n: 'т', t: 'е' };
    for (const ch of 'parent') {
      clock += 150;
      tap(`Key${ch.toUpperCase()}`, russian[ch]);
    }
    expect(onSecret).toHaveBeenCalledTimes(1);
  });

  it('matches the printed letters on AZERTY', () => {
    // AZERTY: 'a' is on the QWERTY Q key.
    const codes: Record<string, string> = { p: 'KeyP', a: 'KeyQ', r: 'KeyR', e: 'KeyE', n: 'KeyN', t: 'KeyT' };
    typeWord('parent', (ch) => codes[ch]);
    expect(onSecret).toHaveBeenCalledTimes(1);
  });

  it('uses the configured secret word, and can change it', () => {
    input.detach();
    input = new DomKeyboardInput(window, { onKey, onSmash, onSecret }, keyMap, { secretWord: 'Mommy', now: () => clock });
    input.attach();
    typeWord('parent');
    expect(onSecret).not.toHaveBeenCalled();
    typeWord('mommy');
    expect(onSecret).toHaveBeenCalledTimes(1);
    input.setSecretWord('dada');
    typeWord('dada');
    expect(onSecret).toHaveBeenCalledTimes(2);
  });

  it('does not count auto-repeat towards the secret word', () => {
    input.setSecretWord('pass');
    typeWord('pa');
    clock += 150;
    down('KeyS', 's');
    clock += 500;
    down('KeyS', 's', { repeat: true }); // held: must not count as the second 's'
    up('KeyS', 's');
    expect(onSecret).toHaveBeenCalledTimes(0);
    clock += 150;
    tap('KeyS', 's');
    expect(onSecret).toHaveBeenCalledTimes(1);
  });

  it('stops listening after detach', () => {
    input.detach();
    const e = down('KeyA', 'a');
    expect(e.defaultPrevented).toBe(false);
    expect(onKey).not.toHaveBeenCalled();
    input.attach();
    input.attach(); // idempotent: one listener only
    clock += 200;
    down('KeyB', 'b');
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it('stays bounded and responsive under 10 minutes of mashing', () => {
    const codes = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL', 'Space', 'Digit3', 'Comma'];
    for (let t = 0; t < 10 * 60 * 20; t++) {
      clock += 5;
      const code = codes[t % codes.length];
      down(code, '');
      if (t % 3 === 0) up(code);
    }
    expect(onKey.mock.calls.length + onSmash.mock.calls.length).toBeGreaterThan(0);
    for (const code of codes) up(code);
    clock += 1000;
    down('KeyQ', 'q');
    expect(onKey.mock.lastCall?.[0]).toMatchObject({ code: 'KeyQ', repeat: false });
  });
});
