# KeySplash

**A calm, educational keyboard toy for babies and toddlers. No ads, works offline.**

**Play it:** <https://tonianev.com/keysplash/> — in Chrome or Edge, use *Install* in the
address bar to get the cleanest fullscreen (and it then works fully offline).

You're working from home and your little one wants the laptop too. Open
KeySplash, press Start and hand it over. Every key teaches one thing: a big
flashcard with the letter, a picture and the word ("bee… bee is for ball"), a
number that counts pictures into a ten-frame out loud, a shape that says its
colour and name, or arrows that say "up", "down", "left" and "right". The same
key always shows the same thing, so repetition builds familiarity.

It is inspired by [tinyfingers.net](https://tinyfingers.net), minus the ads, the
trackers, the random flashing and the cartoon noise. The look is matte and
calm: flat tonal colours, soft shadows, gentle motion.

## What each key teaches

| Keys | Card | Voice |
| --- | --- | --- |
| A–Z | `Bb` + picture + **b**all (featured letter highlighted) | "bee… bee is for ball" (words rotate: ball → bear → banana) |
| 0–9 | numeral + pictures filling a ten-frame one by one | "one… two… three… three ducks!" |
| punctuation | a matte shape | "blue circle" (each key always the same shape and colour) |
| arrows | an arrow card that glides that way | "up!" |
| Space | a rainbow painted band by band | "red, orange, yellow, green, blue, purple" |
| Enter / Backspace | cards glide away | "all clean!" |
| everything else | a picture fixed per key (F1 → cow, F2 → pig, Shift → bee…) | "cow" |

Letters use **Andika**, a typeface designed for early readers (single-storey
*a* and *g*, distinct *b d p q*, *I l 1*). Recent cards line up on a shelf at
the bottom in the order they were typed.

## Learning games

Pick one on the start screen or in the grown-up panel:

- **Explore** (1+): free play as above.
- **Find letters** (3+): "Can you find bee?" A right key gets a soft
  celebration and the next letter. A wrong key still shows its card, plus a kind
  redirect. After two tries a mini keyboard shows where the key is; after four
  it gently pulses and the voice says where ("It is in the bottom row, in the
  middle").
- **Find numbers** (3+): the same for 0–9 (number row or numpad).
- **Spell** (4+): short picture words (cat, sun, bee, frog, moon…), one letter
  at a time.

Nobody ever loses, nothing times out, and a palm smash is celebrated rather than
marked wrong. Letters found least often come up more.

**Progress** (grown-up panel): an A–Z / 0–9 grid shows what has been seen and
what has been found in a game, plus the words spelled. It is stored on this
device only.

## Voice

KeySplash talks in a **natural built-in voice**: every line it can say (letter
names, "bee… bee is for ball", numbers and counting, colours, shapes, game
prompts and praise) is pre-recorded with the open
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) speech model and ships
with the app as small MP3 clips (~3 MB, cached for offline use). It sounds the
same on every device and needs no network.

- **On/off:** a clear *Voice on / Voice off* switch on the start screen, and the
  same switch at the top of the grown-up panel's **Voice** section. Off means
  nothing is spoken at all; notes and effects still play. Mute silences both.
- **Natural or This device:** the panel can switch to the device's own speech
  voice (Premium/Enhanced system voices are preferred automatically). Only the
  device voice can say the child's name ("Hi, Mia!"); the natural voice uses
  nameless lines ("Let's play!", "Yay!").
- **Says:** *Letter* or *Letter + word*. *▶ Hear it* plays a sample.

## Grown-up controls

- **Open the panel:** type the secret word (default `parent`) or hold the
  top-left corner for 2.5 s. On the start screen use *⚙ Grown-up settings*.
- **Settings:** voice on/off and style, activity, one-card vs where-the-key-is layout, letter
  case, pictures, world (7 calm illustrated worlds, optional auto-rotate),
  volume, soft notes, size, liveliness, motion, painting, child's name, session
  timer, secret word, keyboard lock.
- **Session timer:** colours and sound wind down gently, then a sleepy "All
  done!" screen appears. Only a press-and-hold by a grown-up continues.
- **Get out:** Stop in the panel, or hold Escape (exits keyboard-locked
  fullscreen). The OS app switcher always works.

## Toddler-proofing tips

- Use **Chrome or Edge**: in fullscreen they let KeySplash capture Escape,
  ⌘W / Ctrl+W and most shortcuts (Keyboard Lock API).
- **Install it as an app** (address bar ▸ Install) for the cleanest fullscreen.
- **macOS:** Chrome menu ▸ *Warn Before Quitting (⌘Q)*.
- **iPad:** Settings ▸ Accessibility ▸ *Guided Access* keeps it in Safari.
- A "Leave site?" guard, a screen wake lock and a big "tap to keep playing"
  button (if fullscreen is lost) are built in.

## Privacy

No network requests after load: no ads, analytics, cookies, accounts or CDNs.
Settings and progress live in `localStorage` on this device. The natural voice
is bundled audio. With *This device* selected, the browser's speech is used;
voices marked "online" in the panel send words to their provider, so the
automatic choice prefers on-device voices.

## Development

```bash
npm install
npm run dev        # dev server
npm test           # unit + integration tests (Vitest + happy-dom)
npm run typecheck
npm run build      # production build in dist/ (PWA with offline cache)
npm run preview    # serve the build
```

`/dev/art-preview.html` (dev server only) shows every backdrop, shape and arrow.

### Regenerating the voice

Change spoken wording only in `src/phrases.ts`, then run `npm run voice`. It
exports every line from `src/voice/inventory.ts`, synthesises the missing clips
with Kokoro (incremental; stale clips are removed), writes `public/voice/*.mp3`
and `src/voice/manifest.json`, and runs QA (a letter-name phoneme check that must
pass, plus a Whisper round-trip report in `tools/voice/qa-report.json`). Setup
(Python venv, espeak-ng, ffmpeg) is in [tools/voice/README.md](tools/voice/README.md).
`tests/voice-manifest.test.ts` fails if any line the app can say has no clip.

## Structure

```
src/
  types.ts            shared contracts (every module codes against these)
  game.ts             orchestrator: input → lesson → card + voice + sound; games; session
  main.ts             bootstrap
  content.ts          what each key teaches (LessonContent, word lists, helpers)
  modes.ts            learning games (Find letters / numbers, Spell)
  progress.ts         local learning progress (debounced)
  worlds.ts           7 worlds, shared light/dark tonal palettes
  settings.ts         settings, sanitising, migrations
  keymap.ts           physical key geometry, notes, hint keyboard rows
  audio/engine.ts     synthesised soft instruments + limiter
  audio/speech.ts     device speech (Web Speech) with priorities and timed sequences
  audio/clip-voice.ts natural voice: plays pre-generated clips, device fallback
  audio/voice-router.ts switches natural / device voice
  phrases.ts          every spoken line (one source of truth)
  voice/              clip inventory, key normalisation, generated manifest
  render/scene.ts     flashcard stage (focus shelf / keyboard layout)
  render/cards.ts     card layout + pre-rendered card sprites
  render/matte.ts     matte particles, ripples, painting, rainbow
  render/backgrounds.ts, shapes.ts, stage.ts, color.ts, lru.ts, easing.ts
  input/              keyboard (smash + secret word), pointer, lockdown
  ui/                 start screen, grown-up panel, prompt bar, overlays, install
```

See [DESIGN.md](DESIGN.md) for the design brief and [SPEC.md](SPEC.md) for
behaviour and safety rules.

## Deploying

`npm run build` produces a static site in `dist/` that works from any static
host or sub-path. Every push to `main` runs the tests, builds and deploys to
GitHub Pages via `.github/workflows/deploy.yml` (live at
<https://tonianev.com/keysplash/>).

## Credits

Andika by SIL International (SIL Open Font License). Natural voice generated
with Kokoro-82M by hexgrad (Apache-2.0), voice `af_heart`. Inspired by
tinyfingers.net.
