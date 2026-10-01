# KeySplash — product & architecture spec

A fullscreen keyboard-smash toy for babies and toddlers (ages ~1–5), built so a
parent working from home can hand over the laptop safely. Inspired by
tinyfingers.net but much better:

| tinyfingers.net | KeySplash |
| --- | --- |
| ~90 ad/tracking scripts (Ezoic, Amazon, GPT, ID5, LiveRamp…) | **Zero** network requests after load. No ads, analytics, cookies, accounts |
| Needs the network | **Installable PWA, fully offline** |
| Random letters/images, generic sounds | Every key is consistent: **same key → same colour, same musical note, same spot on screen** (cause-and-effect learning). Notes are pentatonic, so any smash sounds musical |
| Letters only | Letters **with pictures and spoken words** ("A… apple!"), numbers that **count** (3 → three ducks pop in one by one), shapes with **colour + shape names** ("Blue star!") |
| Escape / Cmd+W can end play | **Keyboard Lock API** in fullscreen, swallowed shortcuts, "Leave site?" guard, wake lock, fullscreen-lost recovery screen |
| | **Palm smash** detection → fireworks + chord (smashing is rewarded, not chaos) |
| | Tap/poke existing objects to make them jiggle and repeat their sound |
| | Finger/mouse **painting trails** that play notes |
| | **Session timer** with a gentle wind-down to a sleepy "All done!" screen |
| | Hard audio **limiter** (protects little ears), photosensitivity-safe effects, reduced motion |
| | 7 worlds with their own art, particles, instrument and physics |

## Non-negotiables

1. **No network.** No CDNs, no fonts from Google, no analytics, no external
   URLs at runtime. Everything is bundled (font comes from `@fontsource/fredoka`).
2. **Never trap a parent.** The parent can always: type the secret word
   (default `parent`), hold the top-left corner for 2.5 s, or hold Escape
   (browser-native exit from keyboard-locked fullscreen). The OS app switcher
   still works.
3. **Safe for little bodies.** Master gain ≤ ~0.8 through a limiter; no
   full-screen flashes; no luminance changes faster than 3 Hz over large areas;
   honour `prefers-reduced-motion` (when `motion` setting is `system`).
4. **Smooth under abuse.** A toddler mashing 10 keys at 20 Hz for minutes must
   stay at 60 fps with bounded memory: object caps, pooled particles,
   pre-rendered sprites, no per-frame allocations in hot loops, no unbounded
   arrays/queues, no stacking speech.
5. **No text a toddler must read.** Parent UI may have text; play UI is visual.

## Tech

Vite 8 + TypeScript (strict, `verbatimModuleSyntax` → use `import type`),
Canvas 2D, Web Audio, Web Speech, vanilla DOM. `vite-plugin-pwa` for the
service worker + manifest. Vitest + happy-dom for unit tests in `tests/`.
**Do not add npm dependencies.** All contracts live in `src/types.ts`.

## DOM structure (index.html)

```html
<canvas id="stage"></canvas>   <!-- full viewport, the play surface; pointer input attaches here -->
<div id="ui"></div>            <!-- overlay root; UI classes append their own elements -->
```

## Module map & ownership

Every module exports a concrete class/const with exactly these names and
constructor signatures (the orchestrator relies on them):

### Logic — `src/settings.ts`, `src/worlds.ts`, `src/content.ts`, `src/keymap.ts`
```ts
// settings.ts
export const DEFAULT_SETTINGS: Settings;
export function sanitizeSettings(raw: unknown, fallback?: Settings): Settings; // never throws; clamps/whitelists every field;
                                                               // invalid/missing fields take fallback's value (default DEFAULT_SETTINGS;
                                                               // store.update passes the current settings, so a bad patch never resets a field)
export class LocalSettingsStore implements SettingsStore {
  constructor(storage?: Storage | null, key?: string);         // default key 'keysplash:settings:v1'; storage may throw → in-memory
}
// worlds.ts
export const WORLDS: Record<WorldId, World>;
export const WORLD_ORDER: WorldId[];
export function nextWorld(id: WorldId): WorldId;
// content.ts
export function contentForKey(press: { code: string; key: string }, ctx: ContentContext): KeyContent;
export function contentForTap(ctx: ContentContext): KeyContent; // shape or world-friend emoji
export function cheer(rng: () => number): string;               // 'Wow!', 'Whee!', 'Boom!', 'Yay!'…
export function numberWord(n: number): string;                  // 0..10 → 'zero'…'ten'
export function shapeLabel(shape: ShapeKind): string;           // 'star', 'heart'…
export const BASE_WORDS: Record<string, WordEntry[]>;           // 'A'…'Z', 2–3 kid words each
// keymap.ts
export const keyMap: KeyMap;
export function pentatonic(rootMidi: number, step: number): number; // major pentatonic, step may exceed 5 (wraps octaves)
```

- `keyMap.note` keeps notes in MIDI 45..96 by **folding whole octaves** (a hard
  clamp would land off the scale); every note is in the world's pentatonic scale.
- `contentForKey` takes the letter from `KeyboardEvent.key` when it is a plain
  a–z letter (AZERTY/QWERTZ show what is printed on the keycap), otherwise from
  `code` (Cyrillic, Greek… fall back to the physical key). Position and note
  always come from `code`.

### Audio — `src/audio/engine.ts`, `src/audio/speech.ts`
```ts
export class WebAudioEngine implements AudioEngine { constructor(); }
export class WebSpeaker implements Speaker { constructor(synth?: SpeechSynthesis | null); }
```

- `AudioEngine.setRoot(rootMidi)` keys the melodic effects (sparkle, twinkle,
  chime, tada) to the world's pentatonic scale; the orchestrator calls it with
  `setTimbre` on every world change.
- `Speaker.voices()` marks network voices with `local: false` (they send text to
  a server and fail offline). Automatic voice choice prefers on-device voices.

### Render core — `src/render/stage.ts`, `scene.ts`, `sprites.ts`, `entities.ts`, `particles.ts`, `effects.ts`, `easing.ts`, `color.ts`
```ts
export class CanvasStage implements Stage { constructor(canvas: HTMLCanvasElement); } // DPR capped at 2
export class CanvasScene implements Scene {
  constructor(ctx: CanvasRenderingContext2D, world: World, options: SceneOptions);
}
```

### Render art — `src/render/backgrounds.ts`, `src/render/shapes.ts`
```ts
// backgrounds.ts
export interface Backdrop {
  resize(width: number, height: number, dpr: number): void; // pre-renders; no-op when unchanged; never per frame
  update(dt: number, now: number, calm: number): void;      // own clock (slowed by calm); `now` is unused
  draw(ctx: CanvasRenderingContext2D): void;      // paints the full viewport (CSS px coordinates), opaque,
                                                  // multiplying the caller's ctx.globalAlpha into everything
                                                  // (the scene cross-fades worlds this way)
}
export function createBackdrop(world: World, options: { reduceMotion: boolean }): Backdrop; // reduceMotion is fixed at creation
// No dispose(): offscreen canvases are freed by GC once the scene drops a backdrop.
// shapes.ts — paths are centred on (0,0) and fit inside a circle of radius `r`
export function traceShape(ctx: CanvasRenderingContext2D, shape: ShapeKind, r: number): void; // beginPath + path, no fill
export function drawShape(ctx: CanvasRenderingContext2D, shape: ShapeKind, r: number, color: NamedColor, dark: boolean): void; // gradient fill + outline
export function drawFace(ctx: CanvasRenderingContext2D, shape: ShapeKind, r: number, blink: number, mood: 'smile' | 'oh'): void; // blink 0 open … 1 closed
```

### Input — `src/input/keyboard.ts`, `pointer.ts`, `lockdown.ts`
```ts
export class DomKeyboardInput implements KeyboardInput {
  constructor(target: Window, handlers: KeyboardHandlers, keyMap: KeyMap,
              options?: { secretWord?: string; smashWindowMs?: number; smashThreshold?: number });
}
// Swallows every key (window, capture phase) except inside [data-allow-keys] or form
// fields, so any grown-up control that needs keys must carry data-allow-keys.
// Smash order: the first threshold-1 keys of a palm fire onKey (nobody can know yet);
// the completing key fires onSmash instead; keys in the next 450 ms fire nothing.
export class SmashDetector { constructor(windowMs?: number, threshold?: number); push(code: string, time: number): string[] | null; }
export class SecretWordDetector { constructor(word: string); setWord(word: string): void; push(key: string): boolean; }
export class DomPointerInput implements PointerInput {
  constructor(el: HTMLElement, handlers: PointerHandlers, options?: { cornerSize?: number; cornerHoldMs?: number });
}
export class BrowserLockdown implements Lockdown { constructor(root?: HTMLElement); } // one instance per app lifetime
```

`DomPointerInput.setEnabled(false)` drops active pointers without `onRelease`;
the orchestrator ends their trails itself.

### UI — `index.html`, `src/styles.css`, `src/ui/start-screen.ts`, `parent-panel.ts`, `overlays.ts`, `install.ts`, `public/*`, `README.md`
```ts
export class DomStartScreen implements StartScreen { constructor(root: HTMLElement, deps: StartScreenDeps); }
export class DomParentPanel implements ParentPanel { constructor(root: HTMLElement, deps: ParentPanelDeps); }
export class DomOverlays implements Overlays { constructor(root: HTMLElement); }
export class InstallPrompt { constructor(); canInstall(): boolean; prompt(): Promise<boolean>; onChange(listener: () => void): () => void; }
```

`StartScreenDeps.onOpenControls?()` adds a small "Grown-up settings" link to the
start screen; resuming a panel opened there stays on the start screen.

### Orchestrator — `src/game.ts`, `src/main.ts` (written last, by the integrator)
```ts
export class Game {
  constructor(deps: GameDeps); // store, scene, audio, speaker, lockdown, keyMap, overlays, viewport(),
                               // createKeyboard/createPointer/createStartScreen/createParentPanel factories
                               // (they need Game's handlers), optional install, fontFamily, rng, now,
                               // wallClock, reducedMotion query and visibility source (injectable for tests)
  start(): void;               // from the start screen's gesture
  stop(): void;
  update(dt: number, now: number): void; // per frame, before scene.update
  getStats(): SessionStats;
  readonly playState: 'idle' | 'playing' | 'alldone';
  readonly isIdle: boolean;    // start screen, no panel: safe to reload for an app update
}
export function sceneOptionsFor(settings: Settings, systemReduce: boolean, fontFamily?: string): SceneOptions;
```
`main.ts` imports the Fredoka CSS + styles, builds every module, waits for
Fredoka 700 (≤ 1.5 s), constructs the scene and Game, starts the stage loop
(backdrop animates behind the start screen), installs the lockdown guards and
registers the service worker. With `registerType: 'autoUpdate'` an activated
update would reload the page mid-play, so `onNeedReload` defers the reload
until `game.isIdle`.

## Behaviour spec (what the integrator wires)

**Key press (not repeat)** → `contentForKey` →
- position: if `spatialKeys` and the key has a position, map it into the safe
  area (10% margins) with ±4% jitter; otherwise random, avoiding the last 3 spots.
- letter → `spawnGlyph({ text: display, emoji: pictures ? word.emoji : null, caption: speech==='word' ? word.word : null })` + burst + `note(keyMap.note(code, world.rootMidi), pan=x)` + `say(speak)`.
- digit → `spawnGlyph({ count: digit, emoji: countEmoji })` + note + say.
- shape → `spawnShape` + note + say. emoji → `spawnEmoji` + `boing`.
- special → `scene.special(effect)` + matching sound (`rainbow`→chord+sparkle,
  `sweep`→whoosh, `pop-all`→pop, comets→swoosh, `fireworks`→tada).
**Notes off** (`settings.notes` false): key/tap/drag notes become soft effects (pop/bubble); chords are skipped.
**Repeat** (key held): ≤ 8/s, a small burst + quiet `twinkle` at the key spot. No glyph, no speech.
**Smash** (≥ 4 distinct keys within 90 ms): `special('fireworks', center)` +
rising chord + `say(cheer(), 'high')`. Speech of the individual keys in that
smash is suppressed: keys < 90 ms after the previous key never speak, the
high-priority cheer cuts off the first key's word, and nothing speaks for 450 ms.
**Tap**: `poke()` first — if it hits, replay that object's note/word; else
`contentForTap` at the point + ripple + note by x position.
**Drag**: trail (when `trails` is on) + a note every ~90 px travelled (pitch by y: higher on screen = higher note).
**Hover (mouse)**: trail only when `trails` is on; silent.
**Corner hold / secret word** → parent panel (inputs disabled while open; "Keep
playing" re-enables them and re-requests fullscreen if it was lost; a failure
without a gesture, e.g. Escape, falls back to the resume screen).
**Idle** (no input 20 s): every ~4 s a world friend drifts across softly (silent) until input.
**Session timer**: after `sessionMinutes` of play, 45 s wind-down (`setCalm` 0→1,
`fadeTo(0.25)`), then `showAllDone` (parent-gated resume). Keys do nothing then
except the secret word.
**Auto-rotate**: every `rotateMinutes` of play → `nextWorld` via `store.update`
(so the panel and the next launch agree), which applies `setWorld`, `setTimbre`, `setRoot`.
**Fullscreen lost while playing** (and it had been granted, and not because the
parent pressed Stop) → `showResume`; its tap/key calls `lockdown.enter`.
**Page hidden**: speech cancelled, audio faded out; play time and timers pause.
**Play time** (stats, session timer, rotation) counts only while playing, visible and with the panel closed.
**Child name**: start screen greets them; every ~40 key presses or on Enter, say "Yay, {name}!".
**Object cap** lives in the scene (calm 10 / normal 22 / wild 36): over the cap, the oldest fade out fast.
