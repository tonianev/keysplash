import type { Overlays } from '../types';

/** How long a grown-up must hold the "keep playing" button on the All done screen. */
export const ALL_DONE_HOLD_MS = 3000;
const TOAST_MS = 2600;
/** Matches the CSS fade duration; after it the element gets `hidden`. */
const FADE_MS = 280;

/** Keys that never count as "the toddler pressed something". */
const IGNORED_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'Super', 'Hyper', 'Fn', 'FnLock',
  'CapsLock', 'NumLock', 'ScrollLock', 'Symbol', 'SymbolLock', 'Tab', 'Escape',
  'ContextMenu', 'PrintScreen', 'Power', 'Eject', 'WakeUp', 'Unidentified',
]);

/** Function, media and system keys belong to grown-ups (volume, brightness, devtools…). */
function isGrownUpKey(key: string): boolean {
  return IGNORED_KEYS.has(key) || /^F\d{1,2}$/.test(key) || /^(Audio|Media|Launch|Browser|Brightness)/.test(key);
}

const PLAY_SVG =
  '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
  '<path d="M38 24.5c0-4.2 4.6-6.8 8.2-4.6l33 20.5c3.4 2.1 3.4 7.1 0 9.2l-33 20.5c-3.6 2.2-8.2-.4-8.2-4.6z" fill="currentColor"/>' +
  '</svg>';

/** Ring circumferences (2πr). Real lengths rather than `pathLength`, which older WebKit ignores on circles. */
const CORNER_RADIUS = 26;
const CORNER_CIRCUMFERENCE = 2 * Math.PI * CORNER_RADIUS;

const HOLD_RING_SVG =
  '<svg class="ks-hold__ring" viewBox="0 0 44 44" aria-hidden="true" focusable="false">' +
  '<circle class="ks-hold__track" cx="22" cy="22" r="18"/>' +
  // r = 18 → circumference ≈ 113.1, mirrored in styles.css.
  '<circle class="ks-hold__fill" cx="22" cy="22" r="18" transform="rotate(-90 22 22)"/>' +
  '<path class="ks-hold__icon" d="M17 15.5v13l11-6.5z"/>' +
  '</svg>';

const CORNER_SVG =
  '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
  `<circle class="ks-corner__bg" cx="32" cy="32" r="${CORNER_RADIUS}"/>` +
  `<circle class="ks-corner__fill" cx="32" cy="32" r="${CORNER_RADIUS}" stroke-dasharray="${CORNER_CIRCUMFERENCE.toFixed(2)}" transform="rotate(-90 32 32)"/>` +
  // A small padlock: shackle + body.
  '<path class="ks-corner__shackle" d="M25.5 31v-4.5a6.5 6.5 0 0 1 13 0V31"/>' +
  '<rect class="ks-corner__body" x="22" y="30" width="20" height="15" rx="4"/>' +
  '</svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Shows an element with a CSS fade, or fades it out and then sets `hidden`. */
class Fade {
  private timer = 0;
  constructor(private readonly node: HTMLElement) {
    node.hidden = true;
  }
  show(): void {
    window.clearTimeout(this.timer);
    this.node.hidden = false;
    void this.node.offsetWidth; // commit `display` so the opacity transition runs
    this.node.classList.add('is-shown');
  }
  hide(): void {
    this.node.classList.remove('is-shown');
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.node.hidden = true;
    }, FADE_MS);
  }
  dispose(): void {
    window.clearTimeout(this.timer);
  }
}

/**
 * Full-screen moments that sit above the canvas: the sleepy "All done!" card,
 * the "tap to keep playing" screen after fullscreen is lost, the corner-hold
 * ring and parent toasts.
 *
 * Both full-screen overlays hide themselves before invoking their callback, so
 * a later hideAllDone()/hideResume() from the orchestrator is a harmless no-op.
 */
export class DomOverlays implements Overlays {
  private readonly allDone: HTMLElement;
  private readonly allDoneFade: Fade;
  private readonly holdButton: HTMLButtonElement;
  private readonly resume: HTMLElement;
  private readonly resumeFade: Fade;
  private readonly corner: HTMLElement;
  private readonly cornerFill: SVGCircleElement;
  private readonly toastEl: HTMLElement;

  private parentResume: (() => void) | null = null;
  private resumeCallback: (() => void) | null = null;
  private holdTimer = 0;
  private toastTimer = 0;
  /** Last ring value written to the DOM (percent), to skip redundant writes. */
  private cornerPercent = -1;

  constructor(private readonly root: HTMLElement) {
    // --- All done -----------------------------------------------------------
    this.allDone = el('div', 'ks-alldone');
    this.allDone.setAttribute('role', 'dialog');
    this.allDone.setAttribute('aria-label', 'All done! Time for a break.');

    const sky = el('div', 'ks-alldone__sky');
    sky.setAttribute('aria-hidden', 'true');

    const card = el('div', 'ks-alldone__card');
    const moon = el('div', 'ks-alldone__moon');
    moon.setAttribute('aria-hidden', 'true');
    moon.append(el('span', 'ks-alldone__moon-glyph', '🌙'));
    for (let i = 1; i <= 3; i++) moon.append(el('span', `ks-z ks-z--${i}`, 'z'));
    card.append(moon, el('h2', 'ks-alldone__title', 'All done!'), el('p', 'ks-alldone__sub', 'Time for a break 💛'));

    this.holdButton = el('button', 'ks-hold');
    this.holdButton.type = 'button';
    // Grown-up control: the toddler keyboard (which swallows every key in the
    // capture phase) must let Space/Enter reach it when a grown-up focuses it.
    this.holdButton.setAttribute('data-allow-keys', '');
    this.holdButton.innerHTML = HOLD_RING_SVG;
    this.holdButton.append(el('span', 'ks-hold__label', 'Grown-ups: press & hold to keep playing'));
    this.holdButton.addEventListener('pointerdown', this.onHoldPointerDown);
    this.holdButton.addEventListener('pointerup', this.cancelHold);
    this.holdButton.addEventListener('pointercancel', this.cancelHold);
    this.holdButton.addEventListener('pointerleave', this.cancelHold);
    this.holdButton.addEventListener('keydown', this.onHoldKeyDown);
    this.holdButton.addEventListener('keyup', this.onHoldKeyUp);
    this.holdButton.addEventListener('blur', this.cancelHold);
    this.holdButton.addEventListener('contextmenu', preventDefault);

    this.allDone.append(sky, card, this.holdButton);
    this.allDoneFade = new Fade(this.allDone);

    // --- Resume after fullscreen loss -----------------------------------------
    this.resume = el('div', 'ks-resume');
    this.resume.setAttribute('role', 'button');
    this.resume.setAttribute('aria-label', 'Tap to keep playing');
    this.resume.tabIndex = -1;
    const play = el('div', 'ks-resume__play');
    play.innerHTML = PLAY_SVG;
    const hand = el('div', 'ks-resume__hand', '👆');
    hand.setAttribute('aria-hidden', 'true');
    this.resume.append(play, hand);
    this.resume.addEventListener('click', this.onResumeGesture);
    this.resumeFade = new Fade(this.resume);

    // --- Corner-hold ring -------------------------------------------------------
    this.corner = el('div', 'ks-corner');
    this.corner.setAttribute('aria-hidden', 'true');
    this.corner.innerHTML = CORNER_SVG;
    this.cornerFill = this.corner.querySelector('.ks-corner__fill') as SVGCircleElement;

    // --- Toast ------------------------------------------------------------------
    this.toastEl = el('div', 'ks-toast');
    this.toastEl.setAttribute('role', 'status');
    this.toastEl.setAttribute('aria-live', 'polite');
    this.toastEl.setAttribute('aria-atomic', 'true');

    root.append(this.allDone, this.resume, this.corner, this.toastEl);
  }

  // ---------------------------------------------------------------------------
  // All done
  // ---------------------------------------------------------------------------

  showAllDone(onParentResume: () => void): void {
    this.parentResume = onParentResume;
    this.cancelHold();
    this.allDoneFade.show();
  }

  hideAllDone(): void {
    this.parentResume = null;
    this.cancelHold();
    if (this.allDone.classList.contains('is-shown')) this.allDoneFade.hide();
  }

  private readonly onHoldPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    event.preventDefault(); // no focus ring flash, no text selection, no touch-emulated mouse events
    this.startHold();
  };

  private readonly onHoldKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault(); // suppress the native click
    if (!event.repeat) this.startHold();
  };

  private readonly onHoldKeyUp = (event: KeyboardEvent): void => {
    if (event.key === ' ' || event.key === 'Enter') this.cancelHold();
  };

  private startHold(): void {
    if (this.holdTimer || !this.parentResume) return;
    this.holdButton.classList.add('is-holding');
    this.holdTimer = window.setTimeout(this.completeHold, ALL_DONE_HOLD_MS);
  }

  private readonly cancelHold = (): void => {
    if (this.holdTimer) window.clearTimeout(this.holdTimer);
    this.holdTimer = 0;
    this.holdButton.classList.remove('is-holding');
  };

  private readonly completeHold = (): void => {
    this.holdTimer = 0;
    const callback = this.parentResume;
    this.hideAllDone();
    callback?.();
  };

  // ---------------------------------------------------------------------------
  // Resume
  // ---------------------------------------------------------------------------

  showResume(onResume: () => void): void {
    this.resumeCallback = onResume;
    if (!this.resume.classList.contains('is-shown')) {
      this.resumeFade.show();
      // Capture phase so a key anywhere resumes, even if focus is elsewhere.
      window.addEventListener('keydown', this.onResumeKey, true);
    }
  }

  hideResume(): void {
    this.resumeCallback = null;
    window.removeEventListener('keydown', this.onResumeKey, true);
    if (this.resume.classList.contains('is-shown')) this.resumeFade.hide();
  }

  private readonly onResumeKey = (event: KeyboardEvent): void => {
    // Escape is ignored on purpose: a grown-up holding Escape to leave
    // fullscreen must not bounce straight back in. Chords belong to grown-ups.
    if (event.repeat || isGrownUpKey(event.key)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest('[data-allow-keys]')) return;
    this.onResumeGesture();
  };

  /** Runs inside the click/keydown so the callback can re-request fullscreen. */
  private readonly onResumeGesture = (): void => {
    const callback = this.resumeCallback;
    if (!callback) return;
    this.hideResume();
    callback();
  };

  // ---------------------------------------------------------------------------
  // Corner ring + toast
  // ---------------------------------------------------------------------------

  setCornerProgress(progress: number): void {
    const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
    const percent = Math.round(p * 100);
    if (percent === this.cornerPercent) return;
    this.cornerPercent = percent;
    this.cornerFill.style.strokeDashoffset = ((CORNER_CIRCUMFERENCE * (100 - percent)) / 100).toFixed(2);
    this.corner.classList.toggle('is-shown', percent > 0);
    this.corner.classList.toggle('is-full', percent >= 100);
  }

  toast(message: string): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('is-shown');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('is-shown');
    }, TOAST_MS);
  }

  /** Removes every element and listener (tests / hot reload). */
  destroy(): void {
    this.cancelHold();
    this.hideResume();
    window.clearTimeout(this.toastTimer);
    this.allDoneFade.dispose();
    this.resumeFade.dispose();
    for (const node of [this.allDone, this.resume, this.corner, this.toastEl]) {
      if (node.parentNode === this.root) node.remove();
    }
  }
}

function preventDefault(event: Event): void {
  event.preventDefault();
}
