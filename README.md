# KeySplash

**A fullscreen keyboard-smash toy for babies and toddlers. No ads, works offline.**

You're working from home and your toddler wants the laptop too. Open KeySplash,
press Play and hand it over. Every key makes something happen: a big friendly
letter with a picture and a spoken word, a number that counts ducks onto the
screen, a coloured shape that says its name, or fireworks when a whole palm lands on the keys.
The same key always gives the same colour, note and place on screen, so little
ones learn cause and effect while they bang away. It's inspired by
[tinyfingers.net](https://tinyfingers.net), minus the ads and trackers. It runs
offline, installs as an app, and tries hard to keep small hands away from your work.

## Features

- **No network at all.** No ads, analytics, cookies or accounts. After the first
  load, KeySplash is an installable PWA that runs fully offline.
- **Cause and effect.** Each key keeps its own colour, musical note and spot on
  screen. Notes come from a pentatonic scale, so even random mashing sounds musical.
- **Letters, numbers, shapes.** "A… apple!" with a picture, 3 → three ducks
  popping in one by one, and "Blue star!" for shapes.
- **Smashing is rewarded.** A palm smash sets off fireworks and a chord.
- **Touch and mouse.** Tap things to make them jiggle and play their sound
  again, and drag a finger to paint sparkly trails that play notes.
- **Seven worlds.** Outer Space, Under the Sea, Garden, Party, Bath Bubbles,
  Dino Land and Night Sky. Each has its own art, particles, instrument and
  physics, and they can rotate automatically.
- **Session timer.** When time is up, sounds and colours fade gently to a sleepy
  "All done!" screen. Only a grown-up can carry on from there.
- **Toddler-proofing.** Fullscreen plus the Keyboard Lock API (Chrome/Edge),
  swallowed shortcuts, a "Leave site?" guard, a screen wake lock and a
  "tap to keep playing" screen if fullscreen is lost.
- **Gentle on little ones.** A hard audio limiter, no full-screen flashes, and
  support for reduced motion.

## Quick start

```bash
npm install
npm run dev       # start the dev server (prints a localhost URL)
npm test          # unit tests (Vitest + happy-dom)
npm run build     # type-check, then build the static site into dist/
npm run preview   # serve dist/ locally, with the service worker active
```

`npm run icons` regenerates the PNG app icons from `public/logo.svg`.

## Grown-up controls

KeySplash has no visible buttons during play, so a child can't wander into
settings. Grown-ups have three ways out:

- **Type the secret word** at any time. The default is `parent`, and you can
  change it in the panel to 4–16 letters.
- **Hold the top-left corner** of the screen for about 2.5 seconds with a mouse
  or finger. A ring fills up while you hold.
- **Hold Escape.** With Keyboard Lock active, a quick tap on Escape does
  nothing, but holding it exits fullscreen (this is built into the browser).
  If the child somehow leaves fullscreen, a big ▶ screen lets play continue
  with one tap.

The first two open the **grown-up panel**. Before play starts, the
**⚙️ Grown-up settings** link on the start screen opens it too. From there you can pick a world or
turn on auto-rotation, set volume, notes and speech (off, letters or words) and
choose a voice. You can also change letter case, pictures, size, intensity,
motion, trails and faces, add your child's name, set the session timer, and
change the secret word and lock options. It also shows live lock status and
the stats for the current session. Every change saves instantly.

## Toddler-proofing tips

- **Use Chrome or Edge.** In fullscreen, their Keyboard Lock keeps Escape,
  ⌘W / Ctrl+W and similar shortcuts inside the game. Other browsers still work,
  just with less protection.
- **Install it as an app.** Use the install icon in the address bar, or
  "Install app" in the grown-up panel. The app opens straight into fullscreen,
  with no tabs to close.
- **macOS:** in Chrome, open the Chrome menu and turn on **"Warn Before
  Quitting"**. ⌘Q then needs a long press.
- **iPad:** go to Settings ▸ Accessibility ▸ **Guided Access** and turn it on,
  then triple-click the side button in KeySplash to lock the iPad to it.
- **Some shortcuts can never be blocked**, and that's on purpose: the OS app
  switcher (⌘Tab / Alt+Tab), Spotlight, the Windows key and Ctrl+Alt+Del. A
  grown-up always has a way out. If little hands find them, consider turning off
  hot corners and trackpad gestures while they play.

## Privacy

- KeySplash makes **no network requests** after it loads. That means no
  analytics, no ads, no third-party fonts and no CDNs. The Fredoka font is
  bundled with the app.
- **Nothing leaves your device.** Settings, including your child's name if you
  add one, are saved only in this browser's `localStorage`.
- Speech uses your device's built-in voices through the Web Speech API.
  "Automatic" prefers on-device voices. If you pick an online voice (such as
  "Google …" in Chrome), the browser sends each spoken word to that voice's provider.

## Project structure

```
index.html              canvas#stage (play surface) + div#ui (DOM overlays)
src/
  main.ts, game.ts      orchestrator: wires everything below together
  types.ts              shared contracts every module codes against
  settings.ts           defaults, sanitising, localStorage-backed store
  worlds.ts             the seven worlds (art, palette, instrument, physics)
  content.ts            what a key press means (letter / digit / shape / emoji / special)
  keymap.ts             physical key → screen position and pentatonic note
  audio/engine.ts       Web Audio synth, effects, limiter
  audio/speech.ts       Web Speech wrapper (no stacking, voice choice)
  input/keyboard.ts     key presses, palm-smash and secret-word detection
  input/pointer.ts      taps, drags, hover, corner hold
  input/lockdown.ts     fullscreen, Keyboard Lock, wake lock, guards
  render/               canvas stage, scene, sprites, particles, effects, backdrops, shapes
  ui/start-screen.ts    title, Play button, world picker, grown-up hints
  ui/parent-panel.ts    grown-up controls dialog
  ui/overlays.ts        "All done!", tap-to-resume, corner ring, toasts
  ui/install.ts         PWA install prompt
  styles.css            global styles and all overlay styling
public/                 favicon, logo and generated app icons
tests/                  Vitest unit tests
```

## Deploying

`npm run build` writes a fully static site to `dist/`. It uses relative paths,
so you can host it anywhere, including a sub-path (GitHub Pages, Cloudflare
Pages, Netlify or any static file server). The service worker precaches
everything, so the app keeps working offline after the first visit.

The repository includes a GitHub Pages workflow. To turn it on, go to
**Settings ▸ Pages ▸ Source: GitHub Actions** and push to the default branch.

## Credits

- [Fredoka](https://fonts.google.com/specimen/Fredoka) by Milena Brandão and Hafontia,
  licensed under the SIL Open Font License 1.1 and bundled via `@fontsource/fredoka`.
- Inspired by [tinyfingers.net](https://tinyfingers.net).
