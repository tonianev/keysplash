import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LearningProgress,
  LockStatus,
  ParentPanelDeps,
  ProgressStore,
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
  mode: 'explore',
  layout: 'focus',
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
    background: 'space',
    sky: ['#000', '#111'],
    dark: true,
    surface: '#222',
    onSurface: '#eee',
    palette: [{ name: 'red', hex: '#c44', container: '#411', ink: '#fcc' }],
    particle: 'stars',
    gravity: 0,
    energy: 1,
    timbre: 'celesta',
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
  sequence(): void {}
  readonly sequencing = false;
  cancel(): void {}
}

class MemoryProgress implements ProgressStore {
  private data: LearningProgress = { seen: {}, found: {}, spelled: {}, since: null };
  private readonly listeners = new Set<(p: LearningProgress) => void>();
  resets = 0;
  get(): LearningProgress {
    return this.data;
  }
  private bump(field: 'seen' | 'found' | 'spelled', key: string): void {
    const bucket = { ...this.data[field], [key]: (this.data[field][key] ?? 0) + 1 };
    this.data = { ...this.data, [field]: bucket, since: this.data.since ?? Date.UTC(2026, 0, 15) };
    this.emit();
  }
  markSeen(symbol: string): void {
    this.bump('seen', symbol);
  }
  markFound(symbol: string): void {
    this.bump('found', symbol);
  }
  markSpelled(word: string): void {
    this.bump('spelled', word);
  }
  reset(): void {
    this.resets++;
    this.data = { seen: {}, found: {}, spelled: {}, since: null };
    this.emit();
  }
  subscribe(listener: (p: LearningProgress) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
  private emit(): void {
    for (const listener of this.listeners) listener(this.data);
  }
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

  it('renders the four activity cards with aria-checked from the store', () => {
    const { screen, q } = setup({ mode: 'spell' });
    const group = q<HTMLElement>('.ks-modes');
    expect(group.getAttribute('role')).toBe('radiogroup');
    const cards = [...root.querySelectorAll<HTMLButtonElement>('.ks-mode')];
    expect(cards.map((c) => c.dataset.mode)).toEqual(['explore', 'find-letters', 'find-numbers', 'spell']);
    for (const card of cards) {
      expect(card.getAttribute('role')).toBe('radio');
      expect(card.getAttribute('aria-checked')).toBe(String(card.dataset.mode === 'spell'));
      expect(card.classList.contains('is-selected')).toBe(card.dataset.mode === 'spell');
    }
    screen.destroy();
  });

  it('clicking a mode card updates the store without starting play', () => {
    const { store, onStart, screen, q } = setup();
    const card = q<HTMLButtonElement>('.ks-mode[data-mode="find-numbers"]');
    card.click();
    expect(onStart).not.toHaveBeenCalled();
    expect(store.updates).toEqual([{ mode: 'find-numbers' }]);
    expect(card.getAttribute('aria-checked')).toBe('true');
    expect(q('.ks-mode[data-mode="explore"]').getAttribute('aria-checked')).toBe('false');
    // Re-clicking the selected card writes nothing.
    card.click();
    expect(store.updates).toHaveLength(1);
    // A click on a child element of a card (the icon) still selects, and still does not start.
    q<HTMLElement>('.ks-mode[data-mode="spell"] .ks-mode__icon').click();
    expect(store.get().mode).toBe('spell');
    expect(onStart).not.toHaveBeenCalled();
    screen.destroy();
  });

  it('mode cards follow external store changes', () => {
    const { store, screen, q } = setup();
    store.update({ mode: 'find-letters' });
    expect(q('.ks-mode[data-mode="find-letters"]').getAttribute('aria-checked')).toBe('true');
    expect(q('.ks-mode[data-mode="explore"]').getAttribute('aria-checked')).toBe('false');
    screen.destroy();
  });

  it('renders one world swatch per world with roving tabindex', () => {
    const { screen } = setup({ world: 'ocean' });
    const swatches = [...root.querySelectorAll<HTMLButtonElement>('.ks-world')];
    expect(swatches.map((b) => b.dataset.world)).toEqual(['space', 'ocean', 'garden']);
    expect(swatches.map((b) => b.getAttribute('aria-label'))).toEqual(['Outer Space', 'Under the Sea', 'Garden']);
    expect(swatches.map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
    screen.destroy();
  });

  it('a click on the empty backdrop starts, a click inside [data-no-start] does not', () => {
    const { onStart, screen, q } = setup();
    q<HTMLElement>('.ks-modes').click();
    q<HTMLElement>('.ks-worlds').click();
    q<HTMLElement>('.ks-start__foot').click();
    expect(onStart).not.toHaveBeenCalled();
    q<HTMLElement>('.ks-start__subtitle').click();
    expect(onStart).toHaveBeenCalledTimes(1);
    screen.destroy();
  });

  it('ignores function/media keys, auto-repeat and Alt chords; digits and Space start', () => {
    vi.useFakeTimers();
    const { onStart, screen } = setup();
    for (const k of ['F5', 'F12', 'AudioVolumeUp', 'MediaPlayPause', 'BrightnessUp']) window.dispatchEvent(key('keydown', k));
    window.dispatchEvent(key('keydown', 'a', { repeat: true }));
    window.dispatchEvent(key('keydown', 'a', { altKey: true }));
    expect(onStart).not.toHaveBeenCalled();
    window.dispatchEvent(key('keydown', '7', { code: 'Digit7' }));
    expect(onStart).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    window.dispatchEvent(key('keydown', ' ', { code: 'Space' }));
    expect(onStart).toHaveBeenCalledTimes(2);
    screen.destroy();
  });

  it('a burst of keys starts play only once (restart guard)', () => {
    const { onStart, screen } = setup();
    for (const k of 'asdfgh') window.dispatchEvent(key('keydown', k));
    expect(onStart).toHaveBeenCalledTimes(1);
    screen.destroy();
  });

  it('Enter on a focused mode card selects natively and does not start', () => {
    const { onStart, screen, q } = setup();
    const card = q<HTMLButtonElement>('.ks-mode[data-mode="spell"]');
    card.focus();
    const event = key('keydown', 'Enter');
    card.dispatchEvent(event);
    expect(onStart).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    screen.destroy();
  });

  it('destroy() unsubscribes from the store and removes the element', () => {
    const { store, onStart, screen } = setup();
    screen.destroy();
    expect(root.querySelector('.ks-start')).toBeNull();
    expect(() => store.update({ childName: 'Zed' })).not.toThrow();
    window.dispatchEvent(key('keydown', 'a'));
    expect(onStart).not.toHaveBeenCalled();
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
    const progress = new MemoryProgress();
    const actions = {
      resume: vi.fn(),
      stop: vi.fn(),
      relock: vi.fn(),
      testSound: vi.fn(),
      resetStats: vi.fn(),
      resetProgress: vi.fn(() => progress.reset()),
      install: vi.fn(),
    };
    let canInstall = opts.canInstall ?? false;
    const deps: ParentPanelDeps = {
      store,
      progress,
      worlds: WORLDS,
      speaker,
      getStats: () => ({
        startedAt: 0,
        keys: 42,
        taps: 7,
        smashes: 3,
        found: 5,
        spelled: 2,
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
    return { store, speaker, progress, actions, panel, q, setCanInstall };
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

    // v2 dropped the spatialKeys setting: no control may write it.
    expect(root.querySelector('[data-setting="spatialKeys"]')).toBeNull();
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

  it('Learning section radios write mode, layout, speech and letterCase patches', () => {
    const { panel, store, q } = setup();
    panel.open();
    const learning = [...root.querySelectorAll<HTMLElement>('.ks-sec')].find((s) => s.textContent?.includes('Learning')) as HTMLElement;
    expect(learning).toBeDefined();
    expect(learning.querySelector('[data-setting="mode"]')).not.toBeNull();
    const modes = [...learning.querySelectorAll<HTMLInputElement>('input[data-setting="mode"]')].map((i) => i.value);
    expect(modes).toEqual(['explore', 'find-letters', 'find-numbers', 'spell']);
    expect(q<HTMLInputElement>('input[data-setting="mode"][value="explore"]').checked).toBe(true);

    const cases: Array<[string, string]> = [
      ['mode', 'spell'],
      ['layout', 'keyboard'],
      ['speech', 'off'],
      ['letterCase', 'both'],
      ['intensity', 'lively'],
    ];
    for (const [setting, value] of cases) {
      const input = q<HTMLInputElement>(`input[data-setting="${setting}"][value="${value}"]`);
      input.checked = true;
      change(input);
      expect(store.updates).toContainEqual({ [setting]: value });
    }
    expect(store.get()).toMatchObject({ mode: 'spell', layout: 'keyboard', speech: 'off', letterCase: 'both', intensity: 'lively' });
    panel.destroy();
  });

  it('an unchecked radio change event writes nothing', () => {
    const { panel, store, q } = setup();
    panel.open();
    const input = q<HTMLInputElement>('input[data-setting="layout"][value="keyboard"]');
    input.checked = false;
    change(input);
    expect(store.updates).toEqual([]);
    panel.destroy();
  });

  it('radios reflect external store changes while open', () => {
    const { panel, store, q } = setup();
    panel.open();
    store.update({ mode: 'find-letters', layout: 'keyboard' });
    expect(q<HTMLInputElement>('input[data-setting="mode"][value="find-letters"]').checked).toBe(true);
    expect(q<HTMLInputElement>('input[data-setting="mode"][value="explore"]').checked).toBe(false);
    expect(q<HTMLInputElement>('input[data-setting="layout"][value="keyboard"]').checked).toBe(true);
    panel.destroy();
  });

  it('progress grid shows none/seen/found per symbol from the store on open', () => {
    const { panel, progress, q } = setup();
    progress.markSeen('A');
    progress.markSeen('B');
    progress.markFound('B');
    progress.markSeen('7');
    panel.open();
    const cells = [...root.querySelectorAll<HTMLElement>('.ks-progress__cell')];
    expect(cells).toHaveLength(36);
    expect(cells.map((c) => c.dataset.symbol).join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(q<HTMLElement>('[data-symbol="A"]').dataset.state).toBe('seen');
    expect(q<HTMLElement>('[data-symbol="B"]').dataset.state).toBe('found');
    expect(q<HTMLElement>('[data-symbol="7"]').dataset.state).toBe('seen');
    expect(q<HTMLElement>('[data-symbol="C"]').dataset.state).toBe('none');
    expect(q<HTMLElement>('[data-symbol="B"]').getAttribute('aria-label')).toContain('found 1');
    panel.destroy();
  });

  it('progress grid live-updates via progress.subscribe while open, not while closed', () => {
    const { panel, progress, q } = setup();
    panel.open();
    const z = q<HTMLElement>('[data-symbol="Z"]');
    expect(z.dataset.state).toBe('none');
    progress.markSeen('Z');
    expect(z.dataset.state).toBe('seen');
    progress.markFound('Z');
    expect(z.dataset.state).toBe('found');

    panel.close();
    progress.markSeen('Q');
    expect(q<HTMLElement>('[data-symbol="Q"]').dataset.state).toBe('none');
    panel.open(); // re-reads on open
    expect(q<HTMLElement>('[data-symbol="Q"]').dataset.state).toBe('seen');
    panel.destroy();
  });

  it('lists spelled words as chips, most spelled first', () => {
    const { panel, progress } = setup();
    panel.open();
    const words = () => [...root.querySelectorAll('.ks-progress ~ .ks-topkeys .ks-topkey__key')].map((n) => n.textContent);
    expect(root.textContent).toContain('None yet');
    progress.markSpelled('cat');
    progress.markSpelled('dog');
    progress.markSpelled('dog');
    expect(words()).toEqual(['dog', 'cat']);
    expect(root.textContent).toContain('Since');
    panel.destroy();
  });

  it('Reset progress needs the inline confirm before calling resetProgress', () => {
    const { panel, progress, actions, q } = setup();
    progress.markFound('A');
    panel.open();
    const confirm = q<HTMLElement>('.ks-confirm');
    expect(confirm.hidden).toBe(true);
    q<HTMLButtonElement>('[data-action="reset-progress"]').click();
    expect(actions.resetProgress).not.toHaveBeenCalled();
    expect(confirm.hidden).toBe(false);

    // Cancel hides it again without resetting.
    [...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')?.click();
    expect(confirm.hidden).toBe(true);
    expect(actions.resetProgress).not.toHaveBeenCalled();

    q<HTMLButtonElement>('[data-action="reset-progress"]').click();
    q<HTMLButtonElement>('[data-action="reset-progress-confirm"]').click();
    expect(actions.resetProgress).toHaveBeenCalledTimes(1);
    expect(confirm.hidden).toBe(true);
    expect(q<HTMLElement>('[data-symbol="A"]').dataset.state).toBe('none');
    panel.destroy();
  });

  it('a pending reset confirm is dismissed when the panel is reopened', () => {
    const { panel, q } = setup();
    panel.open();
    q<HTMLButtonElement>('[data-action="reset-progress"]').click();
    panel.close();
    panel.open();
    expect(q<HTMLElement>('.ks-confirm').hidden).toBe(true);
    panel.destroy();
  });

  it('session stats show found and words spelled', () => {
    const { panel } = setup({ stats: { found: 11, spelled: 4 } });
    panel.open();
    const tiles = new Map(
      [...root.querySelectorAll('.ks-stat')].map((t) => [t.querySelector('dt')?.textContent, t.querySelector('dd')?.textContent]),
    );
    expect(tiles.get('Found')).toBe('11');
    expect(tiles.get('Words spelled')).toBe('4');
    expect(tiles.get('Keys')).toBe('42');
    panel.destroy();
  });

  it('secret word: trims, rejects impossible input while typing, and saves on Enter', () => {
    const { panel, store, q } = setup();
    panel.open();
    const input = q<HTMLInputElement>('input[data-setting="secretWord"]');
    const error = q<HTMLElement>('.ks-field__error');
    input.value = 'ab1';
    change(input, 'input');
    expect(error.hidden).toBe(false);
    input.value = 'abc';
    change(input, 'input'); // too short is only flagged on commit
    expect(error.hidden).toBe(true);
    input.value = '  Mango  ';
    input.dispatchEvent(key('keydown', 'Enter'));
    expect(store.get().secretWord).toBe('mango');
    expect(input.value).toBe('mango');
    expect(q('.ks-field__saved').textContent).toContain('Saved');
    panel.destroy();
  });

  it('a valid but uncommitted secret word is saved when the panel closes', () => {
    const { panel, store, q } = setup();
    panel.open();
    const input = q<HTMLInputElement>('input[data-setting="secretWord"]');
    input.value = 'grownup';
    panel.close();
    expect(store.get().secretWord).toBe('grownup');
    panel.destroy();
  });

  it('Escape is swallowed by the panel (stopPropagation) and does nothing once closed', () => {
    const { panel, actions } = setup();
    panel.open();
    const bubbled = vi.fn();
    window.addEventListener('keydown', bubbled);
    const event = key('keydown', 'Escape');
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    window.removeEventListener('keydown', bubbled);
    window.dispatchEvent(key('keydown', 'Escape'));
    expect(actions.resume).toHaveBeenCalledTimes(1);
    panel.destroy();
  });

  it('traps Tab focus inside the dialog', () => {
    const { panel, q } = setup();
    panel.open();
    const dialog = q<HTMLElement>('[role="dialog"]');
    const close = q<HTMLButtonElement>('.ks-iconbtn');
    const keep = q<HTMLButtonElement>('[data-action="resume"]');
    // From the dialog itself, Tab goes to the first control, Shift+Tab to the last.
    const tab = key('keydown', 'Tab');
    window.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    keep.focus();
    window.dispatchEvent(key('keydown', 'Tab'));
    expect(document.activeElement).toBe(close);
    window.dispatchEvent(key('keydown', 'Tab', { shiftKey: true }));
    expect(document.activeElement).toBe(keep);
    expect(dialog.contains(document.activeElement)).toBe(true);
    panel.destroy();
  });

  it('focus moving outside the panel is pulled back to the dialog', () => {
    const { panel, q } = setup();
    const outside = document.createElement('button');
    document.body.append(outside);
    panel.open();
    outside.focus();
    expect(document.activeElement).toBe(q('[role="dialog"]'));
    panel.destroy();
  });

  it('close() blurs a focused input so toddler keys cannot type into it', () => {
    const { panel, q } = setup();
    panel.open();
    const name = q<HTMLInputElement>('input[data-setting="childName"]');
    name.focus();
    expect(document.activeElement).toBe(name);
    panel.close();
    expect(document.activeElement).not.toBe(name);
    expect(q<HTMLElement>('.ks-panel').inert).toBe(true);
    panel.destroy();
  });

  it('destroy() drops store, speaker and progress subscriptions', () => {
    const { panel, progress } = setup();
    expect(progress.listenerCount).toBe(1);
    panel.open();
    panel.open(); // idempotent: no extra subscriptions
    expect(progress.listenerCount).toBe(1);
    panel.destroy();
    expect(progress.listenerCount).toBe(0);
    expect(root.querySelector('.ks-panel')).toBeNull();
    expect(() => progress.markSeen('A')).not.toThrow();
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

  it('the hold button is a grown-up control: data-allow-keys, and a pointer leave cancels', () => {
    vi.useFakeTimers();
    const overlays = new DomOverlays(root);
    const onParentResume = vi.fn();
    overlays.showAllDone(onParentResume);
    const hold = root.querySelector<HTMLButtonElement>('.ks-hold') as HTMLButtonElement;
    expect(hold.hasAttribute('data-allow-keys')).toBe(true);
    hold.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(ALL_DONE_HOLD_MS - 100);
    hold.dispatchEvent(pointer('pointerleave'));
    expect(hold.classList.contains('is-holding')).toBe(false);
    vi.advanceTimersByTime(ALL_DONE_HOLD_MS);
    expect(onParentResume).not.toHaveBeenCalled();
    // Key auto-repeat does not restart or extend the timer.
    hold.dispatchEvent(key('keydown', 'Enter'));
    vi.advanceTimersByTime(ALL_DONE_HOLD_MS / 2);
    hold.dispatchEvent(key('keydown', 'Enter', { repeat: true }));
    vi.advanceTimersByTime(ALL_DONE_HOLD_MS / 2);
    expect(onParentResume).toHaveBeenCalledTimes(1);
    overlays.destroy();
  });

  it('holding after the All done screen was hidden does nothing', () => {
    vi.useFakeTimers();
    const overlays = new DomOverlays(root);
    const onParentResume = vi.fn();
    overlays.showAllDone(onParentResume);
    overlays.hideAllDone();
    const hold = root.querySelector<HTMLButtonElement>('.ks-hold') as HTMLButtonElement;
    hold.dispatchEvent(pointer('pointerdown'));
    expect(hold.classList.contains('is-holding')).toBe(false);
    vi.advanceTimersByTime(ALL_DONE_HOLD_MS * 2);
    expect(onParentResume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(root.querySelector<HTMLElement>('.ks-alldone')?.hidden).toBe(true);
    overlays.destroy();
  });

  it('resume ignores keys inside [data-allow-keys] and stops listening after hideResume', () => {
    const overlays = new DomOverlays(root);
    const onResume = vi.fn();
    overlays.showResume(onResume);
    const box = document.createElement('div');
    box.setAttribute('data-allow-keys', '');
    document.body.append(box);
    box.dispatchEvent(key('keydown', 'a'));
    window.dispatchEvent(key('keydown', 'a', { metaKey: true }));
    expect(onResume).not.toHaveBeenCalled();
    overlays.hideResume();
    window.dispatchEvent(key('keydown', 'a'));
    expect(onResume).not.toHaveBeenCalled();
    // Showing again with a new callback uses the new one.
    const next = vi.fn();
    overlays.showResume(onResume);
    overlays.showResume(next);
    window.dispatchEvent(key('keydown', 'a'));
    expect(onResume).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    overlays.destroy();
  });

  it('corner ring clamps out-of-range and non-finite progress', () => {
    const overlays = new DomOverlays(root);
    const ring = root.querySelector<HTMLElement>('.ks-corner') as HTMLElement;
    const fill = root.querySelector<SVGCircleElement>('.ks-corner__fill') as SVGCircleElement;
    overlays.setCornerProgress(5);
    expect(ring.classList.contains('is-full')).toBe(true);
    expect(Number(fill.style.strokeDashoffset)).toBe(0);
    overlays.setCornerProgress(Number.NaN);
    expect(ring.classList.contains('is-shown')).toBe(false);
    overlays.setCornerProgress(-1);
    expect(ring.classList.contains('is-shown')).toBe(false);
    overlays.setCornerProgress(0.25);
    expect(ring.classList.contains('is-full')).toBe(false);
    expect(Number(fill.style.strokeDashoffset)).toBeCloseTo(2 * Math.PI * 26 * 0.75, 1);
    overlays.destroy();
  });

  it('destroy() removes every element and the resume key listener', () => {
    const overlays = new DomOverlays(root);
    const onResume = vi.fn();
    overlays.showResume(onResume);
    overlays.destroy();
    expect(root.children).toHaveLength(0);
    window.dispatchEvent(key('keydown', 'a'));
    expect(onResume).not.toHaveBeenCalled();
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
