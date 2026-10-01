import type { LearningProgress, LockStatus, ParentPanel, ParentPanelDeps, Settings } from '../types';

/** Settings keys whose value is a boolean (rendered as switches). */
type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
/** Settings keys rendered as pill groups. */
type ChoiceKey = 'mode' | 'layout' | 'voiceStyle' | 'speech' | 'letterCase' | 'size' | 'intensity' | 'motion';
type Choices<K extends ChoiceKey> = ReadonlyArray<readonly [Settings[K], string]>;

const SECRET_WORD = /^[a-z]{4,16}$/;
const SESSION_MINUTES = [0, 5, 10, 15, 20, 30, 45, 60];
/** Lock status and installability are polled while the panel is open. */
const LIVE_REFRESH_MS = 1000;
/** Matches the CSS fade duration; after it the element gets `hidden`. */
const FADE_MS = 280;
const SAVED_HINT_MS = 1800;

const STYLE_DESC: Record<Settings['voiceStyle'], string> = {
  natural: 'Natural is built in: it works offline and sounds the same everywhere.',
  device: 'This device uses your computer’s own voices, and can say your child’s name.',
};

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const LOGO_SVG =
  '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
  '<rect x="4" y="4" width="56" height="56" rx="16" fill="#4A86D8"/>' +
  '<rect x="13" y="12" width="38" height="38" rx="10" fill="#FBF7F0"/>' +
  '<path d="M26 21v20M38 21 28.5 30.5M31 28.5l8 12.5" fill="none" stroke="#E0604F" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

const STATUS_ITEMS: ReadonlyArray<readonly [keyof LockStatus, string, string | null]> = [
  ['fullscreen', 'Fullscreen', null],
  ['keyboardLocked', 'Keyboard lock', 'Chrome/Edge only'],
  ['wakeLock', 'Screen awake', null],
  ['installed', 'Installed app', null],
];

let instances = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function srOnly(text: string): HTMLSpanElement {
  return el('span', 'ks-sr', text);
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/**
 * Grown-up controls: a modal dialog that edits settings live (every change goes
 * straight to `store.update`, no Save button), shows lock status and session
 * stats, and offers resume / stop / install.
 *
 * The root carries `data-allow-keys` so the toddler keyboard input ignores
 * typing inside it. Escape, "Keep playing" and the close button close the
 * panel and call `actions.resume()`; "Stop" closes it and calls `actions.stop()`.
 */
export class DomParentPanel implements ParentPanel {
  private readonly el: HTMLElement;
  private readonly dialog: HTMLElement;
  private readonly body: HTMLElement;
  private readonly prefix: string;
  private readonly refreshers: Array<(settings: Settings) => void> = [];
  private readonly unsubscribers: Array<() => void> = [];

  private voiceSelect!: HTMLSelectElement;
  private secretInput!: HTMLInputElement;
  private secretError!: HTMLElement;
  private secretSaved!: HTMLElement;
  private readonly statusChips = new Map<keyof LockStatus, HTMLElement>();
  private statKeys!: HTMLElement;
  private statTaps!: HTMLElement;
  private statSmashes!: HTMLElement;
  private statFound!: HTMLElement;
  private statSpelled!: HTMLElement;
  private progressGrid!: HTMLElement;
  private progressWords!: HTMLElement;
  private progressSince!: HTMLElement;
  private progressConfirm!: HTMLElement;
  private statTime!: HTMLElement;
  private topKeys!: HTMLElement;
  private installButton!: HTMLButtonElement;

  private opened = false;
  private restoreFocus: HTMLElement | null = null;
  private liveTimer = 0;
  private hideTimer = 0;
  private savedTimer = 0;

  constructor(
    root: HTMLElement,
    private readonly deps: ParentPanelDeps,
  ) {
    this.prefix = `ks-pp${++instances}`;

    this.el = el('div', 'ks-panel');
    this.el.setAttribute('data-allow-keys', '');
    this.el.hidden = true;
    this.el.inert = true;

    this.dialog = el('div', 'ks-panel__card');
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.setAttribute('aria-labelledby', this.id('title'));
    this.dialog.tabIndex = -1;

    this.body = el('div', 'ks-panel__body');
    this.body.append(
      this.buildVoiceSection(),
      this.buildLearningSection(),
      this.buildWorldSection(),
      this.buildSoundSection(),
      this.buildLookSection(),
      this.buildChildSection(),
      this.buildProgressSection(),
      this.buildSafetySection(),
      this.buildSessionSection(),
    );

    this.dialog.append(this.buildHeader(), this.body, this.buildFooter());
    this.el.append(this.dialog);
    root.append(this.el);

    this.unsubscribers.push(
      deps.store.subscribe((next) => {
        if (this.opened) this.refreshSettings(next);
      }),
      deps.speaker.onVoicesChanged(() => this.renderVoices(this.deps.store.get())),
      deps.progress.subscribe((progress) => {
        if (this.opened) this.renderProgress(progress);
      }),
    );
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(): void {
    if (this.opened) {
      this.refreshAll();
      return;
    }
    this.opened = true;
    const active = document.activeElement;
    this.restoreFocus = active instanceof HTMLElement && active !== document.body && !this.el.contains(active) ? active : null;

    this.refreshAll();
    window.clearTimeout(this.hideTimer);
    this.el.inert = false;
    this.el.hidden = false;
    void this.el.offsetWidth; // commit `display` so the fade-in transition runs
    this.el.classList.add('is-shown');
    this.body.scrollTop = 0;

    window.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('focusin', this.onFocusIn);
    this.liveTimer = window.setInterval(this.refreshLive, LIVE_REFRESH_MS);
    this.dialog.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.opened) return;
    // Only an explicit Enter / change saves the secret word; anything else typed
    // (perhaps by a toddler) is discarded when the panel closes.
    this.secretInput.value = this.deps.store.get().secretWord;
    this.setSecretError(false);
    this.opened = false;
    window.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('focusin', this.onFocusIn);
    window.clearInterval(this.liveTimer);

    // Never leave focus in a hidden input: toddler keys would type into it.
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.el.contains(active)) active.blur();
    this.el.inert = true;
    this.el.classList.remove('is-shown');
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.el.hidden = true;
    }, FADE_MS);

    const restore = this.restoreFocus;
    this.restoreFocus = null;
    if (restore?.isConnected) restore.focus({ preventScroll: true });
  }

  /** Removes the element and every listener (tests / hot reload). */
  destroy(): void {
    this.close();
    window.clearTimeout(this.hideTimer);
    window.clearTimeout(this.savedTimer);
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.el.remove();
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  private readonly resume = (): void => {
    this.close();
    this.deps.actions.resume();
  };

  private readonly stop = (): void => {
    this.close();
    this.deps.actions.stop();
  };

  private patch(patch: Partial<Settings>): void {
    this.deps.store.update(patch);
  }

  // ---------------------------------------------------------------------------
  // Keyboard: Escape closes, Tab stays inside
  // ---------------------------------------------------------------------------

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.resume();
      return;
    }
    // Browser shortcuts (reload, print, zoom, close tab…) and F-keys do nothing here:
    // a toddler may still be at the keyboard. Copy/paste/undo keep working in fields.
    if (/^F\d{1,2}$/.test(event.key)) {
      event.preventDefault();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      const target = event.target;
      const inField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      const editing = inField && !event.altKey && ['a', 'c', 'v', 'x', 'z', 'y'].includes(event.key.toLowerCase());
      if (!editing) event.preventDefault();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = this.focusables();
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = active instanceof Node && this.dialog.contains(active) && active !== this.dialog;
    if (event.shiftKey && (!inside || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!inside || active === last)) {
      event.preventDefault();
      first.focus();
    }
  };

  private readonly onFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    if (target instanceof Node && !this.el.contains(target)) this.dialog.focus({ preventScroll: true });
  };

  private focusables(): HTMLElement[] {
    const all = this.dialog.querySelectorAll<HTMLElement>(FOCUSABLE);
    const out: HTMLElement[] = [];
    for (const node of all) {
      if (node.closest('[hidden]')) continue;
      // Unchecked radios are skipped by Tab; only the checked one is a stop.
      if (node instanceof HTMLInputElement && node.type === 'radio' && !node.checked) continue;
      out.push(node);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------

  private refreshAll(): void {
    const settings = this.deps.store.get();
    this.refreshSettings(settings);
    this.renderVoices(settings);
    this.secretInput.value = settings.secretWord;
    this.setSecretError(false);
    this.secretSaved.textContent = '';
    this.refreshStats();
    this.renderProgress(this.deps.progress.get());
    this.progressConfirm.hidden = true;
    this.refreshLive();
  }

  private refreshSettings(settings: Settings): void {
    for (const refresh of this.refreshers) refresh(settings);
  }

  private readonly refreshLive = (): void => {
    const status = this.deps.getLockStatus();
    for (const [key, chip] of this.statusChips) {
      const on = status[key];
      if (chip.dataset.on === String(on)) continue;
      chip.dataset.on = String(on);
      const state = chip.querySelector('.ks-status__state');
      if (state) state.textContent = on ? 'on' : 'off';
    }
    this.installButton.hidden = !this.deps.canInstall();
  };

  private refreshStats(): void {
    const stats = this.deps.getStats();
    this.statKeys.textContent = stats.keys.toLocaleString();
    this.statTaps.textContent = stats.taps.toLocaleString();
    this.statSmashes.textContent = stats.smashes.toLocaleString();
    this.statFound.textContent = stats.found.toLocaleString();
    this.statSpelled.textContent = stats.spelled.toLocaleString();
    this.statTime.textContent = formatDuration(stats.playMs);
    this.topKeys.replaceChildren();
    if (stats.topKeys.length === 0) {
      this.topKeys.append(el('li', 'ks-topkeys__empty', 'No keys yet. Hand it over!'));
      return;
    }
    stats.topKeys.slice(0, 5).forEach(([label, count], i) => {
      const chip = el('li', `ks-topkey ks-topkey--${i % 5}`);
      chip.append(el('span', 'ks-topkey__key', label), el('span', 'ks-topkey__count', `×${count.toLocaleString()}`));
      this.topKeys.append(chip);
    });
  }

  // ---------------------------------------------------------------------------
  // Layout builders
  // ---------------------------------------------------------------------------

  private id(name: string): string {
    return `${this.prefix}-${name}`;
  }

  private buildHeader(): HTMLElement {
    const head = el('header', 'ks-panel__head');
    const logo = el('span', 'ks-panel__logo');
    logo.innerHTML = LOGO_SVG;
    const titles = el('div', 'ks-panel__titles');
    const title = el('h2', 'ks-panel__title', 'Grown-up controls');
    title.id = this.id('title');
    titles.append(title, el('p', 'ks-panel__subtitle', 'Changes save instantly.'));
    const close = button('ks-iconbtn', '✕', this.resume);
    close.setAttribute('aria-label', 'Close and keep playing');
    head.append(logo, titles, close);
    return head;
  }

  private buildFooter(): HTMLElement {
    const foot = el('footer', 'ks-panel__foot');
    this.installButton = button('ks-btn ks-btn--ghost ks-panel__install', '📲 Install app', () => this.deps.actions.install());
    this.installButton.hidden = true;
    const stop = button('ks-btn ks-btn--secondary', 'Stop', this.stop);
    stop.dataset.action = 'stop';
    const keep = button('ks-btn ks-btn--primary', 'Keep playing', this.resume);
    keep.dataset.action = 'resume';
    foot.append(this.installButton, stop, keep);
    return foot;
  }

  private section(name: string, icon: string, title: string, ...children: Node[]): HTMLElement {
    const section = el('section', 'ks-sec');
    const heading = el('h3', 'ks-sec__title');
    heading.id = this.id(`sec-${name}`);
    const glyph = el('span', 'ks-sec__icon', icon);
    glyph.setAttribute('aria-hidden', 'true');
    heading.append(glyph, title);
    section.setAttribute('aria-labelledby', heading.id);
    section.append(heading, ...children);
    return section;
  }

  /**
   * A label/description on the left and a control on the right.
   * `labelFor` false renders the label as a plain span with an id, for groups.
   */
  private row(id: string, label: string, control: HTMLElement, desc?: string, labelFor = true): HTMLElement {
    const row = el('div', 'ks-row');
    const text = el('div', 'ks-row__text');
    if (labelFor) {
      const lab = el('label', 'ks-row__label', label);
      lab.htmlFor = id;
      text.append(lab);
    } else {
      const lab = el('span', 'ks-row__label', label);
      lab.id = `${id}-label`;
      text.append(lab);
    }
    if (desc) {
      const d = el('p', 'ks-row__desc', desc);
      d.id = `${id}-desc`;
      text.append(d);
    }
    const box = el('div', 'ks-row__control');
    box.append(control);
    row.append(text, box);
    return row;
  }

  private switchRow(key: BoolKey, label: string, desc?: string): HTMLElement {
    const id = this.id(key);
    const wrap = el('span', 'ks-switch');
    const input = el('input');
    input.type = 'checkbox';
    input.id = id;
    input.dataset.setting = key;
    input.setAttribute('role', 'switch');
    if (desc) input.setAttribute('aria-describedby', `${id}-desc`);
    const track = el('span', 'ks-switch__track');
    track.setAttribute('aria-hidden', 'true');
    wrap.append(input, track);
    input.addEventListener('change', () => this.patch({ [key]: input.checked }));
    this.refreshers.push((s) => {
      input.checked = s[key];
    });
    return this.row(id, label, wrap, desc);
  }

  private choiceRow<K extends ChoiceKey>(key: K, label: string, options: Choices<K>, desc?: string): HTMLElement {
    const id = this.id(key);
    const group = el('div', 'ks-seg');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-labelledby', `${id}-label`);
    if (desc) group.setAttribute('aria-describedby', `${id}-desc`);
    const inputs: HTMLInputElement[] = [];
    for (const [value, text] of options) {
      const option = el('label', 'ks-seg__opt');
      const input = el('input');
      input.type = 'radio';
      input.name = id;
      input.value = value;
      input.dataset.setting = key;
      input.addEventListener('change', () => {
        if (input.checked) this.patch({ [key]: value });
      });
      option.append(input, el('span', 'ks-seg__text', text));
      group.append(option);
      inputs.push(input);
    }
    this.refreshers.push((s) => {
      for (const input of inputs) input.checked = input.value === s[key];
    });
    return this.row(id, label, group, desc, false);
  }

  // ---------------------------------------------------------------------------
  // Sections
  // ---------------------------------------------------------------------------

  private buildWorldSection(): HTMLElement {
    const groupId = this.id('world');
    const cards = el('div', 'ks-cards');
    cards.setAttribute('role', 'radiogroup');
    cards.setAttribute('aria-labelledby', this.id('sec-world'));
    const inputs: HTMLInputElement[] = [];
    for (const world of this.deps.worlds) {
      const card = el('label', 'ks-card');
      const input = el('input');
      input.type = 'radio';
      input.name = groupId;
      input.value = world.id;
      input.dataset.setting = 'world';
      input.addEventListener('change', () => {
        if (input.checked) this.patch({ world: world.id });
      });
      const face = el('span', 'ks-card__face');
      const icon = el('span', 'ks-card__icon', world.icon);
      icon.setAttribute('aria-hidden', 'true');
      face.append(icon, el('span', 'ks-card__label', world.label));
      card.append(input, face);
      cards.append(card);
      inputs.push(input);
    }
    this.refreshers.push((s) => {
      for (const input of inputs) input.checked = input.value === s.world;
    });

    const minutesId = this.id('rotateMinutes');
    const minutes = el('input', 'ks-input ks-input--number');
    minutes.type = 'number';
    minutes.id = minutesId;
    minutes.min = '1';
    minutes.max = '30';
    minutes.step = '1';
    minutes.inputMode = 'numeric';
    minutes.dataset.setting = 'rotateMinutes';
    minutes.addEventListener('change', () => {
      const n = Math.round(Number(minutes.value));
      if (Number.isFinite(n) && minutes.value !== '') this.patch({ rotateMinutes: Math.min(30, Math.max(1, n)) });
      minutes.value = String(this.deps.store.get().rotateMinutes);
    });
    const minutesBox = el('span', 'ks-unit');
    minutesBox.append(minutes, el('span', 'ks-unit__text', 'min'));
    const minutesRow = this.row(minutesId, 'Change world every', minutesBox);
    this.refreshers.push((s) => {
      if (document.activeElement !== minutes) minutes.value = String(s.rotateMinutes);
      minutes.disabled = !s.autoRotate;
      minutesRow.classList.toggle('is-disabled', !s.autoRotate);
    });

    return this.section(
      'world',
      '🌍',
      'World',
      cards,
      this.switchRow('autoRotate', 'Auto-rotate worlds', 'Moves to the next world every few minutes of play.'),
      minutesRow,
    );
  }

  /** The clear voice on/off switch first; everything below it is dimmed while the voice is off. */
  private buildVoiceSection(): HTMLElement {
    const main = this.switchRow('voice', 'Voice', 'Speaks letters, words, numbers and colours.');
    main.classList.add('ks-row--hero');

    const style = this.choiceRow('voiceStyle', 'Voice type', [
      ['natural', 'Natural'],
      ['device', 'This device'],
    ], STYLE_DESC.natural);
    const styleDesc = style.querySelector<HTMLElement>('.ks-row__desc');

    const voiceId = this.id('voiceURI');
    this.voiceSelect = el('select', 'ks-select');
    this.voiceSelect.id = voiceId;
    this.voiceSelect.dataset.setting = 'voiceURI';
    this.voiceSelect.setAttribute('aria-describedby', `${voiceId}-desc`);
    this.voiceSelect.addEventListener('change', () => this.patch({ voiceURI: this.voiceSelect.value || null }));
    const deviceDesc = this.deps.speaker.supported
      ? 'Automatic picks the best voice on this device. Voices marked “online” send each word to their provider and need a connection.'
      : 'This browser has no speech voices. Natural still works.';
    const device = this.row(voiceId, 'Device voice', this.voiceSelect, deviceDesc);
    device.classList.add('ks-row--sub');

    const says = this.choiceRow('speech', 'Says', [
      ['letter', 'Letter'],
      ['word', 'Letter + word'],
    ], 'Letter says “B”. Letter + word says “B… B is for ball”. Numbers, shapes and colours are always named.');

    const hear = button('ks-btn ks-btn--tonal', '▶ Hear it', () => this.deps.actions.testSound());
    hear.dataset.action = 'hear';
    const hearRow = el('div', 'ks-row ks-row--end');
    hearRow.append(hear);

    const dependents = [style, device, says, hearRow];
    this.refreshers.push((s) => {
      device.hidden = s.voiceStyle !== 'device';
      if (styleDesc) styleDesc.textContent = STYLE_DESC[s.voiceStyle];
      for (const row of dependents) {
        row.classList.toggle('is-disabled', !s.voice);
        for (const control of row.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')) {
          control.disabled = !s.voice || (control === this.voiceSelect && !this.deps.speaker.supported);
        }
      }
    });

    return this.section('voice', '🔊', 'Voice', main, style, device, says, hearRow);
  }

  private buildSoundSection(): HTMLElement {
    // Volume
    const volumeId = this.id('volume');
    const volumeBox = el('span', 'ks-range');
    const volume = el('input');
    volume.type = 'range';
    volume.id = volumeId;
    volume.min = '0';
    volume.max = '100';
    volume.step = '5';
    volume.dataset.setting = 'volume';
    const volumeOut = el('output', 'ks-range__value');
    volumeOut.setAttribute('for', volumeId);
    volume.addEventListener('input', () => {
      volumeOut.textContent = `${volume.value}%`;
      volume.style.setProperty('--fill', `${volume.value}%`);
      this.patch({ volume: Number(volume.value) / 100 });
    });
    volumeBox.append(volume, volumeOut);
    this.refreshers.push((s) => {
      const pct = String(Math.round(s.volume * 100));
      if (volume.value !== pct) volume.value = pct;
      volumeOut.textContent = `${pct}%`;
      volume.style.setProperty('--fill', `${pct}%`);
      volumeBox.classList.toggle('is-muted', s.muted);
    });

    return this.section(
      'sound',
      '🎵',
      'Sound',
      this.row(volumeId, 'Volume', volumeBox, 'Peaks are always limited to protect little ears.'),
      this.switchRow('muted', 'Mute'),
      this.switchRow('notes', 'Soft notes', 'Each key plays its own gentle note under the voice. Off: a quiet tap instead.'),
    );
  }

  private buildLearningSection(): HTMLElement {
    return this.section(
      'learning',
      '🎓',
      'Learning',
      this.choiceRow('mode', 'Activity', [
        ['explore', 'Explore'],
        ['find-letters', 'Find letters'],
        ['find-numbers', 'Find numbers'],
        ['spell', 'Spell'],
      ], 'Explore is free play (ages 1+). Find letters and Find numbers ask for one key at a time (3+). Spell builds short picture words (4+). Nobody ever loses.'),
      this.choiceRow('layout', 'Cards', [
        ['focus', 'One card'],
        ['keyboard', 'Where the key is'],
      ], 'One card shows a single big flashcard with recent ones on a shelf. Where the key is places cards where each key sits on the keyboard.'),
      this.choiceRow('letterCase', 'Letters', [
        ['upper', 'ABC'],
        ['lower', 'abc'],
        ['both', 'Aa'],
      ], 'Aa shows capital and small letters together.'),
      this.switchRow('pictures', 'Pictures', 'Letters bring a picture, like B with a ball ⚽.'),
    );
  }

  private buildLookSection(): HTMLElement {
    return this.section(
      'look',
      '🎨',
      'Look & motion',
      this.choiceRow('size', 'Card size', [
        ['normal', 'Normal'],
        ['big', 'Big'],
        ['huge', 'Huge'],
      ]),
      this.choiceRow('intensity', 'Liveliness', [
        ['calm', 'Calm'],
        ['normal', 'Normal'],
        ['lively', 'Lively'],
      ], 'How much confetti and how many cards at once.'),
      this.choiceRow('motion', 'Motion', [
        ['system', 'System'],
        ['reduce', 'Reduce'],
        ['full', 'Full'],
      ], 'System follows your device’s Reduce Motion setting.'),
      this.switchRow('trails', 'Painting', 'Drag a finger or the mouse to paint soft strokes.'),
      this.switchRow('faces', 'Shape faces', 'Tapped shapes get simple friendly faces.'),
    );
  }

  private buildChildSection(): HTMLElement {
    const nameId = this.id('childName');
    const name = el('input', 'ks-input');
    name.type = 'text';
    name.id = nameId;
    name.placeholder = 'Optional';
    name.autocomplete = 'off';
    name.spellcheck = false;
    name.maxLength = 24;
    name.dataset.setting = 'childName';
    name.setAttribute('aria-describedby', `${nameId}-desc`);
    name.addEventListener('input', () => this.patch({ childName: name.value }));
    name.addEventListener('change', () => {
      name.value = this.deps.store.get().childName;
    });
    this.refreshers.push((s) => {
      // Don't fight the caret while a grown-up is typing.
      if (document.activeElement !== name) name.value = s.childName;
    });

    const timerId = this.id('sessionMinutes');
    const timer = el('select', 'ks-select');
    timer.id = timerId;
    timer.dataset.setting = 'sessionMinutes';
    timer.setAttribute('aria-describedby', `${timerId}-desc`);
    const fillTimer = (current: number): void => {
      const values = SESSION_MINUTES.includes(current) ? SESSION_MINUTES : [...SESSION_MINUTES, current].sort((a, b) => a - b);
      if (timer.options.length === values.length) return;
      timer.replaceChildren(
        ...values.map((v) => {
          const option = el('option', undefined, v === 0 ? 'Off' : `${v} minutes`);
          option.value = String(v);
          return option;
        }),
      );
    };
    timer.addEventListener('change', () => this.patch({ sessionMinutes: Number(timer.value) }));
    this.refreshers.push((s) => {
      fillTimer(s.sessionMinutes);
      timer.value = String(s.sessionMinutes);
    });

    return this.section(
      'child',
      '🧒',
      'Your child',
      this.row(nameId, 'Name', name, 'Shown on the start screen. With the “This device” voice, it’s also cheered now and then.'),
      this.row(
        timerId,
        'Session timer',
        timer,
        'When time is up, sounds and colours wind down gently for about 45 seconds, then a sleepy “All done!” screen appears. Only a grown-up can continue.',
      ),
    );
  }

  private buildProgressSection(): HTMLElement {
    const intro = el('p', 'ks-note', 'What your child has met so far, on this device only. Tinted: seen in play. Filled: found in a game.');
    this.progressGrid = el('ul', 'ks-progress');
    this.progressGrid.setAttribute('aria-label', 'Letters and numbers');
    for (const symbol of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'0123456789']) {
      const cell = el('li', 'ks-progress__cell', symbol);
      cell.dataset.symbol = symbol;
      cell.dataset.state = 'none';
      this.progressGrid.append(cell);
    }
    const wordsLabel = el('p', 'ks-topkeys__title', 'Words spelled');
    wordsLabel.id = this.id('words');
    this.progressWords = el('ul', 'ks-topkeys');
    this.progressWords.setAttribute('aria-labelledby', wordsLabel.id);
    this.progressSince = el('p', 'ks-row__desc');

    this.progressConfirm = el('div', 'ks-confirm');
    this.progressConfirm.hidden = true;
    const yes = button('ks-btn ks-btn--secondary', 'Yes, reset', () => {
      this.deps.actions.resetProgress();
      this.progressConfirm.hidden = true;
      this.renderProgress(this.deps.progress.get());
    });
    yes.dataset.action = 'reset-progress-confirm';
    const no = button('ks-btn ks-btn--ghost', 'Cancel', () => {
      this.progressConfirm.hidden = true;
    });
    this.progressConfirm.append(el('span', 'ks-confirm__text', 'Clear all progress?'), no, yes);
    const reset = button('ks-btn ks-btn--ghost', 'Reset progress', () => {
      this.progressConfirm.hidden = false;
    });
    reset.dataset.action = 'reset-progress';
    const resetRow = el('div', 'ks-row ks-row--end');
    resetRow.append(this.progressSince, reset);

    return this.section('progress', '🌱', 'Progress', intro, this.progressGrid, wordsLabel, this.progressWords, resetRow, this.progressConfirm);
  }

  private renderProgress(progress: LearningProgress): void {
    for (const cell of this.progressGrid.children) {
      const symbol = (cell as HTMLElement).dataset.symbol ?? '';
      const found = progress.found[symbol] ?? 0;
      const seen = progress.seen[symbol] ?? 0;
      const state = found > 0 ? 'found' : seen > 0 ? 'seen' : 'none';
      (cell as HTMLElement).dataset.state = state;
      cell.setAttribute('aria-label', `${symbol}: ${state === 'found' ? `found ${found}×` : state === 'seen' ? `seen ${seen}×` : 'not yet'}`);
    }
    const words = Object.entries(progress.spelled).sort((a, b) => b[1] - a[1]);
    this.progressWords.replaceChildren();
    if (words.length === 0) {
      this.progressWords.append(el('li', 'ks-topkeys__empty', 'None yet. Try the Spell activity.'));
    } else {
      words.slice(0, 24).forEach(([word, count], i) => {
        const chip = el('li', `ks-topkey ks-topkey--${i % 5}`);
        chip.append(el('span', 'ks-topkey__key', word), el('span', 'ks-topkey__count', `×${count}`));
        this.progressWords.append(chip);
      });
    }
    this.progressSince.textContent = progress.since
      ? `Since ${new Date(progress.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
      : '';
  }

  private buildSafetySection(): HTMLElement {
    // Secret word
    const secretId = this.id('secretWord');
    const field = el('div', 'ks-field');
    this.secretInput = el('input', 'ks-input');
    this.secretInput.type = 'text';
    this.secretInput.id = secretId;
    this.secretInput.autocomplete = 'off';
    this.secretInput.spellcheck = false;
    this.secretInput.maxLength = 16;
    this.secretInput.setAttribute('autocapitalize', 'none');
    this.secretInput.setAttribute('autocorrect', 'off');
    this.secretInput.dataset.setting = 'secretWord';
    this.secretInput.setAttribute('aria-describedby', `${secretId}-desc ${secretId}-error`);
    this.secretError = el('p', 'ks-field__error', 'Use 4 to 16 letters (a–z), with no spaces or numbers.');
    this.secretError.id = `${secretId}-error`;
    this.secretError.hidden = true;
    this.secretSaved = el('span', 'ks-field__saved');
    this.secretSaved.setAttribute('aria-live', 'polite');
    const inputLine = el('div', 'ks-field__line');
    inputLine.append(this.secretInput, this.secretSaved);
    field.append(inputLine, this.secretError);

    this.secretInput.addEventListener('input', () => {
      const value = this.secretInput.value.trim();
      // Point out impossible input right away; "too short" waits for commit.
      this.setSecretError(/[^a-z]/i.test(value) || value.length > 16);
      this.secretSaved.textContent = '';
    });
    this.secretInput.addEventListener('change', () => this.commitSecret(true));
    this.secretInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.commitSecret(true);
      }
    });

    // Lock status
    const chips = el('ul', 'ks-statuses');
    chips.setAttribute('aria-label', 'Lock status');
    for (const [key, label, note] of STATUS_ITEMS) {
      const chip = el('li', 'ks-status');
      chip.dataset.status = key;
      chip.dataset.on = 'false';
      const dot = el('span', 'ks-status__dot');
      dot.setAttribute('aria-hidden', 'true');
      const text = el('span', 'ks-status__label', label);
      chip.append(dot, text, srOnly(': '), el('span', 'ks-status__state ks-sr', 'off'));
      if (note) chip.append(el('small', 'ks-status__note', note));
      chips.append(chip);
      this.statusChips.set(key, chip);
    }
    const relock = button('ks-btn ks-btn--ghost', '🔒 Re-lock', () => this.deps.actions.relock());
    relock.dataset.action = 'relock';
    const statusBox = el('div', 'ks-statusbox');
    statusBox.append(chips, relock);

    const note = el(
      'p',
      'ks-note',
      'Honest note: grown-ups can always get out. The system app switcher (⌘Tab / Alt+Tab) keeps working, and holding Escape exits fullscreen.',
    );

    return this.section(
      'safety',
      '🛡️',
      'Safety',
      this.row(secretId, 'Secret word', field, 'Type it during play to open this panel.'),
      this.switchRow('lockKeyboard', 'Lock keyboard', 'Swallows Escape taps, ⌘W, Ctrl+W and similar shortcuts while fullscreen (Chrome/Edge only).'),
      this.switchRow('confirmExit', 'Confirm before leaving', 'Asks “Leave site?” if a closing shortcut slips through.'),
      statusBox,
      note,
    );
  }

  private buildSessionSection(): HTMLElement {
    const stats = el('dl', 'ks-stats');
    const stat = (label: string): HTMLElement => {
      const tile = el('div', 'ks-stat');
      const value = el('dd', 'ks-stat__value', '0');
      tile.append(el('dt', 'ks-stat__label', label), value);
      stats.append(tile);
      return value;
    };
    this.statKeys = stat('Keys');
    this.statTaps = stat('Taps');
    this.statFound = stat('Found');
    this.statSpelled = stat('Words spelled');
    this.statSmashes = stat('Smashes');
    this.statTime = stat('Play time');

    const topLabel = el('p', 'ks-topkeys__title', 'Favourite keys');
    topLabel.id = this.id('topkeys');
    this.topKeys = el('ul', 'ks-topkeys');
    this.topKeys.setAttribute('aria-labelledby', topLabel.id);

    const reset = button('ks-btn ks-btn--ghost', 'Reset', () => {
      this.deps.actions.resetStats();
      this.refreshStats();
    });
    reset.dataset.action = 'reset-stats';
    const resetRow = el('div', 'ks-row ks-row--end');
    resetRow.append(reset);

    return this.section('session', '📊', 'This session', stats, topLabel, this.topKeys, resetRow);
  }

  // ---------------------------------------------------------------------------
  // Voices + secret word
  // ---------------------------------------------------------------------------

  private renderVoices(settings: Settings): void {
    const select = this.voiceSelect;
    const voices = this.deps.speaker.voices();
    const options: HTMLOptionElement[] = [];
    const auto = el('option', undefined, 'Automatic');
    auto.value = '';
    options.push(auto);
    let found = settings.voiceURI === null;
    for (const voice of voices) {
      const label = voice.lang ? `${voice.name} (${voice.lang})` : voice.name;
      // Network voices send each word to their provider and fail offline: say so.
      const option = el('option', undefined, voice.local ? label : `${label} · online`);
      option.value = voice.uri;
      if (voice.uri === settings.voiceURI) found = true;
      options.push(option);
    }
    if (!found && settings.voiceURI) {
      // Keep the saved choice visible even if this device doesn't have it (yet).
      const saved = el('option', undefined, 'Saved voice (not on this device)');
      saved.value = settings.voiceURI;
      options.push(saved);
    }
    select.replaceChildren(...options);
    select.value = settings.voiceURI ?? '';
    select.disabled = !this.deps.speaker.supported || !settings.voice;
  }

  /** Saves the typed secret word if it is valid; otherwise optionally explains why not. */
  private commitSecret(showErrors: boolean): void {
    const value = this.secretInput.value.trim().toLowerCase();
    const current = this.deps.store.get().secretWord;
    if (value === current) {
      this.setSecretError(false);
      return;
    }
    if (!SECRET_WORD.test(value)) {
      if (showErrors) this.setSecretError(true);
      return;
    }
    this.setSecretError(false);
    const saved = this.deps.store.update({ secretWord: value }).secretWord;
    this.secretInput.value = saved;
    this.secretSaved.textContent = 'Saved ✓';
    window.clearTimeout(this.savedTimer);
    this.savedTimer = window.setTimeout(() => {
      this.secretSaved.textContent = '';
    }, SAVED_HINT_MS);
  }

  private setSecretError(show: boolean): void {
    this.secretError.hidden = !show;
    this.secretInput.setAttribute('aria-invalid', String(show));
  }
}
