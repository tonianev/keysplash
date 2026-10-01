/**
 * Learning-game prompt (DESIGN.md §6): a floating card at the top centre —
 * "Find  B  ⚽", or a picture with letter slots for Spell — and a mini
 * keyboard that slides down as a hint, with the target key filled in the
 * challenge colour. Pure DOM/CSS; kid-facing text uses Andika.
 */
import { KEYBOARD_ROWS } from '../keymap';
import type { Challenge, HintLevel, PromptBar } from '../types';

const CELEBRATE_MS = 900;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Key label for a code: 'KeyB' → 'B', 'Digit3' → '3', 'Space' → ''. */
function labelFor(code: string): string {
  const m = /^(?:Key|Digit)(.)$/.exec(code);
  return m ? m[1] : '';
}

/** The key code a challenge wants next. */
export function targetCode(challenge: Challenge): string | null {
  switch (challenge.kind) {
    case 'find-letter':
      return `Key${challenge.target}`;
    case 'find-number':
      return `Digit${challenge.target}`;
    case 'spell': {
      const next = challenge.letters[challenge.index];
      return next ? `Key${next}` : null;
    }
  }
}

/** The label the target key should show: 'B', '3', or the next spell letter. */
function wantedLabel(challenge: Challenge): string {
  if (challenge.kind === 'find-letter') return challenge.target;
  if (challenge.kind === 'find-number') return String(challenge.target);
  return challenge.letters[challenge.index] ?? '';
}

function speakable(challenge: Challenge): string {
  switch (challenge.kind) {
    case 'find-letter':
      return `Find the letter ${challenge.target}`;
    case 'find-number':
      return `Find the number ${challenge.target}`;
    case 'spell':
      return `Spell ${challenge.word.word}`;
  }
}

export class DomPromptBar implements PromptBar {
  private readonly el: HTMLElement;
  private readonly card: HTMLElement;
  private readonly kbd: HTMLElement;
  private readonly live: HTMLElement;
  private readonly keys = new Map<string, HTMLElement>();
  private visible = false;
  private celebrateTimer = 0;
  private current: Challenge | null = null;
  /** A key whose label was swapped to the target letter (non-US layouts), with its original label. */
  private relabeled: { key: HTMLElement; label: string } | null = null;

  constructor(root: HTMLElement, options: { rows?: readonly (readonly string[])[] } = {}) {
    this.el = el('div', 'ks-prompt');
    this.el.hidden = true;
    this.card = el('div', 'ks-prompt__card');
    this.kbd = el('div', 'ks-kbd');
    this.kbd.setAttribute('aria-hidden', 'true');
    for (const row of options.rows ?? KEYBOARD_ROWS) {
      const line = el('div', 'ks-kbd__row');
      for (const code of row) {
        const key = el('span', code === 'Space' ? 'ks-kbd__key ks-kbd__key--space' : 'ks-kbd__key', labelFor(code));
        key.dataset.code = code;
        line.append(key);
        this.keys.set(code, key);
      }
      this.kbd.append(line);
    }
    this.live = el('p', 'ks-sr');
    this.live.setAttribute('aria-live', 'polite');
    this.el.append(this.card, this.kbd, this.live);
    root.append(this.el);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  show(challenge: Challenge): void {
    window.clearTimeout(this.celebrateTimer);
    this.current = challenge;
    this.el.classList.remove('is-celebrating');
    this.renderCard(challenge);
    this.setHint(challenge, 0);
    this.live.textContent = speakable(challenge);
    if (!this.visible) {
      this.visible = true;
      this.el.hidden = false;
      void this.el.offsetWidth; // commit display so the transition runs
    }
    // Re-trigger the entrance animation for a new challenge.
    this.el.classList.remove('is-shown');
    void this.el.offsetWidth;
    this.el.classList.add('is-shown');
  }

  update(challenge: Challenge, hint: HintLevel, code?: string | null): void {
    this.current = challenge;
    if (challenge.kind === 'spell') this.renderSlots(challenge);
    this.setHint(challenge, hint, code);
  }

  celebrate(): void {
    this.el.classList.add('is-celebrating');
    this.setHint(this.current, 0);
    window.clearTimeout(this.celebrateTimer);
    this.celebrateTimer = window.setTimeout(() => this.el.classList.remove('is-celebrating'), CELEBRATE_MS);
  }

  hide(): void {
    window.clearTimeout(this.celebrateTimer);
    this.visible = false;
    this.current = null;
    this.el.classList.remove('is-shown', 'is-celebrating');
    this.el.hidden = true;
  }

  // ---------------------------------------------------------------------------

  private renderCard(challenge: Challenge): void {
    const c = challenge.color;
    this.el.style.setProperty('--c-hex', c.hex);
    this.el.style.setProperty('--c-container', c.container);
    this.el.style.setProperty('--c-ink', c.ink);
    this.el.dataset.kind = challenge.kind;
    this.card.replaceChildren();
    const check = el('span', 'ks-prompt__check', '✓');
    check.setAttribute('aria-hidden', 'true');
    if (challenge.kind === 'spell') {
      const pic = el('span', 'ks-prompt__pic', challenge.word.emoji);
      pic.setAttribute('aria-hidden', 'true');
      const slots = el('span', 'ks-prompt__slots');
      this.card.append(pic, slots, check);
      this.renderSlots(challenge);
      return;
    }
    const label = el('span', 'ks-prompt__label', 'Find');
    const tile = el('span', 'ks-prompt__tile', challenge.display);
    this.card.append(label, tile);
    if (challenge.kind === 'find-letter') {
      const pic = el('span', 'ks-prompt__pic', challenge.word.emoji);
      pic.setAttribute('aria-hidden', 'true');
      this.card.append(pic);
    }
    this.card.append(check);
  }

  private renderSlots(challenge: Extract<Challenge, { kind: 'spell' }>): void {
    const slots = this.card.querySelector('.ks-prompt__slots');
    if (!slots) return;
    slots.replaceChildren(
      ...challenge.letters.map((letter, i) => {
        // Every letter is visible (muted until typed) so the child can match its shape to a key.
        const state = i < challenge.index ? 'is-done' : i === challenge.index ? 'is-next' : '';
        return el('span', `ks-slot ${state}`.trim(), letter.toLowerCase());
      }),
    );
  }

  private setHint(challenge: Challenge | null, hint: HintLevel, override?: string | null): void {
    for (const key of this.keys.values()) key.classList.remove('is-target', 'is-pulse');
    if (this.relabeled) {
      this.relabeled.key.textContent = this.relabeled.label;
      this.relabeled = null;
    }
    const code = challenge && hint > 0 ? (override ?? targetCode(challenge)) : null;
    // The diagram is drawn as US-QWERTY; a learned code still lands on the right physical spot,
    // labelled with the letter that key really types.
    const key = code ? this.keys.get(code) : undefined;
    const want = challenge ? wantedLabel(challenge) : '';
    if (key && want && key.textContent !== want) {
      this.relabeled = { key, label: key.textContent ?? '' };
      key.textContent = want;
    }
    this.el.classList.toggle('has-hint', !!key);
    if (key) {
      key.classList.add('is-target');
      if (hint >= 2) key.classList.add('is-pulse');
    }
  }
}
