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
export function sanitizeSettings(raw: unknown): Settings;      // never throws; clamps/whitelists every field
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

### Audio — `src/audio/engine.ts`, `src/audio/speech.ts`
```ts
export class WebAudioEngine implements AudioEngine { constructor(); }
export class WebSpeaker implements Speaker { constructor(synth?: SpeechSynthesis | null); }
```

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
  resize(width: number, height: number, dpr: number): void;
  update(dt: number, now: number, calm: number): void;
  draw(ctx: CanvasRenderingContext2D): void;      // paints the full viewport (CSS px coordinates)
}
export function createBackdrop(world: World, options: { reduceMotion: boolean }): Backdrop;
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
export class SmashDetector { constructor(windowMs?: number, threshold?: number); push(code: string, time: number): string[] | null; }
export class SecretWordDetector { constructor(word: string); setWord(word: string): void; push(key: string): boolean; }
export class DomPointerInput implements PointerInput {
  constructor(el: HTMLElement, handlers: PointerHandlers, options?: { cornerSize?: number; cornerHoldMs?: number });
}
export class BrowserLockdown implements Lockdown { constructor(root?: HTMLElement); }
```

### UI — `index.html`, `src/styles.css`, `src/ui/start-screen.ts`, `parent-panel.ts`, `overlays.ts`, `install.ts`, `public/*`, `README.md`
```ts
export class DomStartScreen implements StartScreen { constructor(root: HTMLElement, deps: StartScreenDeps); }
export class DomParentPanel implements ParentPanel { constructor(root: HTMLElement, deps: ParentPanelDeps); }
export class DomOverlays implements Overlays { constructor(root: HTMLElement); }
export class InstallPrompt { constructor(); canInstall(): boolean; prompt(): Promise<boolean>; onChange(listener: () => void): () => void; }
```

### Orchestrator — `src/game.ts`, `src/main.ts` (written last, by the integrator)

## Behaviour spec (what the integrator wires)

**Key press (not repeat)** → `contentForKey` →
- position: if `spatialKeys` and the key has a position, map it into the safe
  area (10% margins) with ±4% jitter; otherwise random, avoiding the last 3 spots.
- letter → `spawnGlyph({ text: display, emoji: pictures ? word.emoji : null, caption: speech==='word' ? word.word : null })` + burst + `note(keyMap.note(code, world.rootMidi), pan=x)` + `say(speak)`.
- digit → `spawnGlyph({ count: digit, emoji: countEmoji })` + note + say.
- shape → `spawnShape` + note + say. emoji → `spawnEmoji` + `boing`.
- special → `scene.special(effect)` + matching sound (`rainbow`→chord+sparkle,
  `sweep`→whoosh, `pop-all`→pop, comets→swoosh, `fireworks`→tada).
**Repeat** (key held): ≤ 8/s, a small burst + quiet `twinkle` at the key spot. No glyph, no speech.
**Smash** (≥ 4 distinct keys within 90 ms): `special('fireworks', center)` +
rising chord + `say(cheer())`. Speech of the individual keys in that smash is suppressed.
**Tap**: `poke()` first — if it hits, replay that object's note/word; else
`contentForTap` at the point + ripple + note by x position.
**Drag**: trail + a note every ~90 px travelled (pitch by y: higher on screen = higher note).
**Hover (mouse)**: trail only when `trails` is on; silent.
**Corner hold / secret word** → parent panel (inputs disabled while open).
**Idle** (no input 20 s): every ~4 s a world friend drifts across softly (silent) until input.
**Session timer**: after `sessionMinutes` of play, 45 s wind-down (`setCalm` 0→1,
`fadeTo(0.25)`), then `showAllDone` (parent-gated resume). Keys do nothing then
except the secret word.
**Auto-rotate**: every `rotateMinutes` of play → `nextWorld`, `setWorld`, `setTimbre`.
**Fullscreen lost while playing** (and it had been granted) → `showResume`.
**Child name**: start screen greets them; every ~40 key presses or on Enter, say "Yay, {name}!".
**Object cap** lives in the scene (calm 10 / normal 22 / wild 36): over the cap, the oldest fade out fast.
