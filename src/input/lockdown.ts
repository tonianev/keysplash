/**
 * Keeps the toddler inside the toy (and the parent's machine safe):
 * fullscreen, Keyboard Lock (Chromium: captures Escape, Cmd/Ctrl+W, Alt+Tab…;
 * the parent exits by *holding* Escape), screen wake lock, a "Leave site?"
 * guard, and guards against context menus, selection, dragging and zooming.
 *
 * Every API here is optional: missing support or a rejected request simply
 * shows up as `false` in `status()`. Nothing throws.
 */
import type { LockStatus, Lockdown } from '../types';
import { isAllowedTarget } from './keyboard';

// Minimal local typings: lib.dom does not (reliably) know these APIs.
interface KeyboardLockApi {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}
interface WakeLockSentinelLike extends EventTarget {
  readonly released: boolean;
  release(): Promise<void>;
}
interface WakeLockApi {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}
interface NavigatorExtras {
  keyboard?: Partial<KeyboardLockApi>;
  wakeLock?: Partial<WakeLockApi>;
  /** iOS Safari home-screen apps. */
  standalone?: boolean;
}
interface WebkitDocument {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}
interface WebkitElement {
  webkitRequestFullscreen?: (options?: FullscreenOptions) => Promise<void> | void;
}

function nav(): NavigatorExtras {
  return (typeof navigator === 'undefined' ? {} : navigator) as unknown as NavigatorExtras;
}

function mediaMatches(query: string): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(query).matches;
  } catch {
    return false;
  }
}

function fullscreenElement(): Element | null {
  const doc = document as Document & WebkitDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** Swallow a promise rejection; also tolerates non-promise returns. */
async function settle(value: unknown): Promise<boolean> {
  try {
    await value;
    return true;
  } catch {
    return false;
  }
}

export class BrowserLockdown implements Lockdown {
  private readonly root: HTMLElement;
  private readonly listeners = new Set<(status: LockStatus) => void>();
  private keyboardLocked = false;
  private wakeSentinel: WakeLockSentinelLike | null = null;
  private wakePending = false;
  /** Whether play wants the screen kept awake (re-acquired when the page becomes visible again). */
  private wantWakeLock = false;
  private confirmExit = false;
  private guardsInstalled = false;
  private lastStatusKey = '';
  /** Launched as an installed app (checked before we request fullscreen ourselves). */
  private readonly launchedInstalled: boolean;

  constructor(root: HTMLElement = document.documentElement) {
    this.root = root;
    this.launchedInstalled =
      mediaMatches('(display-mode: fullscreen)') || mediaMatches('(display-mode: standalone)') || nav().standalone === true;
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', this.onFullscreenChange);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.lastStatusKey = statusKey(this.status());
  }

  async enter(options: { lockKeyboard: boolean }): Promise<LockStatus> {
    // Fullscreen must be requested synchronously inside the user gesture, so it goes first.
    const fullscreenRequest = fullscreenElement() ? Promise.resolve(true) : this.requestFullscreen();
    this.wantWakeLock = true;
    const wake = this.acquireWakeLock();
    const fullscreen = await fullscreenRequest;

    const keyboard = nav().keyboard;
    if (options.lockKeyboard && typeof keyboard?.lock === 'function') {
      // No key list: capture everything, including Escape (holding Escape still exits).
      // The lock only takes effect in fullscreen; status() reports it as such.
      this.keyboardLocked = await settle(keyboard.lock());
      // Fullscreen was lost while we waited (toddler held Escape): drop the lock again.
      if (fullscreen && !fullscreenElement()) this.unlockKeyboard();
    } else if (!options.lockKeyboard) {
      this.unlockKeyboard();
    }

    await wake;
    this.emitIfChanged();
    return this.status();
  }

  async exit(): Promise<void> {
    this.wantWakeLock = false;
    this.unlockKeyboard();
    const sentinel = this.wakeSentinel;
    this.wakeSentinel = null;
    if (sentinel && !sentinel.released) await settle(sentinel.release());
    if (fullscreenElement()) {
      const doc = document as Document & WebkitDocument;
      if (typeof doc.exitFullscreen === 'function') await settle(doc.exitFullscreen());
      else if (typeof doc.webkitExitFullscreen === 'function') await settle(doc.webkitExitFullscreen());
    }
    this.emitIfChanged();
  }

  status(): LockStatus {
    const fullscreen = fullscreenElement() !== null;
    return {
      fullscreen,
      keyboardLocked: this.keyboardLocked && fullscreen,
      wakeLock: this.wakeSentinel !== null && !this.wakeSentinel.released,
      installed: this.launchedInstalled || mediaMatches('(display-mode: standalone)') || nav().standalone === true,
    };
  }

  onChange(listener: (status: LockStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setConfirmExit(enabled: boolean): void {
    if (enabled === this.confirmExit) return;
    this.confirmExit = enabled;
    if (enabled) window.addEventListener('beforeunload', this.onBeforeUnload);
    else window.removeEventListener('beforeunload', this.onBeforeUnload);
  }

  installGuards(): void {
    if (this.guardsInstalled) return;
    this.guardsInstalled = true;
    const active = { capture: true, passive: false } as const;
    document.addEventListener('contextmenu', preventOutsideParentUi, active);
    document.addEventListener('selectstart', preventOutsideParentUi, active);
    document.addEventListener('dragstart', preventOutsideParentUi, active);
    document.addEventListener('dblclick', preventOutsideParentUi, active);
    // Safari pinch-zoom gestures.
    document.addEventListener('gesturestart', preventAlways, active);
    document.addEventListener('gesturechange', preventAlways, active);
    // Ctrl/Cmd + wheel (and trackpad pinch, which arrives as ctrl+wheel) zooms the page.
    document.addEventListener('wheel', preventZoomWheel, active);
    document.addEventListener('touchmove', preventTouchZoomAndOverscroll, active);
  }

  private async requestFullscreen(): Promise<boolean> {
    const el = this.root as HTMLElement & WebkitElement;
    try {
      if (typeof el.requestFullscreen === 'function') {
        await el.requestFullscreen({ navigationUI: 'hide' });
        return true;
      }
      if (typeof el.webkitRequestFullscreen === 'function') {
        await el.webkitRequestFullscreen();
        // Old WebKit returns undefined and switches asynchronously; report what we know.
        return true;
      }
    } catch {
      // Denied (no user gesture, iframe without allow="fullscreen", iPhone…): play on without it.
    }
    return false;
  }

  private async acquireWakeLock(): Promise<void> {
    const wakeLock = nav().wakeLock;
    if (this.wakePending || typeof wakeLock?.request !== 'function') return;
    if (this.wakeSentinel && !this.wakeSentinel.released) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    this.wakePending = true;
    try {
      const sentinel = await wakeLock.request('screen');
      if (!this.wantWakeLock) {
        // exit() happened while we were waiting.
        await settle(sentinel.release());
        return;
      }
      this.wakeSentinel = sentinel;
      sentinel.addEventListener('release', this.onWakeRelease);
    } catch {
      // Not allowed (battery saver, permissions policy, hidden page): fine.
    } finally {
      this.wakePending = false;
    }
    this.emitIfChanged();
  }

  private unlockKeyboard(): void {
    if (!this.keyboardLocked) return;
    this.keyboardLocked = false;
    try {
      nav().keyboard?.unlock?.();
    } catch {
      // Already unlocked.
    }
  }

  private readonly onFullscreenChange = (): void => {
    // The lock only works in fullscreen; drop it so a later enter() starts clean.
    if (!fullscreenElement()) this.unlockKeyboard();
    this.emitIfChanged();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible' && this.wantWakeLock) void this.acquireWakeLock();
  };

  private readonly onWakeRelease = (e: Event): void => {
    if (e.target === this.wakeSentinel) this.wakeSentinel = null;
    this.emitIfChanged();
  };

  private readonly onBeforeUnload = (e: BeforeUnloadEvent): void => {
    e.preventDefault();
    // Legacy browsers need returnValue set to show the prompt.
    e.returnValue = '';
  };

  private emitIfChanged(): void {
    const status = this.status();
    const key = statusKey(status);
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(status);
      } catch {
        // One failing listener must not hide the change from the others.
      }
    }
  }
}

function statusKey(s: LockStatus): string {
  return `${+s.fullscreen}${+s.keyboardLocked}${+s.wakeLock}${+s.installed}`;
}

function preventAlways(e: Event): void {
  if (e.cancelable) e.preventDefault();
}

function preventOutsideParentUi(e: Event): void {
  if (e.cancelable && !isAllowedTarget(e.target)) e.preventDefault();
}

function preventZoomWheel(e: WheelEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.cancelable) e.preventDefault();
}

/**
 * Multi-finger moves (pinch zoom) are always blocked. Single-finger moves are
 * blocked only on the bare play surface (canvas / body / html) to stop
 * pull-to-refresh and overscroll bounce, so overlays and panels still scroll.
 */
function preventTouchZoomAndOverscroll(e: TouchEvent): void {
  if (!e.cancelable) return;
  if (e.touches.length > 1) {
    e.preventDefault();
    return;
  }
  const t = e.target;
  if (t instanceof HTMLCanvasElement || t === document.body || t === document.documentElement) {
    e.preventDefault();
  }
}
