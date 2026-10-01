import type { Settings, StartScreen, StartScreenDeps, WorldId } from '../types';

const TITLE = 'KeySplash';
/** Matches the CSS fade duration; after it the element gets `hidden`. */
const FADE_MS = 280;
/** Ignore a second start this soon after the first (mash while fullscreen is pending). */
const RESTART_GUARD_MS = 400;

/** Keys that never start play: bare modifiers, focus navigation and Escape. */
const IGNORED_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'Super', 'Hyper', 'Fn', 'FnLock',
  'CapsLock', 'NumLock', 'ScrollLock', 'Symbol', 'SymbolLock', 'Tab', 'Escape',
  'ContextMenu', 'PrintScreen', 'Power', 'Eject', 'WakeUp', 'Unidentified',
]);

/** Function, media and system keys belong to grown-ups (volume, brightness, devtools…). */
function isGrownUpKey(key: string): boolean {
  return IGNORED_KEYS.has(key) || /^F\d{1,2}$/.test(key) || /^(Audio|Media|Launch|Browser|Brightness)/.test(key);
}

const ARROW_STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

const PLAY_SVG =
  '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
  '<path d="M38 24.5c0-4.2 4.6-6.8 8.2-4.6l33 20.5c3.4 2.1 3.4 7.1 0 9.2l-33 20.5c-3.6 2.2-8.2-.4-8.2-4.6z" fill="currentColor"/>' +
  '</svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/**
 * The first screen: big bouncy title, a giant Play button, a quick world picker
 * and a footnote telling grown-ups how to get back to the controls.
 *
 * It is visible right after construction (calling show() again is harmless).
 * Any key except bare modifiers / Tab / Escape, a click on Play, or a click on
 * the empty backdrop calls `deps.onStart()` synchronously inside that event, so
 * the orchestrator can request fullscreen with the user activation.
 */
export class DomStartScreen implements StartScreen {
  private readonly el: HTMLElement;
  private readonly greeting: HTMLElement;
  private readonly play: HTMLButtonElement;
  private readonly picker: HTMLElement;
  private readonly worldButtons = new Map<WorldId, HTMLButtonElement>();
  private readonly worldName: HTMLElement;
  private readonly secretWordEl: HTMLElement;
  private readonly unsubscribe: () => void;

  private visible = false;
  private hideTimer = 0;
  private lastStart = -Infinity;

  constructor(
    root: HTMLElement,
    private readonly deps: StartScreenDeps,
  ) {
    this.el = el('section', 'ks-start');
    this.el.setAttribute('aria-label', 'KeySplash — start');
    this.el.hidden = true;

    const main = el('div', 'ks-start__main');

    this.greeting = el('p', 'ks-start__greeting');
    this.greeting.hidden = true;

    const title = el('h1', 'ks-title');
    title.setAttribute('aria-label', TITLE);
    [...TITLE].forEach((char, i) => {
      const letter = el('span', 'ks-title__letter', char);
      letter.setAttribute('aria-hidden', 'true');
      letter.style.setProperty('--i', String(i));
      title.append(letter);
    });

    const subtitle = el('p', 'ks-start__subtitle', 'Hand over the keyboard. Every key makes magic.');

    this.play = el('button', 'ks-play');
    this.play.type = 'button';
    this.play.setAttribute('aria-label', 'Play');
    this.play.innerHTML = PLAY_SVG;

    const hint = el('p', 'ks-start__hint', 'or press any key');

    this.picker = el('div', 'ks-worlds');
    this.picker.setAttribute('role', 'radiogroup');
    this.picker.setAttribute('aria-label', 'Choose a world');
    this.picker.dataset.noStart = '';
    for (const world of deps.worlds) {
      const button = el('button', 'ks-world');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', world.label);
      button.title = world.label;
      button.dataset.world = world.id;
      const icon = el('span', 'ks-world__icon', world.icon);
      icon.setAttribute('aria-hidden', 'true');
      button.append(icon);
      this.picker.append(button);
      this.worldButtons.set(world.id, button);
    }
    this.picker.addEventListener('click', this.onPickerClick);
    this.picker.addEventListener('keydown', this.onPickerKey);
    this.worldName = el('p', 'ks-start__world');
    this.worldName.dataset.noStart = '';
    this.worldName.setAttribute('aria-hidden', 'true'); // the radios already announce it

    main.append(this.greeting, title, subtitle, this.play, hint, this.picker, this.worldName);

    // Grown-up footnote.
    const foot = el('footer', 'ks-start__foot');
    foot.dataset.noStart = '';
    const how = el('p', 'ks-start__how');
    this.secretWordEl = el('b', 'ks-start__secret');
    how.append('Grown-ups: while playing, type ', this.secretWordEl, ' or hold the top-left corner to open the controls.');
    const tips = el('ul', 'ks-tips');
    tips.append(
      el('li', undefined, 'Install KeySplash as an app for the cleanest fullscreen.'),
      el('li', undefined, 'Chrome and Edge also lock Escape and most shortcuts while fullscreen.'),
      el('li', undefined, 'On a Mac, turn on Chrome ▸ “Warn Before Quitting”.'),
    );
    foot.append(how);
    if (deps.onOpenControls) {
      // A small, low-contrast link for grown-ups (inside the footnote, so it never starts play).
      const controls = el('button', 'ks-start__controls', '⚙️ Grown-up settings');
      controls.type = 'button';
      controls.addEventListener('click', () => deps.onOpenControls?.());
      foot.append(controls);
    }
    foot.append(tips);

    this.el.append(main, foot);
    this.el.addEventListener('click', this.onClick);
    root.append(this.el);

    this.render(deps.store.get());
    this.unsubscribe = deps.store.subscribe((next) => this.render(next));
    this.show();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    window.clearTimeout(this.hideTimer);
    this.el.hidden = false;
    void this.el.offsetWidth; // commit `display` so the fade-in transition runs
    this.el.classList.add('is-shown');
    window.addEventListener('keydown', this.onKeyDown);
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    window.removeEventListener('keydown', this.onKeyDown);
    this.el.classList.remove('is-shown');
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.el.hidden = true;
    }, FADE_MS);
  }

  /** Removes the element and every listener (tests / hot reload). */
  destroy(): void {
    this.hide();
    window.clearTimeout(this.hideTimer);
    this.unsubscribe();
    this.el.remove();
  }

  // ---------------------------------------------------------------------------

  private render(settings: Settings): void {
    const name = settings.childName.trim();
    this.greeting.hidden = name === '';
    this.greeting.textContent = name ? `Hi, ${name}!` : '';
    this.secretWordEl.textContent = settings.secretWord;
    this.worldName.textContent = this.deps.worlds.find((w) => w.id === settings.world)?.label ?? '';
    for (const [id, button] of this.worldButtons) {
      const selected = id === settings.world;
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.classList.toggle('is-selected', selected);
    }
    // Lets the CSS honour the parent's motion choice on top of the OS setting
    // (see the reduced-motion rules at the end of styles.css).
    document.documentElement.dataset.motion = settings.motion;
  }

  private start(): void {
    if (!this.visible) return;
    const now = performance.now();
    if (now - this.lastStart < RESTART_GUARD_MS) return;
    this.lastStart = now;
    this.deps.onStart();
  }

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (target instanceof Element && target.closest('[data-no-start]')) return;
    this.start();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || event.isComposing || isGrownUpKey(event.key)) return;
    // Shortcut chords (Cmd+R, Ctrl+Shift+I…) belong to the grown-up.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest('[data-allow-keys]')) return;
    if (isEditable(target)) return;
    if (target instanceof Element && this.el.contains(target)) {
      // Let a focused button (Play, a world) activate natively instead.
      if ((event.key === 'Enter' || event.key === ' ') && target.closest('button')) return;
      // Arrow keys move through the world picker.
      if (event.key in ARROW_STEP && this.picker.contains(target)) return;
    }
    event.preventDefault();
    this.start();
  };

  private readonly onPickerClick = (event: MouseEvent): void => {
    const target = event.target;
    const button = target instanceof Element ? target.closest<HTMLButtonElement>('.ks-world') : null;
    const id = button?.dataset.world as WorldId | undefined;
    if (id && id !== this.deps.store.get().world) this.deps.store.update({ world: id });
  };

  /** Roving radio-group navigation: arrows move and select. */
  private readonly onPickerKey = (event: KeyboardEvent): void => {
    const step = ARROW_STEP[event.key];
    if (!step) return;
    event.preventDefault();
    const ids = [...this.worldButtons.keys()];
    if (ids.length === 0) return;
    const current = ids.indexOf(this.deps.store.get().world);
    const next = ids[(Math.max(0, current) + step + ids.length) % ids.length];
    this.deps.store.update({ world: next });
    this.worldButtons.get(next)?.focus();
  };
}
