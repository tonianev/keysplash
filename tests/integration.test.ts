/**
 * Game wired to the real DOM modules (keyboard, pointer, start screen, parent
 * panel, overlays, prompt bar) and the real learning games and lesson content,
 * with fake scene/audio/speech/lockdown. Catches seams the unit tests can't:
 * listener order, key swallowing, focus and data-allow-keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LessonContent } from '../src/content';
import { Game } from '../src/game';
import { DomKeyboardInput } from '../src/input/keyboard';
import { DomPointerInput } from '../src/input/pointer';
import { keyMap } from '../src/keymap';
import { LearningGames } from '../src/modes';
import { LocalSettingsStore } from '../src/settings';
import type { Settings } from '../src/types';
import { ALL_DONE_HOLD_MS, DomOverlays } from '../src/ui/overlays';
import { DomParentPanel } from '../src/ui/parent-panel';
import { DomPromptBar } from '../src/ui/prompt-bar';
import { DomStartScreen } from '../src/ui/start-screen';
import { FakeAudio, FakeLockdown, FakeProgress, FakeScene, FakeSpeaker, FakeVisibility, flush, seeded } from './fakes';

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
  const progress = new FakeProgress();
  const overlays = new DomOverlays(ui);
  const clock = { t: 1_000 };
  const games = new LearningGames(progress, { now: () => clock.t });
  game = new Game({
    store,
    scene,
    audio,
    speaker,
    lockdown,
    keyMap,
    overlays,
    progress,
    games,
    lessons: new LessonContent(),
    setTheme: (dark) => {
      ui.dataset.theme = dark ? 'dark' : 'light';
    },
    viewport: () => ({ width: 1000, height: 600 }),
    createKeyboard: (handlers, secretWord) => new DomKeyboardInput(window, handlers, keyMap, { secretWord, now: () => clock.t }),
    createPointer: (handlers) => new DomPointerInput(canvas, handlers),
    createStartScreen: (deps) => new DomStartScreen(ui, deps),
    createParentPanel: (deps) => new DomParentPanel(ui, deps),
    createPromptBar: () => new DomPromptBar(ui),
    rng: seeded(),
    now: () => clock.t,
    reducedMotion: null,
    visibility: new FakeVisibility(),
  });
  return { game, store, scene, audio, speaker, lockdown, progress, games, clock };
}

function keydown(target: EventTarget, key: string, code: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  target.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true, cancelable: true }));
  return event;
}

/** A calm key press on the page (advances the game clock past the mash gap first). */
function press(clock: { t: number }, key: string, code: string): KeyboardEvent {
  clock.t += 300;
  return keydown(document.body, key, code);
}

function type(word: string, clock: { t: number }): void {
  for (const ch of word) press(clock, ch, `Key${ch.toUpperCase()}`);
}

const panelShown = () => ui.querySelector('.ks-panel')?.classList.contains('is-shown') ?? false;
const startShown = () => ui.querySelector('.ks-start')?.classList.contains('is-shown') ?? false;
const prompt = () => ui.querySelector<HTMLElement>('.ks-prompt');
const clickPlay = () => ui.querySelector<HTMLButtonElement>('.ks-play')?.click();

describe('Game with the real DOM modules: explore', () => {
  it('a key on the start screen starts play; the next key shows a letter card and is swallowed', async () => {
    const h = setup();
    expect(startShown()).toBe(true);
    keydown(document.body, 'x', 'KeyX');
    expect(h.game.playState).toBe('playing');
    expect(h.lockdown.enters).toHaveLength(1);
    expect(h.scene.cards).toHaveLength(0); // the starting key itself only starts
    expect(prompt()?.hidden).toBe(true); // explore: no prompt bar
    await flush();

    const event = press(h.clock, 'a', 'KeyA');
    expect(event.defaultPrevented).toBe(true);
    expect(h.scene.cards.map((c) => [c.kind, c.text, c.word])).toEqual([['letter', 'Aa', 'apple']]);
    expect(h.speaker.lastSaid?.text).toBe('ay… ay is for apple');
  });

  it('typing the secret word opens the panel; panel keys are not swallowed; Escape resumes play', async () => {
    const h = setup();
    clickPlay();
    await flush();
    type('parent', h.clock);
    expect(panelShown()).toBe(true);
    const cards = h.scene.cards.length;

    // Typing inside the panel works (not default-prevented) and plays nothing.
    const input = ui.querySelector<HTMLInputElement>('.ks-panel input[type="text"], .ks-panel input:not([type])');
    expect(input).not.toBeNull();
    const typed = keydown(input as HTMLInputElement, 'b', 'KeyB');
    expect(typed.defaultPrevented).toBe(false);
    expect(h.scene.cards.length).toBe(cards);

    // Escape on the focused dialog resumes, even with the toddler keyboard attached.
    keydown(document.activeElement ?? document.body, 'Escape', 'Escape');
    expect(panelShown()).toBe(false);
    press(h.clock, 'a', 'KeyA');
    expect(h.scene.cards.length).toBe(cards + 1);
  });

  it('"Stop" in the panel returns to the start screen and releases the keyboard', async () => {
    const h = setup();
    clickPlay();
    await flush();
    type('parent', h.clock);
    const stop = [...ui.querySelectorAll<HTMLButtonElement>('.ks-panel button')].find((b) => /stop/i.test(b.textContent ?? ''));
    expect(stop).toBeDefined();
    stop?.click();
    expect(h.game.playState).toBe('idle');
    expect(h.lockdown.exits).toBe(1);
    expect(startShown()).toBe(true);
    // Keys reach the start screen again (past its guard against a double start).
    const later = performance.now() + 1_000;
    vi.spyOn(performance, 'now').mockReturnValue(later);
    keydown(document.body, 'q', 'KeyQ');
    expect(h.game.playState).toBe('playing');
  });

  it('the All-done hold button works with Space while the toddler keyboard is attached', async () => {
    const h = setup({ sessionMinutes: 1 });
    clickPlay();
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

  it('a tap on empty canvas spawns a matte shape with a ripple; a drag paints', async () => {
    const h = setup();
    clickPlay();
    await flush();
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 500, clientY: 300, pointerId: 1, pointerType: 'touch', bubbles: true }));
    expect(h.scene.shapes).toHaveLength(1);
    expect(h.scene.ripples).toHaveLength(1);
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 600, clientY: 300, pointerId: 1, pointerType: 'touch', buttons: 1, bubbles: true }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 600, clientY: 300, pointerId: 1, pointerType: 'touch', bubbles: true }));
    expect(h.scene.trails.length).toBeGreaterThanOrEqual(1);
    expect(h.scene.endedTrails).toContain(1);
  });

  it('Space paints the rainbow and Enter clears through the real keyboard', async () => {
    const h = setup();
    clickPlay();
    await flush();
    press(h.clock, ' ', 'Space');
    press(h.clock, 'Enter', 'Enter');
    expect(h.scene.specials.map((s) => s.effect)).toEqual(['rainbow', 'clear']);
  });
});

describe('Game with the real DOM modules: learning games', () => {
  it('a find-letters round: pick the mode on the start screen, get hints after wrong keys, find it, then the next prompt', async () => {
    vi.useFakeTimers();
    const h = setup();
    ui.querySelector<HTMLButtonElement>('.ks-mode[data-mode="find-letters"]')?.click();
    expect(h.store.get().mode).toBe('find-letters');
    expect(h.game.playState).toBe('idle'); // choosing a mode does not start play
    clickPlay();
    await flush();
    const ch = h.games.current();
    if (!ch || ch.kind !== 'find-letter') throw new Error('expected a find-letter challenge');
    expect(prompt()?.hidden).toBe(false);
    expect(prompt()?.querySelector('.ks-prompt__tile')?.textContent).toBe(ch.display);
    expect(h.speaker.lastSequence?.then).toBe(ch.prompt);

    // Two wrong keys: the mini keyboard marks the target key.
    const wrong = ch.target === 'Q' ? 'z' : 'q';
    press(h.clock, wrong, `Key${wrong.toUpperCase()}`);
    expect(prompt()?.querySelector('.ks-kbd__key.is-target')).toBeNull();
    press(h.clock, wrong, `Key${wrong.toUpperCase()}`);
    expect(prompt()?.querySelector<HTMLElement>('.ks-kbd__key.is-target')?.dataset.code).toBe(`Key${ch.target}`);
    expect(h.scene.cards.every((c) => c.emphasis === 'small')).toBe(true);

    // The right key.
    press(h.clock, ch.target.toLowerCase(), `Key${ch.target}`);
    expect(prompt()?.classList.contains('is-celebrating')).toBe(true);
    expect(prompt()?.querySelector('.ks-kbd__key.is-target')).toBeNull();
    expect(h.scene.specials.at(-1)?.effect).toBe('celebrate');
    expect(h.progress.data.found[ch.target]).toBe(1);
    expect(h.game.getStats().found).toBe(1);

    const next = h.games.current();
    if (!next || next.kind !== 'find-letter') throw new Error('expected the next challenge');
    h.clock.t += 5_000;
    vi.advanceTimersByTime(5_000);
    expect(prompt()?.querySelector('.ks-prompt__tile')?.textContent).toBe(next.display);
    expect(h.speaker.lastSaid).toEqual({ text: next.prompt, priority: 'high' });
  });

  it('spelling a word fills the slots letter by letter and celebrates', async () => {
    vi.useFakeTimers();
    const h = setup({ mode: 'spell' });
    clickPlay();
    await flush();
    const ch = h.games.current();
    if (!ch || ch.kind !== 'spell') throw new Error('expected a spell challenge');
    expect(prompt()?.querySelectorAll('.ks-slot')).toHaveLength(ch.letters.length);
    press(h.clock, ch.letters[0].toLowerCase(), `Key${ch.letters[0]}`);
    expect(prompt()?.querySelectorAll('.ks-slot.is-done')).toHaveLength(1);
    expect(prompt()?.querySelector('.ks-slot.is-done')?.textContent).toBe(ch.letters[0].toLowerCase());
    for (const letter of ch.letters.slice(1)) press(h.clock, letter.toLowerCase(), `Key${letter}`);
    expect(h.audio.effectCount('complete')).toBe(1);
    expect(h.progress.data.spelled[ch.word.word]).toBe(1);
    expect(prompt()?.classList.contains('is-celebrating')).toBe(true);
  });

  it('a palm smash during a game celebrates; only its first key (before the smash is known) can be judged', async () => {
    const h = setup({ mode: 'find-letters' });
    clickPlay();
    await flush();
    h.clock.t += 1_000;
    for (const ch of 'asdfgh') {
      h.clock.t += 5;
      keydown(document.body, ch, `Key${ch.toUpperCase()}`);
    }
    expect(h.scene.specials.some((s) => s.effect === 'celebrate')).toBe(true);
    expect(h.audio.effectCount('retry')).toBeLessThanOrEqual(1); // no wrong-answer spam
    expect(prompt()?.querySelector('.ks-kbd__key.is-target')).toBeNull(); // no hint escalation
  });

  it('choosing a dark world on the start screen switches the chrome theme', () => {
    setup();
    expect(ui.dataset.theme).toBe('light');
    ui.querySelector<HTMLButtonElement>('.ks-world[data-world="space"]')?.click();
    expect(ui.dataset.theme).toBe('dark');
  });
});
