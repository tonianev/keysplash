import { describe, expect, it } from 'vitest';
import { Game, type GameDeps } from '../src/game';
import { keyMap, pentatonic } from '../src/keymap';
import { LocalSettingsStore } from '../src/settings';
import { WORLDS } from '../src/worlds';
import type { KeyPress, Settings, SoundEffect } from '../src/types';
import {
  FakeAudio,
  FakeKeyboard,
  FakeLockdown,
  FakeOverlays,
  FakePanel,
  FakePointer,
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
  const clock = { t: 10_000 };
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
    viewport: () => ({ width: W, height: H }),
    createKeyboard: (handlers, secretWord) => (keyboard = new FakeKeyboard(handlers, secretWord)),
    createPointer: (handlers) => (pointer = new FakePointer(handlers)),
    createStartScreen: (deps) => (start = new FakeStartScreen(deps)),
    createParentPanel: (deps) => (panel = new FakePanel(deps)),
    rng: seeded(),
    now: () => clock.t,
    wallClock: () => 1_700_000_000_000,
    reducedMotion: query,
    visibility,
    ...extra,
  });

  const press = (code: string, key: string, repeat = false): void => {
    const p: KeyPress = { code, key, repeat, position: keyMap.position(code), time: clock.t };
    keyboard.handlers.onKey(p);
  };
  /** Advances the clock and runs frames every `step` ms. */
  const run = (ms: number, step = 100): void => {
    game.update(0.016, clock.t);
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      clock.t += step;
      game.update(step / 1000, clock.t);
    }
  };
  const begin = async (): Promise<void> => {
    start.deps.onStart();
    await flush();
  };

  return { game, store, scene, audio, speaker, lockdown, overlays, visibility, query, clock, keyboard, pointer, start, panel, press, run, begin };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Game: starting and stopping', () => {
  it('is idle on the start screen until the start gesture; keys do nothing before', () => {
    const h = setup();
    expect(h.game.playState).toBe('idle');
    expect(h.start.isVisible).toBe(true);
    expect(h.keyboard.attached).toBe(false);
    h.keyboard.handlers.onKey({ code: 'KeyA', key: 'a', repeat: false, position: null, time: 0 });
    expect(h.scene.glyphs).toHaveLength(0);
  });

  it('start: requests lockdown first, unlocks audio, hides the start screen, enables inputs, greets and toasts', async () => {
    const h = setup({ childName: 'Mia', confirmExit: true });
    h.start.deps.onStart();
    expect(h.lockdown.enters).toEqual([{ lockKeyboard: true }]);
    expect(h.audio.unlocks).toBeGreaterThan(0);
    expect(h.start.isVisible).toBe(false);
    expect(h.keyboard.attached && h.keyboard.enabled).toBe(true);
    expect(h.pointer.attached && h.pointer.enabled).toBe(true);
    expect(h.lockdown.confirmExit).toEqual([true]);
    expect(h.speaker.said[0]).toEqual({ text: 'Hi, Mia!', priority: 'high' });
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

  it('survives a rejected lockdown request', async () => {
    const h = setup();
    h.lockdown.enter = () => Promise.reject(new Error('denied'));
    await h.begin();
    expect(h.game.playState).toBe('playing');
    expect(h.overlays.toasts[0]).toContain('top-left corner');
  });

  it('stop: exits lockdown, disables and detaches inputs, shows the start screen', async () => {
    const h = setup();
    await h.begin();
    h.panel.deps.actions.stop();
    expect(h.game.playState).toBe('idle');
    expect(h.lockdown.exits).toBe(1);
    expect(h.keyboard.attached).toBe(false);
    expect(h.pointer.attached).toBe(false);
    expect(h.start.isVisible).toBe(true);
    expect(h.lockdown.confirmExit).toEqual([true, false]);
  });
});

describe('Game: keys', () => {
  it('a letter spawns a glyph with picture and caption, bursts, plays its note panned by x, and speaks', async () => {
    const h = setup({ world: 'ocean', speech: 'word', pictures: true, spatialKeys: true });
    await h.begin();
    h.speaker.said.length = 0;
    h.press('KeyA', 'a');

    expect(h.scene.glyphs).toHaveLength(1);
    const g = h.scene.glyphs[0];
    expect(g.text).toBe('A');
    expect(g.emoji).toBeTruthy();
    expect(g.caption).toBeTruthy();
    // Spatial: KeyA sits on the left of the keyboard → left part of the safe area (±4% jitter).
    const pos = keyMap.position('KeyA')!;
    expect(Math.abs(g.x - W * (0.1 + 0.8 * pos.x))).toBeLessThanOrEqual(0.04 * W + 1e-9);
    expect(Math.abs(g.y - H * (0.1 + 0.8 * pos.y))).toBeLessThanOrEqual(0.04 * H + 1e-9);

    expect(h.scene.bursts).toHaveLength(1);
    expect(h.audio.notes).toHaveLength(1);
    expect(h.audio.notes[0].midi).toBe(keyMap.note('KeyA', WORLDS.ocean.rootMidi));
    expect(h.audio.notes[0].options?.pan).toBeCloseTo((g.x / W) * 2 - 1, 6);
    expect(h.speaker.said).toHaveLength(1);
    expect(h.speaker.said[0].text).toMatch(/^ay… .+!$/);
    expect(h.speaker.said[0].priority).toBe('low');
  });

  it('respects pictures/speech settings and plays a soft effect instead of a note when notes are off', async () => {
    const h = setup({ pictures: false, speech: 'letter', notes: false });
    await h.begin();
    h.press('KeyB', 'b');
    expect(h.scene.glyphs[0].emoji).toBeNull();
    expect(h.scene.glyphs[0].caption).toBeNull();
    expect(h.audio.notes).toHaveLength(0);
    expect(h.audio.effectCount('pop')).toBe(1);
    expect(h.speaker.texts).toContain('bee');
  });

  it('digits count, shapes are named, other keys bring a friend with a boing', async () => {
    const h = setup();
    await h.begin();
    h.press('Digit3', '3');
    expect(h.scene.glyphs[0]).toMatchObject({ text: '3', count: 3 });
    expect(h.scene.glyphs[0].emoji).toBeTruthy();
    h.clock.t += 500;
    h.press('Semicolon', ';');
    expect(h.scene.shapes).toHaveLength(1);
    expect(h.speaker.texts.at(-1)).toMatch(/^\w+ \w+$/);
    h.clock.t += 500;
    h.press('ShiftLeft', 'Shift');
    expect(h.scene.emoji).toHaveLength(1);
    expect(h.audio.effectCount('boing')).toBe(1);
  });

  it('random placement (spatial off) stays in the safe area and avoids the last spots', async () => {
    const h = setup({ spatialKeys: false });
    await h.begin();
    for (let i = 0; i < 30; i++) {
      h.clock.t += 400;
      h.press('KeyQ', 'q');
    }
    const spots = h.scene.glyphs.map((g) => [g.x, g.y]);
    for (const [x, y] of spots) {
      expect(x).toBeGreaterThanOrEqual(0.1 * W);
      expect(x).toBeLessThanOrEqual(0.9 * W);
      expect(y).toBeGreaterThanOrEqual(0.1 * H);
      expect(y).toBeLessThanOrEqual(0.9 * H);
    }
    // Consecutive spots are never on top of each other.
    for (let i = 1; i < spots.length; i++) {
      expect(Math.hypot(spots[i][0] - spots[i - 1][0], spots[i][1] - spots[i - 1][1])).toBeGreaterThan(20);
    }
  });

  it('special keys trigger scene effects with matching sounds', async () => {
    const h = setup({ speech: 'word' });
    await h.begin();
    const specials: Array<[string, string, SoundEffect]> = [
      ['Space', ' ', 'sparkle'],
      ['Enter', 'Enter', 'whoosh'],
      ['Backspace', 'Backspace', 'pop'],
      ['ArrowLeft', 'ArrowLeft', 'swoosh'],
    ];
    for (const [code, key, sound] of specials) {
      h.clock.t += 500;
      h.press(code, key);
      expect(h.audio.effectCount(sound)).toBeGreaterThan(0);
    }
    expect(h.scene.specials.map((s) => s.effect)).toEqual(['rainbow', 'sweep', 'pop-all', 'comet-left']);
    expect(h.audio.chords).toHaveLength(1); // the rainbow's rising scale
    expect(h.scene.glyphs).toHaveLength(0);
  });

  it('held keys sparkle and twinkle at most 8 times a second, with no glyph or speech', async () => {
    const h = setup();
    await h.begin();
    h.press('KeyF', 'f');
    const glyphs = h.scene.glyphs.length;
    const said = h.speaker.said.length;
    const bursts = h.scene.bursts.length;
    for (let i = 0; i < 50; i++) {
      h.clock.t += 20; // 50 auto-repeats over one second
      h.press('KeyF', 'f', true);
    }
    const twinkles = h.audio.effectCount('twinkle');
    expect(twinkles).toBeGreaterThanOrEqual(7);
    expect(twinkles).toBeLessThanOrEqual(8);
    expect(h.scene.bursts.length - bursts).toBe(twinkles);
    expect(h.scene.glyphs.length).toBe(glyphs);
    expect(h.speaker.said.length).toBe(said);
    // The sparkle sits on the key's spot.
    expect(h.scene.bursts.at(-1)).toMatchObject({ x: h.scene.glyphs[0].x, y: h.scene.glyphs[0].y });
  });

  it('a palm smash: fireworks + rising chord + a high-priority cheer; the smash keys do not speak', async () => {
    const h = setup({ speech: 'word' });
    await h.begin();
    h.speaker.said.length = 0;
    // The keyboard fires onKey for the first keys of a palm before it knows it's a smash.
    h.press('KeyA', 'a');
    h.clock.t += 20;
    h.press('KeyS', 's');
    h.clock.t += 20;
    h.press('KeyD', 'd');
    h.clock.t += 20;
    h.keyboard.handlers.onSmash({ codes: ['KeyA', 'KeyS', 'KeyD', 'KeyF'], center: { x: 0.3, y: 0.6 }, time: h.clock.t });

    const fireworks = h.scene.specials.find((s) => s.effect === 'fireworks');
    expect(fireworks?.at).toEqual({ x: W * (0.1 + 0.8 * 0.3), y: H * (0.1 + 0.8 * 0.6) });
    expect(h.audio.chords).toHaveLength(1);
    const chord = h.audio.chords[0];
    expect([...chord].sort((a, b) => a - b)).toEqual(chord); // rising
    // Only the first key spoke (low); S and D were part of the mash; the cheer cuts in.
    expect(h.speaker.said).toHaveLength(2);
    expect(h.speaker.said[0].text).toMatch(/^ay/);
    expect(h.speaker.said[1].priority).toBe('high');
    // Stragglers right after the smash stay quiet too.
    h.clock.t += 200;
    h.press('KeyG', 'g');
    expect(h.speaker.said).toHaveLength(2);
    expect(h.game.getStats().smashes).toBe(1);
  });

  it('cheers the child by name on Enter and every ~40 key presses', async () => {
    const h = setup({ childName: 'Sam' });
    await h.begin();
    h.speaker.said.length = 0;
    h.press('Enter', 'Enter');
    expect(h.speaker.texts).toEqual(['Yay, Sam!']);
    expect(h.speaker.said[0].priority).toBe('low');
    for (let i = 0; i < 46; i++) {
      h.clock.t += 400;
      h.press('KeyM', 'm');
    }
    expect(h.speaker.texts.filter((t) => t === 'Yay, Sam!')).toHaveLength(2);
  });

  it('counts stats with top keys by display label', async () => {
    const h = setup();
    await h.begin();
    for (const [code, key, n] of [['KeyA', 'a', 3], ['Digit1', '1', 2], ['Space', ' ', 1]] as const) {
      for (let i = 0; i < n; i++) {
        h.clock.t += 300;
        h.press(code, key);
      }
    }
    const stats = h.game.getStats();
    expect(stats.keys).toBe(6);
    expect(stats.topKeys).toEqual([['A', 3], ['1', 2], ['Space', 1]]);
    h.panel.deps.actions.resetStats();
    expect(h.game.getStats().keys).toBe(0);
  });
});

describe('Game: pointer', () => {
  it('a tap on an object pokes it and replays its sound and word', async () => {
    const h = setup({ speech: 'word' });
    await h.begin();
    h.press('KeyC', 'c');
    const word = h.speaker.texts.at(-1);
    const note = h.audio.notes[0].midi;
    h.scene.pokeResult = { kind: 'glyph', value: 'C', color: h.scene.glyphs[0].color };
    h.clock.t += 1000;
    h.pointer.handlers.onTap(500, 300, 1);
    expect(h.scene.shapes.length + h.scene.emoji.length).toBe(0); // nothing new spawned
    expect(h.audio.notes.at(-1)?.midi).toBe(note);
    expect(h.speaker.texts.at(-1)).toBe(word);
    expect(h.game.getStats().taps).toBe(1);
  });

  it('a tap on empty space spawns tap content with a ripple and a note by x position', async () => {
    const h = setup({ world: 'party' });
    await h.begin();
    h.pointer.handlers.onTap(50, 300, 1);
    h.pointer.handlers.onTap(950, 300, 2);
    expect(h.scene.shapes.length + h.scene.emoji.length).toBe(2);
    expect(h.scene.ripples).toHaveLength(2);
    const [left, right] = h.audio.notes.map((n) => n.midi);
    expect(right).toBeGreaterThan(left);
    expect(h.audio.notes[0].options?.pan).toBeLessThan(0);
  });

  it('drags paint a trail and play a note every ~90 px, higher on screen = higher note', async () => {
    const h = setup();
    await h.begin();
    h.pointer.handlers.onTap(100, 500, 3);
    const before = h.audio.notes.length;
    for (let i = 0; i < 6; i++) h.pointer.handlers.onDrag(100 + i * 30, 500, 30, 0, 3);
    expect(h.scene.trails.filter((t) => t.pointerId === 3)).toHaveLength(6);
    const low = h.audio.notes.slice(before);
    expect(low).toHaveLength(2);
    for (let i = 0; i < 3; i++) h.pointer.handlers.onDrag(300, 60, 0, 30, 3);
    const high = h.audio.notes.at(-1)!.midi;
    expect(high).toBeGreaterThan(low[0].midi);
    h.pointer.handlers.onRelease(300, 60, 3);
    expect(h.scene.endedTrails).toContain(3);
  });

  it('mouse hover draws a silent trail only when trails are on', async () => {
    const h = setup({ trails: true });
    await h.begin();
    h.pointer.handlers.onHover(10, 10, 5, 5);
    expect(h.scene.trails).toHaveLength(1);
    expect(h.audio.notes).toHaveLength(0);
    h.store.update({ trails: false });
    h.pointer.handlers.onHover(20, 20, 5, 5);
    expect(h.scene.trails).toHaveLength(1);
  });
});

describe('Game: grown-up access', () => {
  it('the secret word opens the panel and disables inputs; resume re-enables them', async () => {
    const h = setup();
    await h.begin();
    h.pointer.handlers.onTap(100, 100, 9); // an active pointer whose trail must be ended
    h.keyboard.handlers.onSecret();
    expect(h.panel.isOpen).toBe(true);
    expect(h.keyboard.enabled).toBe(false);
    expect(h.pointer.enabled).toBe(false);
    expect(h.speaker.cancels).toBeGreaterThan(0);
    expect(h.scene.endedTrails).toContain(9);

    // Nothing reaches play while the panel is open.
    h.press('KeyA', 'a');
    expect(h.scene.glyphs).toHaveLength(0);

    h.panel.deps.actions.resume();
    expect(h.panel.isOpen).toBe(false);
    expect(h.keyboard.enabled).toBe(true);
    expect(h.pointer.enabled).toBe(true);
    h.press('KeyA', 'a');
    expect(h.scene.glyphs).toHaveLength(1);
  });

  it('the corner hold opens the panel and its progress drives the ring', async () => {
    const h = setup();
    await h.begin();
    h.pointer.handlers.onCornerProgress?.(0.5);
    expect(h.overlays.corner.at(-1)).toBe(0.5);
    h.pointer.handlers.onCornerHold();
    expect(h.panel.isOpen).toBe(true);
  });

  it('the start screen can open the panel; resuming from it stays on the start screen', () => {
    const h = setup();
    h.start.deps.onOpenControls?.();
    expect(h.panel.isOpen).toBe(true);
    h.panel.deps.actions.resume();
    expect(h.game.playState).toBe('idle');
    expect(h.start.isVisible).toBe(true);
    expect(h.lockdown.enters).toHaveLength(0);
  });

  it('panel actions: test sound, relock, lock status, install', async () => {
    let prompts = 0;
    const h = setup({}, { install: { canInstall: () => true, prompt: () => void prompts++ } });
    await h.begin();
    h.panel.deps.actions.testSound();
    expect(h.audio.chords).toHaveLength(1);
    expect(h.speaker.said.at(-1)).toEqual({ text: 'Hello!', priority: 'high' });
    h.panel.deps.actions.relock();
    expect(h.lockdown.enters).toHaveLength(2);
    expect(h.panel.deps.getLockStatus().fullscreen).toBe(true);
    expect(h.panel.deps.canInstall()).toBe(true);
    h.panel.deps.actions.install();
    expect(prompts).toBe(1);
  });

  it('install is optional', () => {
    const h = setup();
    expect(h.panel.deps.canInstall()).toBe(false);
    expect(() => h.panel.deps.actions.install()).not.toThrow();
  });
});

describe('Game: session timer', () => {
  it('winds down for 45 s after sessionMinutes, then shows "All done!"; only a grown-up resumes', async () => {
    const h = setup({ sessionMinutes: 1 });
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

    // Keys do nothing now except the secret word.
    const glyphs = h.scene.glyphs.length;
    h.press('KeyA', 'a');
    h.keyboard.handlers.onSmash({ codes: ['KeyA', 'KeyS', 'KeyD', 'KeyF'], center: null, time: h.clock.t });
    h.pointer.handlers.onTap(500, 300, 1);
    expect(h.scene.glyphs.length).toBe(glyphs);
    expect(h.scene.specials).toHaveLength(0);
    expect(h.keyboard.enabled).toBe(true); // still listening for the secret word

    // Parent-gated resume: the timer restarts, calm 0, full volume.
    h.overlays.allDone?.();
    expect(h.game.playState).toBe('playing');
    expect(h.scene.lastCalm).toBe(0);
    expect(h.audio.lastFade[0]).toBe(1);
    expect(h.pointer.enabled).toBe(true);
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

  it('does not count time while the panel is open or the page is hidden', async () => {
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
  });

  it('never winds down with sessionMinutes 0', async () => {
    const h = setup({ sessionMinutes: 0 });
    await h.begin();
    h.run(10 * 60_000, 1_000);
    expect(h.game.playState).toBe('playing');
  });
});

describe('Game: idle attract and auto-rotate', () => {
  it('after 20 s without input a friend drifts by every ~4 s, silently, until input', async () => {
    const h = setup();
    await h.begin();
    h.run(19_000);
    expect(h.scene.emoji).toHaveLength(0);
    h.run(1_500);
    expect(h.scene.emoji).toHaveLength(1);
    expect(h.scene.emoji[0].scale).toBe(0.6);
    expect(WORLDS.space.friends).toContain(h.scene.emoji[0].emoji);
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

  it('auto-rotates to the next world every rotateMinutes of play', async () => {
    const h = setup({ autoRotate: true, rotateMinutes: 1, world: 'space' });
    await h.begin();
    h.run(61_000);
    expect(h.store.get().world).toBe('ocean');
    expect(h.scene.worlds.at(-1)?.id).toBe('ocean');
    expect(h.audio.timbre).toBe(WORLDS.ocean.timbre);
    expect(h.audio.root).toBe(WORLDS.ocean.rootMidi);
  });
});

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
});

describe('Game: live settings and page visibility', () => {
  it('applies settings at boot', () => {
    const h = setup({ world: 'night', volume: 0.4, muted: false, speech: 'off', voiceURI: 'v1', secretWord: 'mommy' });
    expect(h.audio.volume).toBe(0.4);
    expect(h.audio.timbre).toBe(WORLDS.night.timbre);
    expect(h.audio.root).toBe(WORLDS.night.rootMidi);
    expect(h.speaker.volume).toBe(0.4);
    expect(h.speaker.voice).toBe('v1');
    expect(h.speaker.enabled).toBe(false);
    expect(h.scene.worlds.at(-1)?.id).toBe('night');
    expect(h.keyboard.secretWords.at(-1)).toBe('mommy');
  });

  it('applies every change live', async () => {
    const h = setup();
    await h.begin();
    h.store.update({ world: 'garden' });
    expect(h.scene.worlds.at(-1)?.id).toBe('garden');
    expect(h.audio.timbre).toBe(WORLDS.garden.timbre);
    expect(h.audio.root).toBe(WORLDS.garden.rootMidi);

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

    h.store.update({ intensity: 'wild', size: 'huge', faces: false });
    expect(h.scene.lastOptions).toMatchObject({ intensity: 'wild', size: 'huge', faces: false });

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

  it('fades audio and cancels speech while the page is hidden', async () => {
    const h = setup();
    await h.begin();
    h.visibility.set(false);
    expect(h.audio.lastFade[0]).toBe(0);
    expect(h.speaker.cancels).toBeGreaterThan(0);
    h.visibility.set(true);
    expect(h.audio.lastFade[0]).toBe(1);
  });

  it('keys the melodic effects to the world root', () => {
    const h = setup({ world: 'dino' });
    expect(h.audio.root).toBe(WORLDS.dino.rootMidi);
    expect(pentatonic(WORLDS.dino.rootMidi, 5)).toBe(WORLDS.dino.rootMidi + 12);
  });
});
