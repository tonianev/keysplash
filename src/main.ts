/**
 * Entry point: builds every module, hands them to Game, and starts the frame
 * loop so the backdrop animates behind the start screen.
 *
 * Everything is bundled (fonts included); the service worker precaches the
 * build so KeySplash runs offline after the first visit.
 */
import '@fontsource/andika/400.css';
import '@fontsource/andika/700.css';
import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { WebAudioEngine } from './audio/engine';
import { WebSpeaker } from './audio/speech';
import { FONT_FAMILY, Game, reducedMotionQuery, sceneOptionsFor } from './game';
import { DomKeyboardInput } from './input/keyboard';
import { BrowserLockdown } from './input/lockdown';
import { DomPointerInput } from './input/pointer';
import { LessonContent } from './content';
import { keyMap } from './keymap';
import { LearningGames } from './modes';
import { LocalProgressStore } from './progress';
import { CanvasScene } from './render/scene';
import { CanvasStage } from './render/stage';
import { LocalSettingsStore } from './settings';
import { InstallPrompt } from './ui/install';
import { DomOverlays } from './ui/overlays';
import { DomParentPanel } from './ui/parent-panel';
import { DomPromptBar } from './ui/prompt-bar';
import { DomStartScreen } from './ui/start-screen';
import { WORLDS } from './worlds';

/** How long to wait for the glyph font before drawing with the fallback. */
const FONT_TIMEOUT_MS = 1500;

// 'beforeinstallprompt' can fire right after load: listen before anything awaits.
const install = new InstallPrompt();

/** localStorage, or null where touching it throws (sandboxed iframes, some privacy modes). */
function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Resolves once Andika is ready, or after the timeout (never rejects). */
function waitForFont(timeoutMs: number): Promise<void> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts || typeof fonts.load !== 'function') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, timeoutMs);
    const done = (): void => {
      window.clearTimeout(timer);
      resolve();
    };
    try {
      Promise.all([fonts.load('700 100px Andika'), fonts.load('400 20px Andika')]).then(done, done);
    } catch {
      done();
    }
  });
}

/**
 * Registers the service worker. With `registerType: 'autoUpdate'` the plugin
 * would reload the page the moment an update activates, which mid-play means
 * losing fullscreen (and a "Leave site?" prompt) in front of a toddler, so the
 * reload is handed to `onNeedReload` and deferred until play is back on the
 * start screen.
 */
function registerServiceWorker(onNeedReload: () => void): void {
  try {
    if (!('serviceWorker' in navigator)) return;
    // Failures (file://, private modes, old browsers) just mean no offline cache.
    registerSW({ immediate: true, onNeedReload, onRegisterError: () => undefined });
  } catch {
    // Silent: the toy works without a service worker.
  }
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('stage');
  const ui = document.getElementById('ui');
  if (!(canvas instanceof HTMLCanvasElement) || !ui) throw new Error('KeySplash: #stage canvas or #ui root missing');

  const store = new LocalSettingsStore(safeLocalStorage());
  const progress = new LocalProgressStore(safeLocalStorage());
  await waitForFont(FONT_TIMEOUT_MS);

  const settings = store.get();
  const reducedMotion = reducedMotionQuery();
  const stage = new CanvasStage(canvas);
  const scene = new CanvasScene(
    stage.ctx,
    WORLDS[settings.world],
    sceneOptionsFor(settings, !!reducedMotion?.matches, FONT_FAMILY),
  );
  scene.resize(stage.width, stage.height, stage.dpr);
  stage.onResize((width, height, dpr) => scene.resize(width, height, dpr));

  const audio = new WebAudioEngine();
  const speaker = new WebSpeaker();
  // One instance for the app's lifetime (it listens to fullscreen/visibility changes).
  const lockdown = new BrowserLockdown();
  lockdown.installGuards();
  const overlays = new DomOverlays(ui);

  const game = new Game({
    store,
    scene,
    audio,
    speaker,
    lockdown,
    keyMap,
    overlays,
    worlds: WORLDS,
    fontFamily: FONT_FAMILY,
    progress,
    games: new LearningGames(progress),
    lessons: new LessonContent(),
    setTheme: (dark) => {
      ui.dataset.theme = dark ? 'dark' : 'light';
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#141b2d' : '#f5f2ec');
    },
    createPromptBar: () => new DomPromptBar(ui),
    reducedMotion,
    viewport: () => ({ width: stage.width, height: stage.height }),
    createKeyboard: (handlers, secretWord) => new DomKeyboardInput(window, handlers, keyMap, { secretWord }),
    createPointer: (handlers) => new DomPointerInput(canvas, handlers),
    createStartScreen: (deps) => new DomStartScreen(ui, deps),
    createParentPanel: (deps) => new DomParentPanel(ui, deps),
    install: {
      canInstall: () => install.canInstall(),
      prompt: () => {
        void install.prompt();
      },
    },
  });

  let reloadWhenIdle = false;
  stage.start((dt, now) => {
    game.update(dt, now);
    scene.update(dt, now);
    scene.draw();
    if (reloadWhenIdle && game.isIdle) {
      reloadWhenIdle = false;
      window.location.reload(); // a new version is active; never mid-play
    }
  });

  registerServiceWorker(() => {
    reloadWhenIdle = true;
  });
}

boot().catch((error: unknown) => {
  console.error(error);
});
