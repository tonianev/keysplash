/**
 * PWA install helper.
 *
 * Chromium browsers fire `beforeinstallprompt` once the app is installable. We
 * stash the event (so the browser doesn't show its own mini-infobar) and let
 * the parent panel offer an "Install app" button that replays it on demand.
 * Construct this early in main.ts: the event can fire right after load.
 */

/** Not in lib.dom yet. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform?: string }>;
}

export class InstallPrompt {
  private deferred: BeforeInstallPromptEvent | null = null;
  private installed = false;
  private readonly listeners = new Set<() => void>();
  private readonly target: Window | null;

  /** `target` is only for tests; defaults to the global window. */
  constructor(target?: Window | null) {
    this.target = target ?? (typeof window === 'undefined' ? null : window);
    this.target?.addEventListener('beforeinstallprompt', this.onBeforeInstall);
    this.target?.addEventListener('appinstalled', this.onInstalled);
  }

  canInstall(): boolean {
    return this.deferred !== null && !this.installed;
  }

  /**
   * Shows the browser's install dialog. Call from a click handler.
   * Resolves true when the user accepted. The stashed event is single-use.
   */
  async prompt(): Promise<boolean> {
    const event = this.deferred;
    if (!event || this.installed) return false;
    this.deferred = null;
    this.emit();
    try {
      await event.prompt();
      const choice = await event.userChoice;
      return choice.outcome === 'accepted';
    } catch {
      return false;
    }
  }

  /** Fires when installability changes. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    this.target?.removeEventListener('beforeinstallprompt', this.onBeforeInstall);
    this.target?.removeEventListener('appinstalled', this.onInstalled);
    this.listeners.clear();
  }

  private readonly onBeforeInstall = (event: Event): void => {
    event.preventDefault();
    this.deferred = event as BeforeInstallPromptEvent;
    this.emit();
  };

  private readonly onInstalled = (): void => {
    this.installed = true;
    this.deferred = null;
    this.emit();
  };

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
