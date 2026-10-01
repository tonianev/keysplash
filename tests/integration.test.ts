/**
 * Game wired to the real DOM modules (keyboard, pointer, start screen, parent
 * panel, overlays) with fake scene/audio/speech/lockdown. Catches seams the unit
 * tests can't: listener order, key swallowing, focus and data-allow-keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../src/game';
import { DomKeyboardInput } from '../src/input/keyboard';
import { DomPointerInput } from '../src/input/pointer';
import { keyMap } from '../src/keymap';
import { LocalSettingsStore } from '../src/settings';
import type { Settings } from '../src/types';
import { ALL_DONE_HOLD_MS, DomOverlays } from '../src/ui/overlays';
import { DomParentPanel } from '../src/ui/parent-panel';
import { DomStartScreen } from '../src/ui/start-screen';
import { FakeAudio, FakeLockdown, FakeScene, FakeSpeaker, FakeVisibility, flush, seeded } from './fakes';

let ui: HTMLElement;
let canvas: HTMLCanvasElement;
let game: Game | null = null;

beforeEach(() => {
  canvas = document.createElement('canvas');
  ui = document.createElement('div');
  ui.id = 'ui';
  document.body.append(canvas, ui);
});

afterEach(() => {
  game?.dispose();
  game = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function setup(initial: Partial<Settings> = {}) {
  const store = new LocalSettingsStore(null);
  store.update(initial);
  const scene = new FakeScene();
  const audio = new FakeAudio();
  const speaker = new FakeSpeaker();
  const lockdown = new FakeLockdown();
  const overlays = new DomOverlays(ui);
  const clock = { t: 1_000 };
  game = new Game({
    store,
    scene,
    audio,
    speaker,
    lockdown,
    keyMap,
    overlays,
    viewport: () => ({ width: 1000, height: 600 }),
    createKeyboard: (handlers, secretWord) => new DomKeyboardInput(window, handlers, keyMap, { secretWord, now: () => clock.t }),
    createPointer: (handlers) => new DomPointerInput(canvas, handlers),
    createStartScreen: (deps) => new DomStartScreen(ui, deps),
    createParentPanel: (deps) => new DomParentPanel(ui, deps),
    rng: seeded(),
    now: () => clock.t,
    reducedMotion: null,
    visibility: new FakeVisibility(),
  });
  return { game, store, scene, audio, speaker, lockdown, clock };
}

function keydown(target: EventTarget, key: string, code: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  target.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true, cancelable: true }));
  return event;
}

function type(word: string, clock: { t: number }): void {
  for (const ch of word) {
    clock.t += 200;
    keydown(document.body, ch, `Key${ch.toUpperCase()}`);
  }
}

const panelShown = () => ui.querySelector('.ks-panel')?.classList.contains('is-shown') ?? false;

describe('Game with the real DOM modules', () => {
  it('a key on the start screen starts play; the next key makes a glyph and is swallowed', async () => {
    const h = setup();
    expect(ui.querySelector('.ks-start')?.classList.contains('is-shown')).toBe(true);
    keydown(document.body, 'x', 'KeyX');
    expect(h.game.playState).toBe('playing');
    expect(h.lockdown.enters).toHaveLength(1);
    expect(h.scene.glyphs).toHaveLength(0); // the starting key itself only starts
    await flush();

    h.clock.t += 500;
    const event = keydown(document.body, 'a', 'KeyA');
    expect(event.defaultPrevented).toBe(true);
    expect(h.scene.glyphs.map((g) => g.text)).toEqual(['A']);
  });

  it('the secret word opens the panel; panel keys are not swallowed; Escape resumes play', async () => {
    const h = setup();
    ui.querySelector<HTMLButtonElement>('.ks-play')?.click();
    await flush();
    type('parent', h.clock);
    expect(panelShown()).toBe(true);
    const glyphs = h.scene.glyphs.length;

    // Typing inside the panel works (not default-prevented) and plays nothing.
    const input = ui.querySelector<HTMLInputElement>('.ks-panel input[type="text"], .ks-panel input:not([type])');
    expect(input).not.toBeNull();
    const typed = keydown(input as HTMLInputElement, 'b', 'KeyB');
    expect(typed.defaultPrevented).toBe(false);
    expect(h.scene.glyphs.length).toBe(glyphs);

    // Escape on the focused dialog resumes, even with the toddler keyboard attached.
    keydown(document.activeElement ?? document.body, 'Escape', 'Escape');
    expect(panelShown()).toBe(false);
    h.clock.t += 500;
    keydown(document.body, 'a', 'KeyA');
    expect(h.scene.glyphs.length).toBe(glyphs + 1);
  });

  it('"Stop" in the panel returns to the start screen and releases the keyboard', async () => {
    const h = setup();
    ui.querySelector<HTMLButtonElement>('.ks-play')?.click();
    await flush();
    type('parent', h.clock);
    const stop = [...ui.querySelectorAll<HTMLButtonElement>('.ks-panel button')].find((b) => /stop/i.test(b.textContent ?? ''));
    expect(stop).toBeDefined();
    stop?.click();
    expect(h.game.playState).toBe('idle');
    expect(h.lockdown.exits).toBe(1);
    // Keys are no longer swallowed by the play keyboard: the start screen gets them again
    // (past its 400 ms guard against a double start).
    const later = performance.now() + 1_000;
    vi.spyOn(performance, 'now').mockReturnValue(later);
    keydown(document.body, 'q', 'KeyQ');
    expect(h.game.playState).toBe('playing');
  });

  it('the All-done hold button works with Space while the toddler keyboard is attached', async () => {
    const h = setup({ sessionMinutes: 1 });
    ui.querySelector<HTMLButtonElement>('.ks-play')?.click();
    await flush();
    h.game.update(0.016, h.clock.t);
    for (let i = 0; i < 1100; i++) {
      h.clock.t += 100;
      h.game.update(0.1, h.clock.t);
    }
    expect(h.game.playState).toBe('alldone');

    vi.useFakeTimers();
    const hold = ui.querySelector<HTMLButtonElement>('.ks-hold') as HTMLButtonElement;
    hold.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(ALL_DONE_HOLD_MS + 10);
    expect(h.game.playState).toBe('playing');
    expect(h.scene.lastCalm).toBe(0);
  });

  it('a tap on the canvas spawns tap content', async () => {
    const h = setup();
    ui.querySelector<HTMLButtonElement>('.ks-play')?.click();
    await flush();
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 500, clientY: 300, pointerId: 1, pointerType: 'touch', bubbles: true }));
    expect(h.scene.shapes.length + h.scene.emoji.length).toBe(1);
    expect(h.scene.ripples).toHaveLength(1);
  });
});
