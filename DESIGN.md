# KeySplash v2 — design brief: *learn through play, matte and polished*

The parent's direction: **"educational, not just random bright sounds and
flashing lights — matte colours, polished like Google or Apple designed it."**

This brief replaces every earlier visual/sound decision that conflicts with it
(glow, gloss, sparkles, fireworks, neon, cartoon boings, random emoji). Where
SPEC.md and this file disagree, this file wins.

## 1. Principles

1. **Every press teaches one thing.** A key press shows one clear flashcard and
   says one clear thing. No randomness a child can't learn from: the same key
   always gives the same letter, colour, note, word set and picture.
2. **Calm is premium.** Motion is short, damped and purposeful (Apple-style
   springs, no wobble or spin). Nothing flashes, glows, strobes or shakes.
   Celebration is a soft confetti fall and a warm three-note phrase — not
   fireworks.
3. **Matte, flat, tonal.** Material-3-style tonal colour: flat fills, no
   gradients on objects, no gloss highlights, no additive blending, no neon.
   Depth comes only from soft, low-opacity layered shadows (elevation).
4. **Legible first.** Letterforms a preschooler learns to write: **Andika**
   (SIL, built for literacy: single-storey a and g, distinct b/d/p/q, I/l/1).
   Big, high-contrast ink on tinted cards.
5. **Sound supports meaning.** Speech is the main voice. Notes are soft and
   warm (felt piano, marimba, kalimba), quiet under the words, always in a
   pentatonic scale. No cartoon sound effects; nothing that sounds like
   "wrong".
6. **Toddler-proof, parent-friendly.** Everything from v1's safety work stays:
   lockdown, secret word, corner hold, limiter, reduced motion, offline, no
   tracking.

## 2. Visual language

### Colour
Each world defines 6–8 `NamedColor`s with three tones (see `src/types.ts`):
- `hex` — the colour itself, matte and mid-saturation (think Material tone ~50–60,
  Apple system colours slightly desaturated). Used for shapes, confetti,
  rainbow bands and paint strokes.
- `container` — the card surface tinted with that colour (light worlds:
  tone ~92–95 pastel; dark worlds: deep tone ~25–30).
- `ink` — glyphs and highlighted text on the container (light worlds: tone
  ~35–40; dark worlds: tone ~85–90). Contrast ink vs container ≥ 4.5:1.

Reference light palette (Paper world; tune per world):

| name | hex | container | ink |
| --- | --- | --- | --- |
| red | `#E0604F` | `#FCE4E0` | `#A3291C` |
| orange | `#EE8A3C` | `#FDE9D6` | `#9A4A0C` |
| yellow | `#E9B730` | `#FBF0CC` | `#7A5800` |
| green | `#4FA66A` | `#DDF1E2` | `#1F6B37` |
| blue | `#4A86D8` | `#DFEAFB` | `#1D4F99` |
| purple | `#8B6CD1` | `#ECE5FA` | `#56389A` |
| pink | `#DE6FA1` | `#FBE3EE` | `#9C2D63` |
| brown | `#A07452` | `#F1E6DC` | `#6A4527` |

Neutrals (light): background paper `#F5F2EC`, surface `#FFFFFF`, onSurface
`#1F2328`, secondary text `#5B616B`, hairline `rgba(31,35,40,0.08)`.
Dark worlds (Space, Night): background deep navy `#141B2D`→`#0F1424`, surface
`#1E2740`, onSurface `#EEF1F7`.

### Elevation (the only "depth")
- Card: `0 1px 2px rgba(20,24,32,.06), 0 6px 16px rgba(20,24,32,.08), 0 18px 40px rgba(20,24,32,.08)` (light); on dark worlds use black at higher alpha and a 1 px top hairline `rgba(255,255,255,.06)`.
- Canvas cards emulate this with 2–3 pre-rendered blurred shadow layers baked into the card sprite (never per-frame `shadowBlur`).
- Corner radius: continuous, generous — ~14% of card width ("squircle"
  feel). Shapes have softly rounded corners.

### Typography
- Kid-facing (cards, prompt bar, start screen title): **Andika** 700 (glyphs,
  words), 400 for secondary. Bundled via `@fontsource/andika`.
- Grown-up UI (panel, tips, toasts): the platform system font —
  `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` (SF Pro on Mac,
  Roboto on Android — native and polished).

### Motion
- Card in: scale 0.92 → 1, opacity 0 → 1, translateY 12 px → 0 over ~320 ms
  with a critically-damped spring (no overshoot > 2%).
- Card to shelf: ~360 ms ease-in-out to its thumbnail slot.
- Card out / clear: fade + slide 24 px over ~280 ms.
- Celebrate: the centre card does one soft hop (8 px, 300 ms), 18–30 matte
  confetti pieces drift down over ~1.8 s.
- Taps: a soft ring + a small shape that settles; no explosions.
- Idle friends drift slowly across.
- `reduceMotion`: opacity cross-fades only, no travel, no confetti.

### Backdrops (one per world) — flat, layered, quiet
Flat vector-style illustration with 2–4 tonal layers, low contrast so cards
dominate. Minimal motion (slow cloud/wave drift ≤ 8 px/s, no twinkle strobe).
- **Paper** (default, light): warm off-white paper with a very subtle grain,
  a few large soft pastel geometric shapes (circle, arch, rounded square)
  resting at the edges — like a Google illustration.
- **Garden**: pale sky, 2–3 layers of soft green rolling hills, a flat matte
  sun disc, a couple of slowly drifting flat clouds, tiny flat flowers.
- **Ocean**: layered flat waves in muted blues (lighter at top), slow
  horizontal drift, a few flat bubbles rising slowly, sandy band at bottom.
- **Space** (dark): deep matte navy, small static dots for stars (very gentle
  opacity breathing ≤ 0.2 Hz on a few), one flat ringed planet, one flat moon.
- **Jungle**: layered flat leaf silhouettes in muted greens, warm haze,
  distant flat volcano.
- **Snow** (light): pale blue-white, soft rounded snow hills, slow flat snowflakes.
- **Night** (dark, calmest): deep blue, flat crescent moon, few still stars,
  soft hills.

## 3. The flashcard

A rounded card on the canvas. Light worlds: `color.container` surface; picture
and direction cards use `world.surface`. Layout (focus layout, centre card):

```
┌──────────────────────────────┐
│                         ⚽    │  ← picture (top-right, ~34% of card height) — letters
│        B b                   │  ← glyph(s) in color.ink, Andika 700, ~55% of card height
│                              │
│        ball                  │  ← word, onSurface/ink, the featured letter in color.ink
└──────────────────────────────┘     (highlight range), Andika 700 ~14% height
```
- **Letter**: glyph(s) large; picture top-right; word bottom with the featured
  letter tinted (e.g. **b**all, fo**x**).
- **Digit**: the numeral large on the left; on the right a **ten-frame** (2 rows
  × 5 cells, hairline cell outlines) where `count` pictures appear one by one
  every `TIMING.countStepMs`, each with a soft pop; word bottom: "3 stars".
- **Shape**: the shape large and matte (`color.hex`, soft rim), word "blue
  circle" with "blue" tinted.
- **Picture**: big emoji centred, word bottom ("cow").
- **Direction**: big rounded arrow in `color.hex`, word ("up"); the card glides
  ~6% of the screen in that direction and back.
- Card size (focus, centre): width ≈ min(62% of viewport width, 92% × height)
  × size factor (normal 0.8, big 0.92, huge 1.0), aspect ~ 4:3; digit cards may
  be wider (16:9).
- **Shelf** (focus layout): the previous centre cards shrink into a row of
  thumbnails along the bottom (newest nearest the centre-left, max 6, older
  ones fade out). Shelf cards stay pokeable.
- **Keyboard layout**: cards (~45% of the focus size) appear where the key
  sits; overlapping cards push apart softly (separation); max cards by
  intensity (calm 6 / normal 10 / lively 16), oldest fade out first.
- **Fast presses**: the new card replaces the centre card immediately (the
  old one heads to the shelf); during a smash, extra keys become small
  cards on the shelf only.

## 4. Education model

- **Letters**: speech 'letter' → letter name ("bee"); 'word' → "bee… bee is
  for ball" (phonetic letter names so TTS pronounces them). Word lists are
  toddler-familiar nouns with clear pictures; the featured letter is
  highlighted (usually the first letter). Same key → same colour & note; the
  word rotates through that letter's list in order (not random) so repetition
  builds familiarity.
- **Numbers**: pictures appear one at a time in a ten-frame while the numbers
  are counted aloud in step ("one… two… three…") then "three stars!" (0 →
  "zero — none!"). A new press during counting replaces it.
- **Shapes & colours** (punctuation keys): "blue circle". Each key always gives
  the same shape and colour.
- **Directions** (arrow keys): "up", "down", "left", "right" with an arrow card
  that moves that way.
- **Rainbow** (Space): bands paint in one at a time while the colour names are
  said ("red, orange, yellow, green, blue, purple"). Ignore Space while one is
  painting.
- **Clear** (Enter / Backspace / Delete): cards glide away; "all clean!".
- **Everything else** (modifiers, F-keys, Tab, Esc…): a **consistent picture
  per key** — farm & home animals/objects (F1 cow, F2 pig…) with the word
  spoken. No random emoji anywhere.
- **Taps**: a matte shape at the touch point; its colour+shape spoken every
  ~3rd tap. Tapping a card replays its word/count.
- **Painting**: drag to paint soft matte strokes (one palette colour per
  stroke, rotating stroke to stroke), slowly fading; notes by height.

### Learning games (Settings → mode; also on the start screen)
| Mode | Ages | How it works |
| --- | --- | --- |
| **Explore** | 1+ | Free play as above. |
| **Find letters** | 3+ | Prompt bar: "Can you find **B**?" with its picture. Right key → celebrate, "Yes! That's bee!", next letter after ~1.2 s. Wrong key → its card still shows (small), gentle redirect "That's em. Can you find bee?" (rate-limited). After 2 wrong → mini keyboard shows where B is; after 4 → it pulses and the voice says where ("It's in the middle row"). Targets cycle so every letter comes up; letters found less often come up more (uses progress). |
| **Find numbers** | 3+ | Same with 0–9 (number row and numpad both count). |
| **Spell** | 4+ | A 3–4-letter picture word (cat, dog, sun, bus, hat, pig, cup, bed, fox, egg, bee, cow, owl, ant, car, map, jam, pen, box, fish, frog, duck, star, moon, cake, ball, tree, boat). Prompt shows the word's letters with the next one emphasised; each right letter fills in and is said; finishing says the whole word, then "You spelled cat!" + celebrate. Wrong letters are ignored gently (no penalty). |

Games never fail, never time out, never show red X's. Smashing in a game is
treated as free play (no wrong-answer spam).

### Progress (for parents)
Local only. The parent panel shows an A–Z and 0–9 grid: shown (tint), found
in a game (filled), plus words spelled. "Reset progress" clears it.

## 5. Sound

- Timbres: **felt** (soft felt piano: sine+triangle, gentle hammer, lowpass
  ~2.4 kHz), **marimba**, **kalimba**, **celesta** (soft, not bright), **harp**
  (gentle pluck), **soft** (warm pad-ish, bedtime). A gentle master lowpass
  (~6 kHz) and the limiter keep everything warm.
- Note velocity default ≈ 0.55 — notes sit *under* speech. When speech is
  about to play, the engine is not ducked (keep it simple) but notes are soft.
- Effects are listed in `SoundEffect` — all quiet and warm. 'retry' must sound
  curious and kind (e.g. a soft rising minor-third → major resolve), never a
  buzzer. 'success' is a warm rising major phrase; 'complete' a fuller one.

## 6. UI chrome (DOM)

Apple/Google polish: system font, generous whitespace, soft elevation, tonal
surfaces, 12–20 px radii, clear hierarchy, subtle 150–250 ms transitions, real
focus rings. **Light by default**; on dark worlds the chrome switches to a
dark tonal variant (UI reads `world.dark`; a `data-theme="dark"` attribute on
`#ui` is set by the game).
- **Start screen**: calm wordmark "KeySplash" (Andika 700, multi-colour
  letters in matte palette — static, no bouncing), one-line subtitle, a row of
  **mode cards** (Explore 1+, Find letters 3+, Find numbers 3+, Spell 4+ —
  icon, title, age chip; selected = tonal fill + check), world swatches (round
  chips with the world icon), and a primary **Start** button (pill, matte,
  pressed state, no pulsing glow). Grown-up tips in small secondary text.
- **Prompt bar** (games): a floating rounded card at top centre: "Find" + big
  target glyph in its container colour + picture; spell shows letter slots.
  Mini keyboard (hint) slides down under it: a neat matte keyboard diagram
  with the target key filled in the challenge colour.
- **Parent panel**: a light sheet (iOS Settings / Material settings feel):
  grouped inset sections with hairline dividers, switches, segmented controls,
  sliders; sections: Learning (mode, layout, speech, letter case, pictures),
  World, Sound, Look & motion, Your child (name, session timer), Progress
  (A–Z / 0–9 grid), Safety, This session. Primary "Keep playing", secondary "Stop".
- **Overlays**: matte and quiet. All-done: night-blue card with a flat moon,
  "All done!", grown-up press-and-hold. Resume: a large matte play button.
