import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LockStatus,
  ParentPanelDeps,
  SessionStats,
  Settings,
  SettingsStore,
  Speaker,
  VoiceInfo,
  World,
  WorldId,
} from '../src/types';
import { DomStartScreen } from '../src/ui/start-screen';
import { DomParentPanel, formatDuration } from '../src/ui/parent-panel';
import { ALL_DONE_HOLD_MS, DomOverlays } from '../src/ui/overlays';
import { InstallPrompt } from '../src/ui/install';

// ---------------------------------------------------------------------------
// Test doubles (types only; no other modules needed)
// ---------------------------------------------------------------------------

const BASE_SETTINGS: Settings = {
  world: 'space',
  autoRotate: false,
  rotateMinutes: 5,
  volume: 0.7,
  muted: false,
  notes: true,
  speech: 'letter',
  voiceURI: null,
  letterCase: 'upper',
  pictures: true,
  size: 'normal',
  intensity: 'normal',
  motion: 'system',
  trails: true,
  faces: true,
  spatialKeys: true,
  childName: '',
  sessionMinutes: 0,
  secretWord: 'parent',
  lockKeyboard: true,
  confirmExit: true,
};

class MemoryStore implements SettingsStore {
  readonly updates: Array<Partial<Settings>> = [];
  private settings: Settings;
  private readonly listeners = new Set<(next: Settings, prev: Settings) => void>();

  constructor(initial: Partial<Settings> = {}) {
    this.settings = { ...BASE_SETTINGS, ...initial };
  }
  get(): Settings {
    return this.settings;
  }
  update(patch: Partial<Settings>): Settings {
    this.updates.push(patch);
    const prev = this.settings;
    this.settings = { ...prev, ...patch };
    for (const listener of this.listeners) listener(this.settings, prev);
    return this.settings;
  }
  reset(): Settings {
    return this.update({ ...BASE_SETTINGS });
  }
  subscribe(listener: (next: Settings, prev: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function world(id: WorldId, label: string, icon: string): World {
  return {
    id,
    label,
    icon,
    background: 'starfield',
    sky: ['#000', '#111'],
    dark: true,
    palette: [{ name: 'red', hex: '#ff0000' }],
    particle: 'spark',
    gravity: 0,
    energy: 1,
    timbre: 'bell',
    rootMidi: 60,
    friends: ['⭐'],
  };
}

const WORLDS: World[] = [world('space', 'Outer Space', '🚀'), world('ocean', 'Under the Sea', '🐠'), world('garden', 'Garden', '🌻')];

class FakeSpeaker implements Speaker {
  readonly supported = true;
  list: VoiceInfo[] = [{ uri: 'v1', name: 'Samantha', lang: 'en-US', local: true }];
  private readonly listeners = new Set<() => void>();
  setEnabled(): void {}
  setVolume(): void {}
  setVoice(): void {}
  voices(): VoiceInfo[] {
    return this.list;
  }
  onVoicesChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emitVoices(): void {
    for (const listener of this.listeners) listener();
  }
  say(): void {}
  cancel(): void {}
}

function key(type: 'keydown' | 'keyup', k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...init });
}

function pointer(type: string): PointerEvent {
  return new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' });
}

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement('div');
  root.id = 'ui';
  document.body.append(root);
});

afterEach(() => {
  vi.useRealTimers();
  root.remove();
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------
// Start screen
// ---------------------------------------------------------------------------

describe('DomStartScreen', () => {
  function setup(initial: Partial<Settings> = {}) {
    const store = new MemoryStore(initial);
    const onStart = vi.fn();
    const screen = new DomStartScreen(root, { store, worlds: WORLDS, onStart });
    const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel) as T;
    return { store, onStart, screen, q };
  }

  it('is visible after construction', () => {
    const { screen, q } = setup();
    expect(screen.isVisible).toBe(true);
    expect(q('.ks-start').hidden).toBe(false);
    screen.destroy();
  });

  it('calls onStart when Play is clicked', () => {
    const { onStart, screen, q } = setup();
    q<HTMLButtonElement>('.ks-play').click();
    expect(onStart).toHaveBeenCalledTimes(1);
    screen.destroy();
  });

  it('calls onStart synchronously on a letter keydown', () => {
    const { onStart, screen } = setup();
    const event = key('keydown', 'a', { code: 'KeyA' });
    window.dispatchEvent(event);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    screen.destroy();
  });

  it('ignores bare modifiers, Tab, Escape and shortcut chords', () => {
    const { onStart, screen } = setup();
    for (const k of ['Shift', 'Escape', 'Tab', 'Meta', 'Control', 'Alt', 'CapsLock']) {
      window.dispatchEvent(key('keydown', k));
    }
    window.dispatchEvent(key('keydown', 'r', { metaKey: true }));
    window.dispatchEvent(key('keydown', 'w', { ctrlKey: true }));
    expect(onStart).not.toHaveBeenCalled();
    screen.destroy();
  });

  it('ignores keys typed inside [data-allow-keys]', () => {
    const { onStart, screen } = setup();
    const box = document.createElement('div');
    box.setAttribute('data-allow-keys', '');
    const input = document.createElement('input');
    box.append(input);
    document.body.append(box);
    input.dispatchEvent(key('keydown', 'a'));
    expect(onStart).not.toHaveBeenCalled();
    screen.destroy();
  });

  it('world picker updates the store without starting', () => {
    const { store, onStart, screen, q } = setup();
    const ocean = q<HTMLButtonElement>('.ks-world[data-world="ocean"]');
    ocean.click();
    expect(onStart).not.toHaveBeenCalled();
    expect(store.get().world).toBe('ocean');
    expect(ocean.getAttribute('aria-checked')).toBe('true');
    expect(q('.ks-world[data-world="space"]').getAttribute('aria-checked')).toBe('false');
    expect(q('.ks-start__world').textContent).toBe('Under the Sea');
    screen.destroy();
  });

  it('arrow keys in the picker move the selection without starting', () => {
    const { store, onStart, screen, q } = setup();
    q<HTMLButtonElement>('.ks-world[data-world="space"]').dispatchEvent(key('keydown', 'ArrowRight'));
    expect(store.get().world).toBe('ocean');
    expect(onStart).not.toHaveBeenCalled();
    screen.destroy();
  });

  it('offers a grown-up settings link only when onOpenControls is given, without starting', () => {
    const { screen, q } = setup();
    expect(q('.ks-start__controls')).toBeNull();
    screen.destroy();
    const store = new MemoryStore();
    const onStart = vi.fn();
    const onOpenControls = vi.fn();
    const withLink = new DomStartScreen(root, { store, worlds: WORLDS, onStart, onOpenControls });
    q<HTMLButtonElement>('.ks-start__controls').click();
    expect(onOpenControls).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
    withLink.destroy();
  });

  it('clicks on the grown-up footnote do not start', () => {
    const { onStart, screen, q } = setup();
    q<HTMLElement>('.ks-start__how').click();
    expect(onStart).not.toHaveBeenCalled();
    screen.destroy();
  });

  it('updates the greeting and secret word live from the store', () => {
    const { store, screen, q } = setup();
    const greeting = q<HTMLElement>('.ks-start__greeting');
    expect(greeting.hidden).toBe(true);
    expect(q('.ks-start__secret').textContent).toBe('parent');
    store.update({ childName: 'Mia', secretWord: 'banana' });
    expect(greeting.hidden).toBe(false);
    expect(greeting.textContent).toBe('Hi, Mia!');
    expect(q('.ks-start__secret').textContent).toBe('banana');
    screen.destroy();
  });

  it('removes its key listener while hidden and re-adds it on show', () => {
    vi.useFakeTimers();
    const { onStart, screen, q } = setup();
    screen.hide();
    expect(screen.isVisible).toBe(false);
    window.dispatchEvent(key('keydown', 'a'));
    expect(onStart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(q('.ks-start').hidden).toBe(true);

    screen.show();
    expect(screen.isVisible).toBe(true);
    window.dispatchEvent(key('keydown', 'b'));
    expect(onStart).toHaveBeenCalledTimes(1);
    screen.destroy();
  });

  it('mirrors the motion setting onto <html data-motion>', () => {
    const { store, screen } = setup({ motion: 'reduce' });
    expect(document.documentElement.dataset.motion).toBe('reduce');
    store.update({ motion: 'full' });
    expect(document.documentElement.dataset.motion).toBe('full');
    screen.destroy();
  });
});

// ---------------------------------------------------------------------------
// Parent panel
// ---------------------------------------------------------------------------

describe('DomParentPanel', () => {
  function setup(opts: { canInstall?: boolean; stats?: Partial<SessionStats>; status?: Partial<LockStatus> } = {}) {
    const store = new MemoryStore();
    const speaker = new FakeSpeaker();
    const actions = {
      resume: vi.fn(),
      stop: vi.fn(),
      relock: vi.fn(),
      testSound: vi.fn(),
      resetStats: vi.fn(),
      install: vi.fn(),
    };
    let canInstall = opts.canInstall ?? false;
    const deps: ParentPanelDeps = {
      store,
      worlds: WORLDS,
      speaker,
      getStats: () => ({
        startedAt: 0,
        keys: 42,
        taps: 7,
        smashes: 3,
        topKeys: [
          ['A', 12],
          ['Space', 9],
        ],
        playMs: 125_000,
        ...opts.stats,
      }),
      getLockStatus: () => ({ fullscreen: true, keyboardLocked: false, wakeLock: true, installed: false, ...opts.status }),
      canInstall: () => canInstall,
      actions,
    };
    const panel = new DomParentPanel(root, deps);
    const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel) as T;
    const setCanInstall = (v: boolean) => {
      canInstall = v;
    };
    return { store, speaker, actions, panel, q, setCanInstall };
  }

  function change(input: HTMLInputElement | HTMLSelectElement, type: 'change' | 'input' = 'change'): void {
    input.dispatchEvent(new Event(type, { bubbles: true }));
  }

  it('opens as a labelled modal dialog that allows typing, and closes', () => {
    vi.useFakeTimers();
    const { panel, q } = setup();
    const rootEl = q<HTMLElement>('.ks-panel');
    expect(panel.isOpen).toBe(false);
    expect(rootEl.hidden).toBe(true);
    expect(rootEl.hasAttribute('data-allow-keys')).toBe(true);

    panel.open();
    expect(panel.isOpen).toBe(true);
    expect(rootEl.hidden).toBe(false);
    const dialog = q<HTMLElement>('[role="dialog"]');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe('Grown-up controls');
    expect(document.activeElement).toBe(dialog);

    panel.close();
    expect(panel.isOpen).toBe(false);
    vi.advanceTimersByTime(400);
    expect(rootEl.hidden).toBe(true);
    panel.destroy();
  });

  it('Escape closes the panel and resumes', () => {
    const { panel, actions } = setup();
    panel.open();
    window.dispatchEvent(key('keydown', 'Escape'));
    expect(panel.isOpen).toBe(false);
    expect(actions.resume).toHaveBeenCalledTimes(1);
    panel.destroy();
  });

  it('restores focus to the previously focused element on close', () => {
    const { panel } = setup();
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    panel.open();
    expect(document.activeElement).not.toBe(before);
    panel.close();
    expect(document.activeElement).toBe(before);
    panel.destroy();
  });

  it('Keep playing resumes and Stop stops', () => {
    const { panel, actions, q } = setup();
    panel.open();
    q<HTMLButtonElement>('[data-action="resume"]').click();
    expect(actions.resume).toHaveBeenCalledTimes(1);
    expect(panel.isOpen).toBe(false);

    panel.open();
    q<HTMLButtonElement>('[data-action="stop"]').click();
    expect(actions.stop).toHaveBeenCalledTimes(1);
    expect(panel.isOpen).toBe(false);
    panel.destroy();
  });

  it('switches patch their boolean setting', () => {
    const { panel, store, q } = setup();
    panel.open();
    const muted = q<HTMLInputElement>('input[data-setting="muted"]');
    expect(muted.getAttribute('role')).toBe('switch');
    expect(muted.checked).toBe(false);
    muted.checked = true;
    change(muted);
    expect(store.updates).toContainEqual({ muted: true });

    const spatial = q<HTMLInputElement>('input[data-setting="spatialKeys"]');
    spatial.checked = false;
    change(spatial);
    expect(store.updates).toContainEqual({ spatialKeys: false });
    panel.destroy();
  });

  it('pill groups, world cards, volume and timer patch the right fields', () => {
    const { panel, store, q } = setup();
    panel.open();

    const words = q<HTMLInputElement>('input[data-setting="speech"][value="word"]');
    words.checked = true;
    change(words);
    expect(store.updates).toContainEqual({ speech: 'word' });

    const lower = q<HTMLInputElement>('input[data-setting="letterCase"][value="lower"]');
    lower.checked = true;
    change(lower);
    expect(store.updates).toContainEqual({ letterCase: 'lower' });

    const ocean = q<HTMLInputElement>('input[data-setting="world"][value="ocean"]');
    ocean.checked = true;
    change(ocean);
    expect(store.updates).toContainEqual({ world: 'ocean' });

    const volume = q<HTMLInputElement>('input[data-setting="volume"]');
    volume.value = '40';
    change(volume, 'input');
    expect(store.updates).toContainEqual({ volume: 0.4 });

    const timer = q<HTMLSelectElement>('select[data-setting="sessionMinutes"]');
    timer.value = '15';
    change(timer);
    expect(store.updates).toContainEqual({ sessionMinutes: 15 });

    const minutes = q<HTMLInputElement>('input[data-setting="rotateMinutes"]');
    minutes.value = '99';
    change(minutes);
    expect(store.updates).toContainEqual({ rotateMinutes: 30 });
    panel.destroy();
  });

  it('typing a name updates the store live', () => {
    const { panel, store, q } = setup();
    panel.open();
    const name = q<HTMLInputElement>('input[data-setting="childName"]');
    name.value = 'Mia';
    change(name, 'input');
    expect(store.get().childName).toBe('Mia');
    panel.destroy();
  });

  it('does not save an invalid secret word and shows an inline error', () => {
    const { panel, store, q } = setup();
    panel.open();
    const input = q<HTMLInputElement>('input[data-setting="secretWord"]');
    const error = q<HTMLElement>('.ks-field__error');
    expect(input.value).toBe('parent');
    expect(error.hidden).toBe(true);

    for (const bad of ['abc', 'pa55word', 'two words', 'abcdefghijklmnopq']) {
      input.value = bad;
      change(input);
      expect(error.hidden).toBe(false);
      expect(input.getAttribute('aria-invalid')).toBe('true');
    }
    // Closing with an invalid word pending keeps the old one too.
    panel.close();
    expect(store.updates.some((u) => 'secretWord' in u)).toBe(false);
    expect(store.get().secretWord).toBe('parent');
    panel.destroy();
  });

  it('saves a valid secret word in lower case', () => {
    const { panel, store, q } = setup();
    panel.open();
    const input = q<HTMLInputElement>('input[data-setting="secretWord"]');
    input.value = 'Banana';
    change(input);
    expect(store.updates).toContainEqual({ secretWord: 'banana' });
    expect(q<HTMLElement>('.ks-field__error').hidden).toBe(true);
    panel.destroy();
  });

  it('open() refreshes controls, stats and status', () => {
    const { panel, store, q } = setup({ status: { keyboardLocked: true } });
    store.update({ volume: 0.2, muted: true, size: 'huge' });
    panel.open();
    expect(q<HTMLInputElement>('input[data-setting="volume"]').value).toBe('20');
    expect(q<HTMLInputElement>('input[data-setting="muted"]').checked).toBe(true);
    expect(q<HTMLInputElement>('input[data-setting="size"][value="huge"]').checked).toBe(true);
    expect(q('.ks-stat__value').textContent).toBe('42');
    expect(root.textContent).toContain('2 min');
    expect(root.querySelectorAll('.ks-topkey')).toHaveLength(2);
    expect(q<HTMLElement>('[data-status="keyboardLocked"]').dataset.on).toBe('true');
    expect(q<HTMLElement>('[data-status="installed"]').dataset.on).toBe('false');
    panel.destroy();
  });

  it('shows Install only when installable and wires the action buttons', () => {
    const { panel, actions, q, setCanInstall } = setup();
    panel.open();
    const install = q<HTMLButtonElement>('.ks-panel__install');
    expect(install.hidden).toBe(true);
    panel.close();

    setCanInstall(true);
    panel.open();
    expect(install.hidden).toBe(false);
    install.click();
    expect(actions.install).toHaveBeenCalledTimes(1);

    q<HTMLButtonElement>('[data-action="relock"]').click();
    expect(actions.relock).toHaveBeenCalledTimes(1);
    q<HTMLButtonElement>('[data-action="reset-stats"]').click();
    expect(actions.resetStats).toHaveBeenCalledTimes(1);
    panel.destroy();
  });

  it('lists voices and refreshes them when the speaker reports changes', () => {
    const { panel, speaker, store, q } = setup();
    panel.open();
    const select = q<HTMLSelectElement>('select[data-setting="voiceURI"]');
    expect([...select.options].map((o) => o.value)).toEqual(['', 'v1']);
    speaker.list = [...speaker.list, { uri: 'v2', name: 'Daniel', lang: 'en-GB', local: true }, { uri: 'v3', name: 'Google US English', lang: 'en-US', local: false }];
    speaker.emitVoices();
    expect([...select.options].map((o) => o.value)).toEqual(['', 'v1', 'v2', 'v3']);
    // Network voices are labelled so a parent knows they need a connection.
    expect(select.options[2].textContent).not.toContain('online');
    expect(select.options[3].textContent).toContain('online');
    select.value = 'v2';
    change(select);
    expect(store.updates).toContainEqual({ voiceURI: 'v2' });
    select.value = '';
    change(select);
    expect(store.updates).toContainEqual({ voiceURI: null });
    panel.destroy();
  });

  it('formats play time for grown-ups', () => {
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(12 * 60_000)).toBe('12 min');
    expect(formatDuration(65 * 60_000)).toBe('1 h 05 min');
  });
});

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

describe('DomOverlays', () => {
  it('All done only resumes after a full 3 s hold', () => {
    vi.useFakeTimers();
    const overlays = new DomOverlays(root);
    const onParentResume = vi.fn();
    overlays.showAllDone(onParentResume);
    const screen = root.querySelector<HTMLElement>('.ks-alldone') as HTMLElement;
    const hold = root.querySelector<HTMLButtonElement>('.ks-hold') as HTMLButtonElement;
    expect(screen.hidden).toBe(false);

    // A toddler tapping around does nothing.
    root.querySelector<HTMLElement>('.ks-alldone__card')?.click();
    screen.click();
    hold.click();
    expect(onParentResume).not.toHaveBeenCalled();

    // Releasing early cancels.
    hold.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(ALL_DONE_HOLD_MS - 500);
    hold.dispatchEvent(pointer('pointerup'));
    vi.advanceTimersByTime(ALL_DONE_HOLD_MS);
    expect(onParentResume).not.toHaveBeenCalled();

    // A full hold resumes exactly once.
    hold.dispatchEvent(pointer('pointerdown'));
    expect(hold.classList.contains('is-holding')).toBe(true);
    vi.advanceTimersByTime(ALL_DONE_HOLD_MS - 1);
    expect(onParentResume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onParentResume).toHaveBeenCalledTimes(1);
    expect(screen.classList.contains('is-shown')).toBe(false);
    vi.advanceTimersByTime(ALL_DONE_HOLD_MS * 2);
    expect(onParentResume).toHaveBeenCalledTimes(1);
    overlays.destroy();
  });

  it('All done hold also works with Space held on the button', () => {
    vi.useFakeTimers();
    const overlays = new DomOverlays(root);
    const onParentResume = vi.fn();
    overlays.showAllDone(onParentResume);
    const hold = root.querySelector<HTMLButtonElement>('.ks-hold') as HTMLButtonElement;
    hold.dispatchEvent(key('keydown', ' '));
    vi.advanceTimersByTime(1000);
    hold.dispatchEvent(key('keyup', ' '));
    vi.advanceTimersByTime(ALL_DONE_HOLD_MS);
    expect(onParentResume).not.toHaveBeenCalled();

    hold.dispatchEvent(key('keydown', ' '));
    vi.advanceTimersByTime(ALL_DONE_HOLD_MS);
    expect(onParentResume).toHaveBeenCalledTimes(1);
    overlays.destroy();
  });

  it('hideAllDone cancels a hold in progress', () => {
    vi.useFakeTimers();
    const overlays = new DomOverlays(root);
    const onParentResume = vi.fn();
    overlays.showAllDone(onParentResume);
    root.querySelector('.ks-hold')?.dispatchEvent(pointer('pointerdown'));
    overlays.hideAllDone();
    vi.advanceTimersByTime(ALL_DONE_HOLD_MS * 2);
    expect(onParentResume).not.toHaveBeenCalled();
    overlays.destroy();
  });

  it('resume calls back synchronously on click, then hides', () => {
    const overlays = new DomOverlays(root);
    const onResume = vi.fn();
    overlays.showResume(onResume);
    const screen = root.querySelector<HTMLElement>('.ks-resume') as HTMLElement;
    expect(screen.hidden).toBe(false);
    screen.click();
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(screen.classList.contains('is-shown')).toBe(false);
    screen.click();
    expect(onResume).toHaveBeenCalledTimes(1);
    overlays.destroy();
  });

  it('resume reacts to a key but never to Escape or modifiers', () => {
    const overlays = new DomOverlays(root);
    const onResume = vi.fn();
    overlays.showResume(onResume);
    window.dispatchEvent(key('keydown', 'Escape'));
    window.dispatchEvent(key('keydown', 'Shift'));
    window.dispatchEvent(key('keydown', 'q', { repeat: true }));
    expect(onResume).not.toHaveBeenCalled();
    window.dispatchEvent(key('keydown', 'j'));
    expect(onResume).toHaveBeenCalledTimes(1);
    window.dispatchEvent(key('keydown', 'k'));
    expect(onResume).toHaveBeenCalledTimes(1);
    overlays.destroy();
  });

  it('corner ring is hidden at 0 and fills with progress', () => {
    const overlays = new DomOverlays(root);
    const ring = root.querySelector<HTMLElement>('.ks-corner') as HTMLElement;
    const fill = root.querySelector<SVGCircleElement>('.ks-corner__fill') as SVGCircleElement;
    expect(ring.classList.contains('is-shown')).toBe(false);
    overlays.setCornerProgress(0.5);
    expect(ring.classList.contains('is-shown')).toBe(true);
    const circumference = 2 * Math.PI * 26;
    expect(Number(fill.style.strokeDashoffset)).toBeCloseTo(circumference / 2, 1);
    overlays.setCornerProgress(1);
    expect(ring.classList.contains('is-full')).toBe(true);
    overlays.setCornerProgress(0);
    expect(ring.classList.contains('is-shown')).toBe(false);
    overlays.destroy();
  });

  it('toast shows the newest message politely and auto-hides', () => {
    vi.useFakeTimers();
    const overlays = new DomOverlays(root);
    const toast = root.querySelector<HTMLElement>('.ks-toast') as HTMLElement;
    expect(toast.getAttribute('aria-live')).toBe('polite');
    overlays.toast('Keyboard locked 🔒');
    vi.advanceTimersByTime(2000);
    overlays.toast('Fullscreen on');
    expect(toast.textContent).toBe('Fullscreen on');
    vi.advanceTimersByTime(2000);
    expect(toast.classList.contains('is-shown')).toBe(true);
    vi.advanceTimersByTime(700);
    expect(toast.classList.contains('is-shown')).toBe(false);
    overlays.destroy();
  });
});

// ---------------------------------------------------------------------------
// Install prompt
// ---------------------------------------------------------------------------

describe('InstallPrompt', () => {
  it('stashes beforeinstallprompt and replays it once', async () => {
    const install = new InstallPrompt();
    const onChange = vi.fn();
    install.onChange(onChange);
    expect(install.canInstall()).toBe(false);

    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: string }>;
    };
    event.prompt = vi.fn(() => Promise.resolve());
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(install.canInstall()).toBe(true);
    expect(onChange).toHaveBeenCalled();
    await expect(install.prompt()).resolves.toBe(true);
    expect(install.canInstall()).toBe(false);
    await expect(install.prompt()).resolves.toBe(false);
    install.destroy();
  });

  it('appinstalled turns installability off', () => {
    const install = new InstallPrompt();
    const event = new Event('beforeinstallprompt', { cancelable: true });
    window.dispatchEvent(event);
    expect(install.canInstall()).toBe(true);
    window.dispatchEvent(new Event('appinstalled'));
    expect(install.canInstall()).toBe(false);
    install.destroy();
  });
});
