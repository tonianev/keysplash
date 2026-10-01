import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LessonContent, rainbowColors } from '../src/content';
import { Game, type GameDeps } from '../src/game';
import { describeKeyLocation, keyMap, pentatonic } from '../src/keymap';
import { LearningGames } from '../src/modes';
import { LocalSettingsStore } from '../src/settings';
import { TIMING } from '../src/types';
import type { Challenge, KeyPress, PokeResult, Settings } from '../src/types';
import { WORLDS } from '../src/worlds';
import {
  FakeAudio,
  FakeKeyboard,
  FakeLockdown,
  FakeOverlays,
  FakePanel,
  FakePointer,
  FakeProgress,
  FakePromptBar,
  FakeQuery,
  FakeScene,
  FakeSpeaker,
  FakeStartScreen,
  FakeVisibility,
  flush,
  seeded,
} from './fakes';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const W = 1000;
const H = 600;
/** Comfortably slower than the 90 ms mash gap. */
const CALM_GAP = 400;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(initial: Partial<Settings> = {}, extra: Partial<GameDeps> = {}) {
  const store = new LocalSettingsStore(null);
  store.update(initial);
  const scene = new FakeScene();
  const audio = new FakeAudio();
  const speaker = new FakeSpeaker();
  const lockdown = new FakeLockdown();
  const overlays = new FakeOverlays();
  const visibility = new FakeVisibility();
  const query = new FakeQuery();
  const progress = new FakeProgress();
  const promptBar = new FakePromptBar();
  const clock = { t: 10_000 };
  const games = new LearningGames(progress, { now: () => clock.t });
  const themes: boolean[] = [];
  let keyboard!: FakeKeyboard;
  let pointer!: FakePointer;
  let start!: FakeStartScreen;
  let panel!: FakePanel;
  const game = new Game({
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
    setTheme: (dark) => themes.push(dark),
    viewport: () => ({ width: W, height: H }),
    createKeyboard: (handlers, secretWord) => (keyboard = new FakeKeyboard(handlers, secretWord)),
    createPointer: (handlers) => (pointer = new FakePointer(handlers)),
    createStartScreen: (deps) => (start = new FakeStartScreen(deps)),
    createParentPanel: (deps) => (panel = new FakePanel(deps)),
    createPromptBar: () => promptBar,
    rng: seeded(),
    now: () => clock.t,
    wallClock: () => 1_700_000_000_000,
    reducedMotion: query,
    visibility,
    ...extra,
  });

  /** Advances the game clock and pending timers together. */
  const advance = (ms: number): void => {
    clock.t += ms;
    vi.advanceTimersByTime(ms);
  };
  /** A deliberate key press: waits CALM_GAP first so it is never a mash. */
  const press = (code: string, key: string, opts: { repeat?: boolean; gap?: number } = {}): void => {
    advance(opts.gap ?? CALM_GAP);
    const p: KeyPress = { code, key, repeat: !!opts.repeat, position: keyMap.position(code), time: clock.t };
    keyboard.handlers.onKey(p);
  };
  /** Runs frames every `step` ms for `ms` (timers advance too). */
  const run = (ms: number, step = 100): void => {
    game.update(0.016, clock.t);
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      advance(step);
      game.update(step / 1000, clock.t);
    }
  };
  const begin = async (): Promise<void> => {
    start.deps.onStart();
    await flush();
  };
  const challenge = (): Challenge => {
    const c = games.current();
    if (!c) throw new Error('no challenge');
    return c;
  };

  return {
    game, store, scene, audio, speaker, lockdown, overlays, visibility, query, progress, promptBar, games, clock, themes,
    keyboard, pointer, start, panel, press, run, begin, advance, challenge,
  };
}

type Harness = ReturnType<typeof setup>;

/** Press the key for a letter/digit target. */
function pressTarget(h: Harness, target: string | number): void {
  if (typeof target === 'number') h.press(`Digit${target}`, String(target));
  else h.press(`Key${target}`, target.toLowerCase());
}

/** A letter that is not `target`. */
function otherLetter(target: string): string {
  return target === 'Q' ? 'Z' : 'Q';
}

// ---------------------------------------------------------------------------
// Start / stop / lockdown
// ---------------------------------------------------------------------------

describe('Game: starting and stopping', () => {
  it('is idle on the start screen until the start gesture; keys, taps and smashes do nothing before', () => {
    const h = setup();
    expect(h.game.playState).toBe('idle');
    expect(h.game.isIdle).toBe(true);
    expect(h.start.isVisible).toBe(true);
    expect(h.keyboard.attached).toBe(false);
    h.keyboard.handlers.onKey({ code: 'KeyA', key: 'a', repeat: false, position: null, time: 0 });
    h.keyboard.handlers.onSmash({ codes: ['KeyA', 'KeyS', 'KeyD'], center: null, time: 0 });
    h.keyboard.handlers.onSecret();
    h.pointer.handlers.onTap(10, 10, 1);
    expect(h.scene.cards).toHaveLength(0);
    expect(h.scene.specials).toHaveLength(0);
    expect(h.scene.ripples).toHaveLength(0);
    expect(h.panel.isOpen).toBe(false);
  });

  it('start: requests lockdown first, unlocks audio, hides the start screen, enables inputs, greets and toasts', async () => {
    const h = setup({ childName: 'Mia', voiceStyle: 'device', confirmExit: true });
    h.start.deps.onStart();
    expect(h.lockdown.enters).toEqual([{ lockKeyboard: true }]);
    expect(h.audio.unlocks).toBeGreaterThan(0);
    expect(h.start.isVisible).toBe(false);
    expect(h.keyboard.attached && h.keyboard.enabled).toBe(true);
    expect(h.pointer.attached && h.pointer.enabled).toBe(true);
    expect(h.lockdown.confirmExit).toEqual([true]);
    expect(h.speaker.said[0]).toEqual({ text: 'Hi, Mia!', priority: 'high' });
    expect(h.promptBar.calls).toEqual([{ op: 'hide' }]); // explore: no prompt
    await flush();
    expect(h.overlays.toasts[0]).toContain('Keyboard locked');
    expect(h.overlays.toasts[0]).toContain('parent');
  });

  it("greets with \"Let's play!\" without a name and toasts the secret word when only fullscreen is granted", async () => {
    const h = setup({ secretWord: 'banana' });
    h.lockdown.grant = { fullscreen: true };
    await h.begin();
    expect(h.speaker.texts[0]).toBe("Let's play!");
    expect(h.overlays.toasts[0]).toMatch(/^Fullscreen/);
    expect(h.overlays.toasts[0]).toContain('banana');
  });

  it('survives a rejected or throwing lockdown request', async () => {
    const h = setup();
    h.lockdown.enter = () => Promise.reject(new Error('denied'));
    await h.begin();
    expect(h.game.playState).toBe('playing');
    expect(h.overlays.toasts[0]).toContain('top-left corner');

    const h2 = setup();
    h2.lockdown.enter = () => {
      throw new Error('no API');
    };
    await h2.begin();
    expect(h2.game.playState).toBe('playing');
    expect(h2.overlays.toasts[0]).toContain('top-left corner');
  });

  it('a second start while playing is ignored', async () => {
    const h = setup();
    await h.begin();
    h.start.deps.onStart();
    expect(h.lockdown.enters).toHaveLength(1);
  });

  it('stop: exits lockdown, disables and detaches inputs, cancels speech, hides the prompt, shows the start screen', async () => {
    const h = setup({ mode: 'find-letters' });
    await h.begin();
    h.panel.deps.actions.stop();
    expect(h.game.playState).toBe('idle');
    expect(h.lockdown.exits).toBe(1);
    expect(h.lockdown.confirmExit.at(-1)).toBe(false);
    expect(h.keyboard.attached).toBe(false);
    expect(h.pointer.attached).toBe(false);
    expect(h.speaker.cancels).toBeGreaterThan(0);
    expect(h.promptBar.isVisible).toBe(false);
    expect(h.start.isVisible).toBe(true);
    // Stopping twice is harmless.
    h.panel.deps.actions.stop();
    expect(h.lockdown.exits).toBe(1);
  });

  it('dispose removes every subscription', () => {
    const h = setup();
    expect(h.lockdown.listenerCount).toBe(1);
    expect(h.visibility.listenerCount).toBe(1);
    expect(h.query.hasListener).toBe(true);
    h.game.dispose();
    expect(h.lockdown.listenerCount).toBe(0);
    expect(h.visibility.listenerCount).toBe(0);
    expect(h.query.hasListener).toBe(false);
    const options = h.scene.options.length;
    h.store.update({ size: 'huge' });
    expect(h.scene.options.length).toBe(options);
  });
});

// ---------------------------------------------------------------------------
// Free play
// ---------------------------------------------------------------------------

describe('Game: free play letters', () => {
  it('a letter shows a letter card with text, picture, word and the featured letter highlighted, plays a soft note and speaks', async () => {
    const h = setup();
    await h.begin();
    h.press('KeyB', 'b');
    expect(h.scene.cards).toHaveLength(1);
    const card = h.scene.cards[0];
    expect(card).toMatchObject({
      kind: 'letter', text: 'Bb', picture: '⚽', word: 'ball', highlight: [0, 1], emphasis: 'normal', at: null,
    });
    expect(card.color?.name).toBe(WORLDS.paper.palette[1].name);
    expect(h.audio.notes).toHaveLength(1);
    expect(h.audio.notes[0].midi).toBe(keyMap.note('KeyB', WORLDS.paper.rootMidi));
    expect(h.audio.notes[0].options).toMatchObject({ velocity: 0.5, pan: 0 });
    expect(h.audio.notes[0].options!.velocity!).toBeLessThanOrEqual(0.6); // notes sit under speech
    expect(h.speaker.lastSaid).toEqual({ text: 'bee… bee is for ball', priority: 'low' });
    expect(h.progress.data.seen.B).toBe(1);
  });

  it('the same key rotates through its words in order (no randomness)', async () => {
    const h = setup();
    await h.begin();
    h.press('KeyB', 'b');
    h.press('KeyB', 'b');
    h.press('KeyB', 'b');
    h.press('KeyB', 'b');
    expect(h.scene.cards.map((c) => c.word)).toEqual(['ball', 'bear', 'banana', 'ball']);
    expect(new Set(h.scene.cards.map((c) => c.color?.name)).size).toBe(1);
    expect(new Set(h.audio.notes.map((n) => n.midi)).size).toBe(1);
  });

  it('highlights a featured letter inside the word (x in fox)', async () => {
    const h = setup();
    await h.begin();
    h.press('KeyX', 'x');
    expect(h.scene.lastCard).toMatchObject({ word: 'fox', highlight: [2, 3] });
    expect(h.speaker.lastSaid?.text).toBe('ex… fox');
  });

  it('respects letter case, pictures and speech settings; a soft effect replaces the note when notes are off', async () => {
    const h = setup({ letterCase: 'lower', pictures: false, speech: 'letter', notes: false });
    await h.begin();
    h.press('KeyM', 'm');
    expect(h.scene.lastCard).toMatchObject({ text: 'm', picture: null, word: 'moon' });
    expect(h.speaker.lastSaid?.text).toBe('em');
    expect(h.audio.notes).toHaveLength(0);
    expect(h.audio.effects.at(-1)?.name).toBe('tap');

    h.store.update({ voice: false });
    const said = h.speaker.said.length;
    h.press('KeyM', 'm');
    expect(h.speaker.said.length).toBe(said);
  });

  it("focus layout cards carry no position; keyboard layout cards sit inside the viewport near the key", async () => {
    const h = setup({ layout: 'keyboard' });
    await h.begin();
    for (const [code, key] of [['KeyQ', 'q'], ['KeyP', 'p'], ['KeyZ', 'z'], ['KeyM', 'm'], ['F5', 'F5']]) h.press(code, key);
    for (const card of h.scene.cards) {
      expect(card.at).toBeTruthy();
      expect(card.at!.x).toBeGreaterThanOrEqual(0);
      expect(card.at!.x).toBeLessThanOrEqual(W);
      expect(card.at!.y).toBeGreaterThanOrEqual(0);
      expect(card.at!.y).toBeLessThanOrEqual(H);
    }
    // Q is left of P on a keyboard.
    expect(h.scene.cards[0].at!.x).toBeLessThan(h.scene.cards[1].at!.x);
    // Notes pan with the card position.
    expect(h.audio.notes[0].options!.pan!).toBeLessThan(h.audio.notes[1].options!.pan!);

    h.store.update({ layout: 'focus' });
    h.press('KeyQ', 'q');
    expect(h.scene.lastCard?.at).toBeNull();
    expect(h.scene.lastOptions.layout).toBe('focus');
  });

  it('auto-repeat (a held key) does nothing', async () => {
    const h = setup();
    await h.begin();
    h.press('KeyA', 'a');
    const said = h.speaker.said.length;
    for (let i = 0; i < 20; i++) h.press('KeyA', 'a', { repeat: true, gap: 30 });
    expect(h.scene.cards).toHaveLength(1);
    expect(h.audio.notes).toHaveLength(1);
    expect(h.speaker.said.length).toBe(said);
    expect(h.game.getStats().keys).toBe(1);
  });

  it('mashing (keys < 90 ms apart) shows small cards, quieter notes and no speech', async () => {
    const h = setup();
    await h.begin();
    h.press('KeyA', 'a');
    const said = h.speaker.said.length;
    h.press('KeyS', 's', { gap: 40 });
    h.press('KeyD', 'd', { gap: 40 });
    h.press('KeyF', 'f', { gap: 80 });
    expect(h.scene.cards.map((c) => c.emphasis)).toEqual(['normal', 'small', 'small', 'small']);
    expect(h.speaker.said.length).toBe(said);
    expect(h.audio.notes.slice(1).every((n) => n.options!.velocity === 0.3)).toBe(true);
    // A calm press afterwards speaks again.
    h.press('KeyG', 'g');
    expect(h.scene.lastCard?.emphasis).toBe('normal');
    expect(h.speaker.said.length).toBe(said + 1);
  });
});

describe('Game: free play digits, shapes, directions, pictures', () => {
  it('a digit shows a counting card and counts aloud in step, with a rising count tick per picture', async () => {
    const h = setup();
    await h.begin();
    h.press('Digit3', '3');
    expect(h.scene.lastCard).toMatchObject({
      kind: 'digit', text: '3', picture: '🦆', count: 3, word: '3 ducks', highlight: [0, 1], emphasis: 'normal',
    });
    expect(h.speaker.sequences).toHaveLength(1);
    expect(h.speaker.lastSequence).toEqual({ parts: ['one', 'two', 'three'], stepMs: TIMING.countStepMs, then: 'three ducks!' });
    expect(h.progress.data.seen['3']).toBe(1);

    // The first tick is immediate (timer 0), then one per step.
    h.advance(0);
    expect(h.audio.effectCount('count')).toBe(1);
    h.advance(TIMING.countStepMs);
    expect(h.audio.effectCount('count')).toBe(2);
    h.advance(TIMING.countStepMs);
    expect(h.audio.effectCount('count')).toBe(3);
    h.advance(TIMING.countStepMs * 3);
    expect(h.audio.effects.filter((e) => e.name === 'count').map((e) => e.options?.step)).toEqual([0, 1, 2]);
  });

  it('a new press during counting cancels the remaining ticks', async () => {
    const h = setup();
    await h.begin();
    h.press('Digit9', '9', { gap: 0 });
    h.advance(TIMING.countStepMs + 10); // ticks 0 and 1
    h.press('KeyA', 'a', { gap: 0 });
    h.press('Digit2', '2'); // clears the 9's remaining timers
    h.advance(TIMING.countStepMs * 12);
    // 2 from the nine + 2 from the two.
    expect(h.audio.effectCount('count')).toBe(4);
  });

  it('zero says "zero — none!" without a counting sequence; the numpad counts like the number row', async () => {
    const h = setup();
    await h.begin();
    h.press('Digit0', '0');
    expect(h.scene.lastCard).toMatchObject({ kind: 'digit', count: 0, word: '0 stars' });
    expect(h.speaker.sequences).toHaveLength(0);
    expect(h.speaker.lastSaid?.text).toBe('zero — none!');
    h.press('Numpad2', '2');
    expect(h.scene.lastCard).toMatchObject({ kind: 'digit', count: 2 });
    expect(h.speaker.lastSequence?.parts).toEqual(['one', 'two']);
  });

  it('a mashed digit shows a small card but does not count', async () => {
    const h = setup();
    await h.begin();
    h.press('KeyA', 'a');
    h.press('Digit5', '5', { gap: 20 });
    expect(h.scene.lastCard).toMatchObject({ kind: 'digit', emphasis: 'small' });
    expect(h.speaker.sequences).toHaveLength(0);
    h.advance(5000);
    expect(h.audio.effectCount('count')).toBe(0);
  });

  it('a punctuation key shows a shape card "<colour> <shape>" with the colour word highlighted, always the same', async () => {
    const h = setup();
    await h.begin();
    h.press('Minus', '-');
    h.press('Minus', '-');
    const [a, b] = h.scene.cards;
    expect(a.kind).toBe('shape');
    const colour = a.color!.name;
    expect(a.word).toBe(`${colour} ${a.shape}`);
    expect(a.highlight).toEqual([0, colour.length]);
    expect(b).toMatchObject({ shape: a.shape, word: a.word });
    expect(h.speaker.lastSaid?.text).toBe(a.word);
  });

  it('arrow keys show a direction card in the direction colour and say it', async () => {
    const h = setup();
    await h.begin();
    h.press('ArrowUp', 'ArrowUp');
    expect(h.scene.lastCard).toMatchObject({ kind: 'direction', direction: 'up', word: 'up' });
    expect(h.scene.lastCard?.color?.name).toBe('blue');
    expect(h.speaker.lastSaid?.text).toBe('up!');
    h.press('ArrowLeft', 'ArrowLeft');
    expect(h.scene.lastCard).toMatchObject({ direction: 'left', word: 'left' });
  });

  it('other keys show a fixed picture card per key and say its word', async () => {
    const h = setup();
    await h.begin();
    h.press('ShiftLeft', 'Shift');
    h.press('F7', 'F7');
    h.press('ShiftLeft', 'Shift');
    const [shift, f7, shift2] = h.scene.cards;
    expect(shift).toMatchObject({ kind: 'picture', picture: '🐝', word: 'bee' });
    expect(shift.color ?? null).toBeNull(); // pictures use the neutral surface
    expect(f7.kind).toBe('picture');
    expect(f7.word).not.toBe('bee');
    expect(shift2).toMatchObject({ picture: '🐝', word: 'bee' });
    expect(h.speaker.texts).toContain('bee');
  });
});

describe('Game: Space (rainbow) and Enter (clear)', () => {
  it('Space paints a 6-colour rainbow while naming the colours, one note per band', async () => {
    const h = setup();
    await h.begin();
    h.press('Space', ' ');
    expect(h.scene.specials).toHaveLength(1);
    const call = h.scene.specials[0];
    expect(call.effect).toBe('rainbow');
    expect(call.options?.colors).toHaveLength(6);
    expect(call.options?.colors).toEqual(rainbowColors(WORLDS.paper));
    expect(call.options?.colors?.map((c) => c.name)).toEqual(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);
    expect(h.speaker.lastSequence).toEqual({
      parts: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'], stepMs: TIMING.rainbowBandMs, then: undefined,
    });
    expect(h.scene.cards).toHaveLength(0);
    h.advance(TIMING.rainbowBandMs * 6);
    expect(h.audio.notes).toHaveLength(6);
    expect(h.audio.notes.map((n) => n.midi)).toEqual([0, 1, 2, 3, 4, 5].map((i) => pentatonic(WORLDS.paper.rootMidi, i)));
  });

  it('Space is ignored while a rainbow is still painting, and works again afterwards', async () => {
    const h = setup();
    await h.begin();
    h.press('Space', ' ');
    h.press('Space', ' ', { gap: 1000 });
    h.press('Space', ' ', { gap: 2000 });
    expect(h.scene.specialCount('rainbow')).toBe(1);
    expect(h.speaker.sequences).toHaveLength(1);
    h.press('Space', ' ', { gap: 3000 });
    expect(h.scene.specialCount('rainbow')).toBe(2);
  });

  it('Space with voice off still paints but says nothing', async () => {
    const h = setup({ voice: false });
    await h.begin();
    h.press('Space', ' ');
    expect(h.scene.specialCount('rainbow')).toBe(1);
    expect(h.speaker.sequences).toHaveLength(0);
  });

  it('Enter, Backspace and Delete clear the cards with a swipe and "all clean!"', async () => {
    const h = setup();
    await h.begin();
    h.press('Enter', 'Enter');
    expect(h.scene.specials.at(-1)).toEqual({ effect: 'clear' });
    expect(h.audio.effects.at(-1)?.name).toBe('swipe');
    expect(h.speaker.lastSaid?.text).toBe('all clean!');
    h.press('Backspace', 'Backspace');
    h.press('Delete', 'Delete');
    expect(h.scene.specialCount('clear')).toBe(3);
    expect(h.scene.cards).toHaveLength(0);
  });

  it('Enter stops a counting run', async () => {
    const h = setup();
    await h.begin();
    h.press('Digit8', '8');
    h.advance(0);
    h.press('Enter', 'Enter');
    h.advance(10_000);
    expect(h.audio.effectCount('count')).toBe(1);
  });

  it('cheers the child by name on Enter and roughly every 40 presses', async () => {
    const h = setup({ childName: 'Mia', voiceStyle: 'device' });
    await h.begin();
    h.press('Enter', 'Enter');
    expect(h.speaker.lastSaid?.text).toBe('Yay, Mia!');
    for (let i = 0; i < 50; i++) h.press('KeyA', 'a');
    const cheers = h.speaker.texts.filter((t) => t === 'Yay, Mia!').length;
    expect(cheers).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Learning games
// ---------------------------------------------------------------------------

describe('Game: find letters', () => {
  it('start shows the prompt and sequences the greeting, then the prompt', async () => {
    const h = setup({ mode: 'find-letters', childName: 'Leo', voiceStyle: 'device' });
    await h.begin();
    const ch = h.challenge();
    expect(ch.kind).toBe('find-letter');
    expect(h.promptBar.calls).toEqual([{ op: 'show', challenge: ch }]);
    expect(h.speaker.sequences).toEqual([{ parts: ['Hi, Leo!'], stepMs: 1300, then: ch.prompt }]);
    expect(h.speaker.said).toHaveLength(0);
  });

  it('the right key: normal card, success sound, celebrate, prompt celebrates, progress marked; next prompt after the delay', async () => {
    const h = setup({ mode: 'find-letters' });
    await h.begin();
    const ch = h.challenge();
    if (ch.kind !== 'find-letter') throw new Error('expected find-letter');
    pressTarget(h, ch.target);

    expect(h.scene.lastCard).toMatchObject({ kind: 'letter', emphasis: 'normal' });
    expect(h.audio.effectCount('success')).toBe(1);
    expect(h.scene.specials.at(-1)).toEqual({ effect: 'celebrate' });
    expect(h.promptBar.calls.at(-1)).toEqual({ op: 'celebrate' });
    expect(h.progress.data.found[ch.target]).toBe(1);
    expect(h.game.getStats().found).toBe(1);
    const yes = h.speaker.lastSaid!;
    expect(yes.priority).toBe('high');
    expect(yes.text).toMatch(/^Yes! That's /);

    const next = h.challenge();
    expect(next).not.toBe(ch);
    const shows = h.promptBar.shown.length;
    h.advance(1300);
    expect(h.promptBar.shown.length).toBe(shows); // not yet
    h.advance(Math.max(1400, yes.text.length * 65));
    expect(h.promptBar.lastShown).toBe(next);
    expect(h.speaker.lastSaid).toEqual({ text: next.prompt, priority: 'high' });
  });

  it('a wrong key: small card, retry sound, hint escalation in the prompt bar, the location spoken once at hint 2', async () => {
    const h = setup({ mode: 'find-letters' });
    await h.begin();
    const ch = h.challenge();
    if (ch.kind !== 'find-letter') throw new Error('expected find-letter');
    const wrong = otherLetter(ch.target);
    const location = describeKeyLocation(`Key${ch.target}`);

    pressTarget(h, wrong);
    expect(h.scene.lastCard).toMatchObject({ kind: 'letter', emphasis: 'small' });
    expect(h.audio.effectCount('retry')).toBe(1);
    expect(h.audio.effectCount('success')).toBe(0);
    expect(h.speaker.lastSaid?.text).toMatch(/^That's .*Can you find/);
    expect(h.speaker.lastSaid?.text).not.toContain(location);

    for (let i = 0; i < 5; i++) pressTarget(h, wrong); // 400 ms apart: redirects are rate-limited
    expect(h.promptBar.updates.map((u) => u.hint)).toEqual([0, 1, 1, 2, 2, 2]);
    expect(h.promptBar.updates.every((u) => u.challenge === ch)).toBe(true);
    const withLocation = h.speaker.texts.filter((t) => t.includes(location));
    expect(withLocation).toHaveLength(1);
    expect(h.game.getStats().found).toBe(0);
    expect(h.progress.data.found).toEqual({});
    expect(h.scene.specialCount('celebrate')).toBe(0);
    expect(h.challenge()).toBe(ch); // never fails, never moves on
  });

  it('keys that are not part of the game (digits, arrows, Space) are free play', async () => {
    const h = setup({ mode: 'find-letters' });
    await h.begin();
    h.press('Digit2', '2');
    h.press('ArrowUp', 'ArrowUp');
    expect(h.scene.cards.map((c) => c.emphasis)).toEqual(['normal', 'normal']);
    expect(h.promptBar.updates).toHaveLength(0);
    expect(h.audio.effectCount('retry')).toBe(0);
  });

  it('mashing is never judged — not even the right key', async () => {
    const h = setup({ mode: 'find-letters' });
    await h.begin();
    const ch = h.challenge();
    if (ch.kind !== 'find-letter') throw new Error('expected find-letter');
    pressTarget(h, otherLetter(ch.target)); // deliberate wrong (judged)
    const updates = h.promptBar.updates.length;
    h.press(`Key${otherLetter(ch.target)}`, 'q', { gap: 30 });
    h.press(`Key${ch.target}`, ch.target.toLowerCase(), { gap: 30 });
    expect(h.promptBar.updates.length).toBe(updates);
    expect(h.audio.effectCount('retry')).toBe(1);
    expect(h.audio.effectCount('success')).toBe(0);
    expect(h.challenge()).toBe(ch);
    expect(h.scene.cards.slice(-2).every((c) => c.emphasis === 'small')).toBe(true);
  });

  it('a palm smash in a game celebrates with high-priority praise and is never judged wrong', async () => {
    const h = setup({ mode: 'find-letters' });
    await h.begin();
    const ch = h.challenge();
    h.advance(CALM_GAP);
    h.keyboard.handlers.onSmash({ codes: ['KeyA', 'KeyS', 'KeyD', 'KeyF'], center: { x: 0.3, y: 0.5 }, time: h.clock.t });
    expect(h.scene.specials.at(-1)).toEqual({ effect: 'celebrate' });
    expect(h.audio.chords).toHaveLength(1);
    expect(h.speaker.lastSaid?.priority).toBe('high');
    expect(h.game.getStats().smashes).toBe(1);
    // Keys right after the smash are quiet free play.
    h.press('KeyJ', 'j', { gap: 200 });
    h.press('KeyK', 'k', { gap: 200 });
    expect(h.promptBar.updates).toHaveLength(0);
    expect(h.audio.effectCount('retry')).toBe(0);
    expect(h.challenge()).toBe(ch);
  });
});

describe('Game: find numbers, spell, switching', () => {
  it('find numbers: the number row and the numpad both count; wrong digits redirect', async () => {
    const h = setup({ mode: 'find-numbers' });
    await h.begin();
    let ch = h.challenge();
    if (ch.kind !== 'find-number') throw new Error('expected find-number');
    const wrong = (ch.target + 1) % 10;
    h.press(`Digit${wrong}`, String(wrong));
    expect(h.audio.effectCount('retry')).toBe(1);
    expect(h.speaker.lastSaid?.text).toContain('Can you find');
    h.press(`Numpad${ch.target}`, String(ch.target));
    expect(h.audio.effectCount('success')).toBe(1);
    expect(h.progress.data.found[String(ch.target)]).toBe(1);
    h.advance(3000);
    ch = h.challenge();
    if (ch.kind !== 'find-number') throw new Error('expected find-number');
    expect(h.promptBar.lastShown).toBe(ch);
    pressTarget(h, ch.target);
    expect(h.game.getStats().found).toBe(2);
  });

  it('a correct digit in find numbers does not start a counting run over the praise', async () => {
    const h = setup({ mode: 'find-numbers' });
    await h.begin();
    const ch = h.challenge();
    if (ch.kind !== 'find-number') throw new Error('expected find-number');
    const before = h.speaker.sequences.length;
    pressTarget(h, ch.target);
    expect(h.speaker.sequences.length).toBe(before);
    h.advance(10_000);
    expect(h.audio.effectCount('count')).toBe(0);
  });

  it('spell: each right letter chimes and updates the slots; the last one completes the word', async () => {
    const h = setup({ mode: 'spell' });
    await h.begin();
    const ch = h.challenge();
    if (ch.kind !== 'spell') throw new Error('expected spell');
    const letters = ch.letters;
    for (let i = 0; i < letters.length - 1; i++) {
      pressTarget(h, letters[i]);
      expect(h.promptBar.updates.at(-1)).toMatchObject({ hint: 0, challenge: { index: i + 1 } });
    }
    expect(h.audio.effectCount('chime')).toBe(letters.length - 1);
    expect(h.scene.specialCount('celebrate')).toBe(0);

    // A wrong letter in the middle is gentle: retry, no progress lost.
    pressTarget(h, letters[letters.length - 1] === 'Q' ? 'Z' : 'Q');
    expect(h.audio.effectCount('retry')).toBe(1);

    pressTarget(h, letters[letters.length - 1]);
    expect(h.audio.effectCount('complete')).toBe(1);
    expect(h.audio.effectCount('success')).toBe(0);
    expect(h.scene.specialCount('celebrate')).toBe(1);
    expect(h.promptBar.calls.at(-1)).toEqual({ op: 'celebrate' });
    expect(h.progress.data.spelled[ch.word.word]).toBe(1);
    expect(h.game.getStats().spelled).toBe(1);
    expect(h.speaker.lastSaid?.text).toContain(`You spelled ${ch.word.word}!`);
    h.advance(10_000);
    expect(h.promptBar.lastShown?.kind).toBe('spell');
    expect(h.promptBar.lastShown).toBe(h.challenge());
  });

  it('a mode change from the store switches games and shows and says the new prompt; explore hides it', async () => {
    const h = setup();
    await h.begin();
    h.store.update({ mode: 'spell' });
    const spell = h.challenge();
    expect(spell.kind).toBe('spell');
    expect(h.promptBar.lastShown).toBe(spell);
    expect(h.speaker.lastSaid).toEqual({ text: spell.prompt, priority: 'high' });
    h.store.update({ mode: 'find-numbers' });
    expect(h.promptBar.lastShown?.kind).toBe('find-number');
    h.store.update({ mode: 'explore' });
    expect(h.promptBar.isVisible).toBe(false);
    expect(h.games.current()).toBeNull();
    h.press('KeyA', 'a');
    expect(h.promptBar.updates).toHaveLength(0);
  });

  it('a mode change cancels a pending next prompt from the old game', async () => {
    const h = setup({ mode: 'find-letters' });
    await h.begin();
    const ch = h.challenge();
    if (ch.kind !== 'find-letter') throw new Error('expected find-letter');
    pressTarget(h, ch.target);
    h.store.update({ mode: 'explore' });
    h.advance(10_000);
    expect(h.promptBar.isVisible).toBe(false);
  });

  it('a mode change on the start screen prepares the game without showing a prompt', () => {
    const h = setup();
    h.store.update({ mode: 'find-letters' });
    expect(h.promptBar.shown).toHaveLength(0);
  });

  it('a world change sets the dark theme and retones the visible prompt keeping its colour name', async () => {
    const h = setup({ mode: 'find-letters' });
    await h.begin();
    expect(h.themes.at(-1)).toBe(false);
    const ch = h.challenge();
    h.store.update({ world: 'space' });
    expect(h.themes.at(-1)).toBe(true);
    expect(h.scene.worlds.at(-1)?.id).toBe('space');
    const shown = h.promptBar.lastShown!;
    expect(shown.color.name).toBe(ch.color.name);
    expect(shown.color).toEqual(WORLDS.space.palette.find((c) => c.name === ch.color.name));
    expect(shown.prompt).toBe(ch.prompt);
    h.store.update({ world: 'garden' });
    expect(h.themes.at(-1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------

describe('Game: taps and drags', () => {
  const pokeCard = (h: Harness, index: number): void => {
    const card = h.scene.cards[index];
    h.scene.pokeResult = { kind: card.kind, cardId: card.id, value: card.word ?? '', color: card.color ?? null };
  };

  it('poking a letter card replays its note and word (high priority)', async () => {
    const h = setup();
    await h.begin();
    h.press('KeyB', 'b');
    pokeCard(h, 0);
    const notes = h.audio.notes.length;
    h.pointer.handlers.onTap(500, 300, 1);
    expect(h.scene.pokes).toEqual([{ x: 500, y: 300 }]);
    expect(h.audio.notes.length).toBe(notes + 1);
    expect(h.audio.notes.at(-1)?.midi).toBe(keyMap.note('KeyB', WORLDS.paper.rootMidi));
    expect(h.speaker.lastSaid).toEqual({ text: 'bee… bee is for ball', priority: 'high' });
    expect(h.scene.shapes).toHaveLength(0);
    expect(h.scene.ripples).toHaveLength(0);
    expect(h.game.getStats().taps).toBe(1);
  });

  it('poking a digit card replays the counting', async () => {
    const h = setup();
    await h.begin();
    h.press('Digit4', '4');
    h.advance(5000);
    pokeCard(h, 0);
    h.pointer.handlers.onTap(500, 300, 1);
    expect(h.speaker.sequences).toHaveLength(2);
    expect(h.speaker.lastSequence).toEqual({ parts: ['one', 'two', 'three', 'four'], stepMs: TIMING.countStepMs, then: 'four fish!' });
    h.advance(5000);
    expect(h.audio.effectCount('count')).toBe(8);
  });

  it('poking a tap shape names it; poking something unknown pops', async () => {
    const h = setup();
    await h.begin();
    const color = WORLDS.paper.palette[4];
    h.scene.pokeResult = { kind: 'shape', cardId: null, value: 'star', color } satisfies PokeResult;
    h.pointer.handlers.onTap(100, 100, 1);
    expect(h.speaker.lastSaid?.text).toBe(`${color.name} star`);
    h.scene.pokeResult = { kind: 'emoji', cardId: null, value: '🐄', color: null };
    h.pointer.handlers.onTap(100, 100, 2);
    expect(h.audio.effects.at(-1)?.name).toBe('pop');
  });

  it('a tap on empty space spawns a matte shape with a ripple and a note by x; every third tap names it', async () => {
    const h = setup();
    await h.begin();
    h.pointer.handlers.onTap(100, 300, 1);
    h.pointer.handlers.onRelease(100, 300, 1);
    h.pointer.handlers.onTap(900, 300, 1);
    h.pointer.handlers.onRelease(900, 300, 1);
    h.pointer.handlers.onTap(500, 200, 1);
    expect(h.scene.shapes).toHaveLength(3);
    expect(h.scene.ripples).toHaveLength(3);
    expect(h.scene.shapes[0]).toMatchObject({ x: 100, y: 300 });
    expect(h.scene.ripples[0]).toMatchObject({ x: 100, y: 300, color: h.scene.shapes[0].color });
    // Left is lower than right.
    expect(h.audio.notes[0].midi).toBeLessThan(h.audio.notes[1].midi);
    expect(h.audio.notes[0].options!.pan!).toBeLessThan(0);
    expect(h.audio.notes[1].options!.pan!).toBeGreaterThan(0);
    // Named on the third tap only.
    expect(h.speaker.said.filter((s) => s.text !== "Let's play!")).toEqual([
      { text: `${h.scene.shapes[2].color.name} ${h.scene.shapes[2].shape}`, priority: 'low' },
    ]);
  });

  it('drags paint a trail and play a note every ~90 px, higher on screen = higher note; release ends the stroke', async () => {
    const h = setup();
    await h.begin();
    h.pointer.handlers.onTap(100, 500, 3);
    const notes = h.audio.notes.length;
    for (let i = 0; i < 10; i++) h.pointer.handlers.onDrag(100 + i * 30, 500, 30, 0, 3);
    expect(h.scene.trails).toHaveLength(10);
    expect(new Set(h.scene.trails.map((t) => t.color.name)).size).toBe(1);
    expect(h.audio.notes.length - notes).toBe(3); // 300 px → 3 notes
    const low = h.audio.notes.at(-1)!.midi;
    for (let i = 0; i < 3; i++) h.pointer.handlers.onDrag(400, 50, 0, 30, 3);
    expect(h.audio.notes.at(-1)!.midi).toBeGreaterThan(low);
    // A huge jump plays one note, not many; garbage deltas are ignored.
    const before = h.audio.notes.length;
    h.pointer.handlers.onDrag(400, 50, 5000, 0, 3);
    h.pointer.handlers.onDrag(400, 50, Number.NaN, Number.POSITIVE_INFINITY, 3);
    expect(h.audio.notes.length - before).toBe(1);
    h.pointer.handlers.onRelease(400, 50, 3);
    expect(h.scene.endedTrails).toContain(3);
  });

  it('each stroke takes the next palette colour; trails off paints nothing but still plays notes', async () => {
    const h = setup();
    await h.begin();
    h.pointer.handlers.onDrag(10, 10, 1, 0, 1);
    h.pointer.handlers.onRelease(10, 10, 1);
    h.pointer.handlers.onDrag(10, 10, 1, 0, 2);
    expect(h.scene.trails[0].color.name).not.toBe(h.scene.trails[1].color.name);

    h.store.update({ trails: false });
    const trails = h.scene.trails.length;
    const notes = h.audio.notes.length;
    h.pointer.handlers.onDrag(10, 10, 200, 0, 4);
    expect(h.scene.trails.length).toBe(trails);
    expect(h.audio.notes.length).toBe(notes + 1);
  });

  it('mouse hover draws a silent trail only when trails are on', async () => {
    const h = setup();
    await h.begin();
    h.pointer.handlers.onHover(10, 10, 5, 5);
    h.pointer.handlers.onHover(20, 20, 10, 10);
    expect(h.scene.trails).toHaveLength(2);
    expect(h.scene.trails[0].pointerId).toBe(-1);
    expect(h.audio.notes).toHaveLength(0);
    h.store.update({ trails: false });
    h.pointer.handlers.onHover(30, 30, 10, 10);
    expect(h.scene.trails).toHaveLength(2);
  });

  it('caps tracked pointers, ending the oldest stroke', async () => {
    const h = setup();
    await h.begin();
    for (let id = 1; id <= 20; id++) h.pointer.handlers.onTap(10, 10, id);
    expect(h.scene.endedTrails).toEqual([1, 2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// Grown-up access
// ---------------------------------------------------------------------------

describe('Game: grown-up panel', () => {
  it('the secret word opens the panel, disables inputs and ends strokes; resume re-enables them', async () => {
    const h = setup();
    await h.begin();
    h.pointer.handlers.onTap(100, 100, 9); // an active pointer whose stroke must end
    h.keyboard.handlers.onSecret();
    expect(h.panel.isOpen).toBe(true);
    expect(h.game.isIdle).toBe(false);
    expect(h.keyboard.enabled).toBe(false);
    expect(h.pointer.enabled).toBe(false);
    expect(h.speaker.cancels).toBeGreaterThan(0);
    expect(h.scene.endedTrails).toContain(9);
    expect(h.overlays.corner.at(-1)).toBe(0);

    // Nothing reaches play while the panel is open.
    const cards = h.scene.cards.length;
    h.press('KeyA', 'a');
    h.pointer.handlers.onTap(500, 300, 1);
    h.pointer.handlers.onDrag(500, 300, 100, 0, 1);
    h.keyboard.handlers.onSmash({ codes: ['KeyA', 'KeyS', 'KeyD'], center: null, time: h.clock.t });
    expect(h.scene.cards.length).toBe(cards);
    expect(h.scene.specials).toHaveLength(0);

    h.panel.deps.actions.resume();
    expect(h.panel.isOpen).toBe(false);
    expect(h.keyboard.enabled).toBe(true);
    expect(h.pointer.enabled).toBe(true);
    h.press('KeyA', 'a');
    expect(h.scene.cards.length).toBe(cards + 1);
  });

  it('opening the panel cancels counting and a pending next prompt; resume re-shows and re-says the prompt', async () => {
    const h = setup({ mode: 'find-letters' });
    await h.begin();
    h.press('Digit9', '9');
    h.advance(0);
    const ch = h.challenge();
    if (ch.kind !== 'find-letter') throw new Error('expected find-letter');
    pressTarget(h, ch.target); // queues the next prompt
    const next = h.challenge();
    const shows = h.promptBar.shown.length;
    h.keyboard.handlers.onSecret();
    h.advance(10_000);
    expect(h.audio.effectCount('count')).toBe(1);
    expect(h.promptBar.shown.length).toBe(shows);

    h.panel.deps.actions.resume();
    expect(h.promptBar.lastShown).toBe(next);
    expect(h.speaker.lastSaid).toEqual({ text: next.prompt, priority: 'high' });
  });

  it('a mode change made in the panel shows the prompt silently, then says it on resume', async () => {
    const h = setup();
    await h.begin();
    h.keyboard.handlers.onSecret();
    const said = h.speaker.said.length;
    h.store.update({ mode: 'find-letters' });
    expect(h.promptBar.lastShown).toBe(h.challenge());
    expect(h.speaker.said.length).toBe(said);
    h.panel.deps.actions.resume();
    expect(h.speaker.lastSaid?.text).toBe(h.challenge().prompt);
  });

  it('the corner hold opens the panel and its progress drives the ring', async () => {
    const h = setup();
    await h.begin();
    h.pointer.handlers.onCornerProgress?.(0.5);
    expect(h.overlays.corner.at(-1)).toBe(0.5);
    h.pointer.handlers.onCornerHold();
    expect(h.panel.isOpen).toBe(true);
    h.pointer.handlers.onCornerHold(); // already open: no second open
    expect(h.panel.opens).toBe(1);
  });

  it('the start screen can open the panel; resuming from it stays on the start screen', () => {
    const h = setup();
    h.start.deps.onOpenControls?.();
    expect(h.panel.isOpen).toBe(true);
    expect(h.game.isIdle).toBe(false);
    h.panel.deps.actions.resume();
    expect(h.game.playState).toBe('idle');
    expect(h.start.isVisible).toBe(true);
    expect(h.lockdown.enters).toHaveLength(0);
  });

  it('panel actions: test sound, relock, lock status, reset stats/progress, install', async () => {
    let prompts = 0;
    const h = setup({}, { install: { canInstall: () => true, prompt: () => void prompts++ } });
    h.panel.deps.actions.relock(); // idle: explains instead
    expect(h.lockdown.enters).toHaveLength(0);
    expect(h.overlays.toasts.at(-1)).toMatch(/when play starts/);
    await h.begin();
    h.panel.deps.actions.testSound();
    expect(h.audio.chords).toHaveLength(1);
    expect(h.speaker.lastSaid).toEqual({ text: 'Hello!', priority: 'high' });
    h.panel.deps.actions.relock();
    expect(h.lockdown.enters).toHaveLength(2);
    expect(h.panel.deps.getLockStatus().fullscreen).toBe(true);
    expect(h.panel.deps.canInstall()).toBe(true);
    h.panel.deps.actions.install();
    expect(prompts).toBe(1);
    h.press('KeyA', 'a');
    h.panel.deps.actions.resetStats();
    expect(h.game.getStats()).toMatchObject({ keys: 0, taps: 0, found: 0, spelled: 0, topKeys: [] });
    h.panel.deps.actions.resetProgress();
    expect(h.progress.resets).toBe(1);
  });

  it('install is optional and a throwing lock status reads as unlocked', () => {
    const h = setup();
    expect(h.panel.deps.canInstall()).toBe(false);
    expect(() => h.panel.deps.actions.install()).not.toThrow();
    h.lockdown.status = () => {
      throw new Error('gone');
    };
    expect(h.panel.deps.getLockStatus()).toEqual({ fullscreen: false, keyboardLocked: false, wakeLock: false, installed: false });
  });
});

// ---------------------------------------------------------------------------
// Session timer, idle, rotation
// ---------------------------------------------------------------------------

describe('Game: session timer', () => {
  it('winds down for 45 s after sessionMinutes, then shows "All done!"; only a grown-up resumes', async () => {
    const h = setup({ sessionMinutes: 1, mode: 'find-letters' });
    await h.begin();
    h.run(59_000);
    expect(h.audio.fades.some(([level]) => level === 0.25)).toBe(false);

    h.run(1_100);
    expect(h.audio.lastFade).toEqual([0.25, 45]);
    h.run(22_500);
    expect(h.scene.lastCalm).toBeGreaterThan(0.4);
    expect(h.scene.lastCalm).toBeLessThan(0.6);
    expect(h.game.playState).toBe('playing');

    h.run(23_000);
    expect(h.game.playState).toBe('alldone');
    expect(h.overlays.allDone).not.toBeNull();
    expect(h.scene.lastCalm).toBe(1);
    expect(h.pointer.enabled).toBe(false);
    expect(h.promptBar.isVisible).toBe(false);

    // Keys do nothing now except the secret word.
    const cards = h.scene.cards.length;
    h.press('KeyA', 'a');
    h.keyboard.handlers.onSmash({ codes: ['KeyA', 'KeyS', 'KeyD', 'KeyF'], center: null, time: h.clock.t });
    h.pointer.handlers.onTap(500, 300, 1);
    expect(h.scene.cards.length).toBe(cards);
    expect(h.scene.specials).toHaveLength(0);
    expect(h.keyboard.enabled).toBe(true); // still listening for the secret word

    // Parent-gated resume: the timer restarts, calm 0, full volume, the prompt comes back.
    h.overlays.allDone?.();
    expect(h.game.playState).toBe('playing');
    expect(h.scene.lastCalm).toBe(0);
    expect(h.audio.lastFade[0]).toBe(1);
    expect(h.pointer.enabled).toBe(true);
    expect(h.promptBar.isVisible).toBe(true);
    h.run(30_000);
    expect(h.game.playState).toBe('playing');
  });

  it('the secret word on the All-done screen opens the panel, and "Keep playing" resumes', async () => {
    const h = setup({ sessionMinutes: 1 });
    await h.begin();
    h.run(106_000);
    expect(h.game.playState).toBe('alldone');
    h.keyboard.handlers.onSecret();
    expect(h.panel.isOpen).toBe(true);
    h.panel.deps.actions.resume();
    expect(h.game.playState).toBe('playing');
    expect(h.overlays.allDone).toBeNull();
    expect(h.keyboard.enabled).toBe(true);
  });

  it('does not count time while the panel is open or the page is hidden; long frame gaps are capped', async () => {
    const h = setup({ sessionMinutes: 1 });
    await h.begin();
    h.run(30_000);
    const played = h.game.getStats().playMs;
    expect(played).toBeGreaterThanOrEqual(29_900);
    h.keyboard.handlers.onSecret();
    h.run(120_000);
    h.panel.deps.actions.resume();
    h.visibility.set(false);
    h.run(120_000);
    h.visibility.set(true);
    expect(h.game.playState).toBe('playing');
    expect(h.game.getStats().playMs).toBeLessThan(played + 1_000);
    // A 10-minute frame gap (debugger, sleep) counts as at most 250 ms.
    h.game.update(0.016, h.clock.t);
    h.clock.t += 600_000;
    h.game.update(0.05, h.clock.t);
    expect(h.game.getStats().playMs).toBeLessThan(played + 1_500);
    expect(h.game.playState).toBe('playing');
  });

  it('changing sessionMinutes mid wind-down restarts the timer; 0 never winds down', async () => {
    const h = setup({ sessionMinutes: 1 });
    await h.begin();
    h.run(70_000);
    expect(h.scene.lastCalm).toBeGreaterThan(0);
    h.store.update({ sessionMinutes: 0 });
    expect(h.scene.lastCalm).toBe(0);
    h.run(10 * 60_000, 1_000);
    expect(h.game.playState).toBe('playing');
  });
});

describe('Game: idle', () => {
  it('in explore, after 20 s without input a friend drifts by every ~4 s, silently, until input', async () => {
    const h = setup();
    await h.begin();
    h.run(19_000);
    expect(h.scene.emoji).toHaveLength(0);
    h.run(1_500);
    expect(h.scene.emoji).toHaveLength(1);
    expect(WORLDS.paper.friends).toContain(h.scene.emoji[0].emoji);
    const x = h.scene.emoji[0].x;
    expect(x < 0 || x > W).toBe(true); // starts off-screen
    h.run(12_000);
    expect(h.scene.emoji.length).toBeGreaterThanOrEqual(3);
    expect(h.scene.emoji.length).toBeLessThanOrEqual(5);
    expect(h.audio.notes).toHaveLength(0);
    expect(h.audio.effects).toHaveLength(0);
    const count = h.scene.emoji.length;
    h.press('KeyA', 'a');
    h.run(10_000);
    expect(h.scene.emoji.length).toBe(count);
  });

  it('in a game there are no idle friends; the prompt is repeated once after 25 s of quiet', async () => {
    const h = setup({ mode: 'find-letters' });
    await h.begin();
    const ch = h.challenge();
    h.run(24_000);
    expect(h.speaker.said).toHaveLength(0);
    h.run(1_500);
    expect(h.speaker.said).toEqual([{ text: ch.prompt, priority: 'low' }]);
    h.run(60_000);
    expect(h.speaker.said).toHaveLength(1);
    expect(h.scene.emoji).toHaveLength(0);
    // A wrong answer restarts the quiet timer.
    pressTarget(h, ch.kind === 'find-letter' ? otherLetter(ch.target) : 'Q');
    const said = h.speaker.said.length;
    h.run(26_000);
    expect(h.speaker.said.length).toBe(said + 1);
    expect(h.speaker.lastSaid?.text).toBe(ch.prompt);
  });

  it('auto-rotates to the next world every rotateMinutes of play', async () => {
    const h = setup({ autoRotate: true, rotateMinutes: 1, world: 'ocean' });
    await h.begin();
    h.run(61_000);
    expect(h.store.get().world).toBe('space');
    expect(h.scene.worlds.at(-1)?.id).toBe('space');
    expect(h.audio.timbre).toBe(WORLDS.space.timbre);
    expect(h.audio.root).toBe(WORLDS.space.rootMidi);
    expect(h.themes.at(-1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fullscreen loss
// ---------------------------------------------------------------------------

describe('Game: fullscreen loss', () => {
  it('shows the resume screen when fullscreen is lost after it was granted; its tap re-enters', async () => {
    const h = setup();
    await h.begin();
    expect(h.lockdown.current.fullscreen).toBe(true);
    h.lockdown.set({ ...h.lockdown.current, fullscreen: false, keyboardLocked: false });
    expect(h.overlays.resume).not.toBeNull();
    h.overlays.resume?.();
    expect(h.lockdown.enters).toHaveLength(2);
    await flush();
    expect(h.lockdown.current.fullscreen).toBe(true);
    expect(h.overlays.resume).toBeNull();
  });

  it('does not show the resume screen if fullscreen was never granted', async () => {
    const h = setup();
    h.lockdown.grant = { wakeLock: true };
    await h.begin();
    h.lockdown.set({ ...h.lockdown.current, wakeLock: false });
    expect(h.overlays.resumeShows).toBe(0);
  });

  it('does not show the resume screen when the parent pressed Stop', async () => {
    const h = setup();
    await h.begin();
    h.keyboard.handlers.onSecret();
    h.panel.deps.actions.stop();
    expect(h.lockdown.exits).toBe(1);
    expect(h.lockdown.current.fullscreen).toBe(false);
    expect(h.overlays.resumeShows).toBe(0);
    expect(h.start.isVisible).toBe(true);
  });

  it('with the panel open, losing fullscreen waits for "Keep playing", which re-requests it', async () => {
    const h = setup();
    await h.begin();
    h.keyboard.handlers.onSecret();
    h.lockdown.set({ ...h.lockdown.current, fullscreen: false });
    expect(h.overlays.resumeShows).toBe(0);
    h.panel.deps.actions.resume();
    expect(h.lockdown.enters).toHaveLength(2);
  });

  it('falls back to the resume screen when re-entering without a gesture fails', async () => {
    const h = setup();
    await h.begin();
    h.keyboard.handlers.onSecret();
    h.lockdown.set({ ...h.lockdown.current, fullscreen: false });
    h.lockdown.grant = {}; // e.g. Escape is not a user activation
    h.panel.deps.actions.resume();
    await flush();
    expect(h.overlays.resumeShows).toBe(1);
  });

  it('a stop while the start request is pending exits again instead of leaving fullscreen on', async () => {
    const h = setup();
    h.start.deps.onStart();
    h.panel.deps.actions.stop();
    await flush();
    expect(h.game.playState).toBe('idle');
    expect(h.lockdown.current.fullscreen).toBe(false);
    expect(h.overlays.resumeShows).toBe(0);
  });

  it('toggling the keyboard lock while fullscreen re-requests the locks', async () => {
    const h = setup();
    await h.begin();
    h.store.update({ lockKeyboard: false });
    expect(h.lockdown.enters.at(-1)).toEqual({ lockKeyboard: false });
  });
});

// ---------------------------------------------------------------------------
// Settings, visibility, stats
// ---------------------------------------------------------------------------

describe('Game: live settings and page visibility', () => {
  it('applies settings at boot', () => {
    const h = setup({ world: 'night', volume: 0.4, voice: false, voiceURI: 'v1', secretWord: 'mommy', layout: 'keyboard' });
    expect(h.audio.volume).toBe(0.4);
    expect(h.audio.timbre).toBe(WORLDS.night.timbre);
    expect(h.audio.root).toBe(WORLDS.night.rootMidi);
    expect(h.speaker.volume).toBe(0.4);
    expect(h.speaker.voice).toBe('v1');
    expect(h.speaker.enabled).toBe(false);
    expect(h.scene.worlds.at(-1)?.id).toBe('night');
    expect(h.scene.lastOptions.layout).toBe('keyboard');
    expect(h.scene.lastOptions.fontFamily).toContain('Andika');
    expect(h.themes).toEqual([true]);
    expect(h.keyboard.secretWords.at(-1)).toBe('mommy');
  });

  it('applies every change live', async () => {
    const h = setup();
    await h.begin();
    h.store.update({ volume: 0.3 });
    expect(h.audio.volume).toBe(0.3);
    expect(h.speaker.volume).toBe(0.3);
    h.store.update({ muted: true });
    expect(h.audio.muted).toBe(true);
    expect(h.speaker.enabled).toBe(false);
    h.store.update({ muted: false, speech: 'letter' });
    expect(h.speaker.enabled).toBe(true);
    h.store.update({ voiceURI: 'v2' });
    expect(h.speaker.voice).toBe('v2');
    h.store.update({ intensity: 'lively', size: 'huge', faces: true });
    expect(h.scene.lastOptions).toMatchObject({ intensity: 'lively', size: 'huge', faces: true });
    h.store.update({ confirmExit: false });
    expect(h.lockdown.confirmExit.at(-1)).toBe(false);
    h.store.update({ secretWord: 'banana' });
    expect(h.keyboard.secretWords.at(-1)).toBe('banana');
  });

  it('resolves reduced motion from the setting, or the system preference when "system"', () => {
    const h = setup({ motion: 'system' });
    expect(h.scene.lastOptions.reduceMotion).toBe(false);
    h.query.set(true);
    expect(h.scene.lastOptions.reduceMotion).toBe(true);
    h.store.update({ motion: 'full' });
    expect(h.scene.lastOptions.reduceMotion).toBe(false);
    h.store.update({ motion: 'reduce' });
    h.query.set(false);
    expect(h.scene.lastOptions.reduceMotion).toBe(true);
  });

  it('fades audio, cancels speech and ends strokes while the page is hidden', async () => {
    const h = setup();
    await h.begin();
    h.pointer.handlers.onTap(10, 10, 5);
    h.visibility.set(false);
    expect(h.audio.lastFade[0]).toBe(0);
    expect(h.speaker.cancels).toBeGreaterThan(0);
    expect(h.scene.endedTrails).toContain(5);
    h.visibility.set(true);
    expect(h.audio.lastFade[0]).toBe(1);
  });

  it('counts stats with top keys by label (max 5, highest first) and bounded label memory', async () => {
    const h = setup();
    await h.begin();
    for (const [code, key, n] of [['KeyA', 'a', 3], ['Digit1', '1', 2], ['Space', ' ', 1], ['ArrowUp', 'ArrowUp', 4], ['KeyB', 'b', 1], ['Minus', '-', 1]] as const) {
      for (let i = 0; i < n; i++) h.press(code, key, { gap: 6000 });
    }
    const stats = h.game.getStats();
    expect(stats.keys).toBe(12);
    expect(stats.topKeys).toEqual([['↑', 4], ['A', 3], ['1', 2], ['-', 1], ['B', 1]]);
    expect(stats.startedAt).toBe(1_700_000_000_000);
    // Hundreds of unknown codes never grow the label map without bound (and never crash).
    for (let i = 0; i < 400; i++) h.press(`Unknown${i}`, `X${i}`, { gap: 100 });
    expect(h.game.getStats().keys).toBe(412);
    expect(h.game.getStats().topKeys).toHaveLength(5);
  });

  it('a world changed in the panel keeps the new world tones in the prompt after "Keep playing"', async () => {
    const h = setup({ mode: 'find-letters' });
    await h.begin();
    const ch = h.challenge();
    h.keyboard.handlers.onSecret();
    h.store.update({ world: 'space' });
    h.panel.deps.actions.resume();
    const expected = WORLDS.space.palette.find((c) => c.name === ch.color.name);
    expect(h.promptBar.lastShown?.color).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------

describe('Game: review fixes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('between a found answer and the next prompt, keys are free play (never judged against a hidden target)', async () => {
    const h = setup({ mode: 'find-letters' });
    await h.begin();
    const ch = h.challenge();
    if (ch.kind !== 'find-letter') throw new Error('expected find-letter');
    pressTarget(h, ch.target);
    const next = h.challenge();
    const updates = h.promptBar.updates.length;
    const retries = h.audio.effectCount('retry');
    // The child presses the same key again right away — very common.
    pressTarget(h, ch.target);
    pressTarget(h, next.kind === 'find-letter' ? otherLetter(next.target) : 'Q');
    expect(h.audio.effectCount('retry')).toBe(retries);
    expect(h.promptBar.updates.length).toBe(updates);
    expect(h.game.getStats().found).toBe(1);
    h.advance(5000);
    expect(h.promptBar.lastShown).toBe(next);
    // Now the game judges again.
    pressTarget(h, next.kind === 'find-letter' ? otherLetter(next.target) : 'Q');
    expect(h.audio.effectCount('retry')).toBe(retries + 1);
  });

  it('the last letter of a spelled word fills its slot before the celebration', async () => {
    const h = setup({ mode: 'spell' });
    await h.begin();
    const ch = h.challenge();
    if (ch.kind !== 'spell') throw new Error('expected spell');
    for (const letter of ch.letters) h.press(`Key${letter}`, letter.toLowerCase());
    const last = h.promptBar.updates.at(-1)!;
    expect(last.challenge.kind === 'spell' && last.challenge.index).toBe(ch.letters.length);
    const ops = h.promptBar.calls.map((c) => c.op);
    expect(ops.lastIndexOf('update')).toBeLessThan(ops.lastIndexOf('celebrate'));
  });

  it('hints use the physical key learned from this keyboard (AZERTY: A is typed on KeyQ)', async () => {
    const h = setup({ mode: 'find-letters' });
    await h.begin();
    // Teach the game the layout: on AZERTY, the KeyQ position types "a".
    h.press('KeyQ', 'a');
    h.advance(5000);
    // Force a find-A challenge and miss it a few times.
    let ch = h.challenge();
    let guard = 0;
    while ((ch.kind !== 'find-letter' || ch.target !== 'A') && guard++ < 200) ch = h.games.skip({ world: WORLDS.paper, settings: h.store.get(), rng: Math.random }) as Challenge;
    expect(ch.kind === 'find-letter' && ch.target).toBe('A');
    for (let i = 0; i < 4; i++) h.press('KeyZ', 'w');
    expect(h.promptBar.codes.at(-1)).toBe('KeyQ');
    expect(h.speaker.texts.some((t) => t.includes(describeKeyLocation('KeyQ')))).toBe(true);
  });

  it('keeps the centre card below the prompt (and its hint keyboard)', async () => {
    const h = setup({ mode: 'find-letters' });
    await h.begin();
    expect(h.scene.insets.at(-1)).toBe(h.promptBar.bottom);
    h.store.update({ mode: 'explore' });
    expect(h.scene.insets.at(-1)).toBe(0);
  });

  it('in a game, digits count with ticks but do not talk over the prompt', async () => {
    const h = setup({ mode: 'find-letters' });
    await h.begin();
    h.advance(3000);
    const sequences = h.speaker.sequences.length;
    h.press('Digit3', '3');
    expect(h.speaker.sequences.length).toBe(sequences);
    h.advance(3 * TIMING.countStepMs);
    expect(h.audio.effectCount('count')).toBe(3);
  });

  it('a prompt that comes due while the page is hidden waits until it is visible again', async () => {
    const h = setup({ mode: 'find-letters' });
    await h.begin();
    const ch = h.challenge();
    if (ch.kind !== 'find-letter') throw new Error('expected find-letter');
    pressTarget(h, ch.target);
    const next = h.challenge();
    h.visibility.set(false);
    h.advance(5000);
    expect(h.promptBar.lastShown).not.toBe(next);
    h.visibility.set(true);
    expect(h.promptBar.lastShown).toBe(next);
  });
});

// ---------------------------------------------------------------------------
// Voice on/off and voice style
// ---------------------------------------------------------------------------

describe('Game: voice switch and style', () => {
  const NAME_LINE = /Mia/;

  it('voice off: nothing at all is said (greeting, keys, rainbow, smash, test sound), notes still play', async () => {
    const h = setup({ voice: false, childName: 'Mia', voiceStyle: 'device', mode: 'find-letters' });
    expect(h.speaker.enabled).toBe(false);
    await h.begin();
    for (const [code, key] of [['KeyA', 'a'], ['Digit3', '3'], ['Enter', 'Enter'], ['Space', ' ']]) h.press(code, key, { gap: 3000 });
    h.keyboard.handlers.onSmash({ codes: ['KeyA', 'KeyS', 'KeyD', 'KeyF'], center: null, time: h.clock.t });
    h.run(5000);
    h.panel.deps.actions.testSound();
    expect(h.speaker.said).toHaveLength(0);
    expect(h.speaker.sequences).toHaveLength(0);
    expect(h.audio.effects.length + h.audio.notes.length).toBeGreaterThan(0);
  });

  it('turning the voice off and on mid-play disables and re-enables speech', async () => {
    const h = setup({ speech: 'letter' });
    await h.begin();
    h.store.update({ voice: false });
    expect(h.speaker.enabled).toBe(false);
    const said = h.speaker.said.length;
    h.press('KeyM', 'm');
    expect(h.speaker.said.length).toBe(said);
    h.store.update({ voice: true });
    expect(h.speaker.enabled).toBe(true);
    h.press('KeyM', 'm');
    expect(h.speaker.lastSaid?.text).toBe('em');
  });

  it('mute also silences the voice', async () => {
    const h = setup({ muted: true });
    expect(h.speaker.enabled).toBe(false);
    await h.begin();
    expect(h.speaker.said).toHaveLength(0);
  });

  it('natural style never builds name lines: greeting, cheers, praise, test sound', async () => {
    const h = setup({ childName: 'Mia', voiceStyle: 'natural' });
    await h.begin();
    expect(h.speaker.said[0]).toEqual({ text: "Let's play!", priority: 'high' });
    h.press('Enter', 'Enter');
    expect(h.speaker.lastSaid?.text).toBe('Yay!');
    for (let i = 0; i < 20; i++) {
      h.advance(3000);
      h.keyboard.handlers.onSmash({ codes: ['KeyA', 'KeyS', 'KeyD', 'KeyF'], center: null, time: h.clock.t });
    }
    h.panel.deps.actions.testSound();
    expect(h.speaker.lastSaid?.text).toBe('Hello!');
    expect(h.speaker.texts.filter((t) => NAME_LINE.test(t))).toEqual([]);
  });

  it('natural style keeps game praise nameless too', async () => {
    const h = setup({ mode: 'find-letters', childName: 'Mia', voiceStyle: 'natural' });
    await h.begin();
    for (let i = 0; i < 30; i++) {
      pressTarget(h, (h.challenge() as { target: string | number }).target);
      h.run(3000);
    }
    const all = [...h.speaker.texts, ...h.speaker.sequences.flatMap((s) => [...s.parts, s.then ?? ''])];
    expect(all.filter((t) => NAME_LINE.test(t))).toEqual([]);
  });

  it('device style keeps the name lines', async () => {
    const h = setup({ childName: 'Mia', voiceStyle: 'device' });
    await h.begin();
    expect(h.speaker.said[0].text).toBe('Hi, Mia!');
    h.panel.deps.actions.testSound();
    expect(h.speaker.lastSaid?.text).toBe('Hi, Mia!');
  });

  it('warms the voice right after unlocking audio on start', async () => {
    const h = setup();
    expect(h.speaker.warms).toBe(0);
    await h.begin();
    expect(h.speaker.warms).toBe(1);
    expect(h.audio.unlocks).toBeGreaterThan(0);
  });

  it('applies the voice style at boot and when it changes', () => {
    const h = setup({ voiceStyle: 'device' });
    expect(h.speaker.styles).toEqual(['device']);
    h.store.update({ voiceStyle: 'natural' });
    expect(h.speaker.styles).toEqual(['device', 'natural']);
    h.store.update({ volume: 0.5 });
    expect(h.speaker.styles).toEqual(['device', 'natural']);
  });
});
