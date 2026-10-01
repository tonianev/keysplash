# KeySplash voice — natural built-in voice + clear on/off

The parent asked: **"make the voice sound more natural and make a clear toggle for on/off"**.

## Why the voice sounded robotic
Web Speech uses whatever voices the OS has. Many machines (including the
parent's Mac) only have "compact" voices (Samantha etc.), which sound robotic.

## The fix
1. **Natural voice (default):** every line KeySplash can say is generated
   **once, at build time**, with the open neural TTS model **Kokoro-82M**
   (Apache-2.0; voice `af_heart`, speed 0.92, American English) and shipped as
   small MP3 clips in `public/voice/`, precached by the service worker → works
   offline, identical on every device, no network at runtime.
2. **Device voice (optional):** the old Web Speech path, now preferring
   Premium / Enhanced / Natural on-device voices; the only style that can say
   the child's name.
3. **A clear on/off switch** (`Settings.voice`) on the start screen and at the
   top of the grown-up panel's Voice section.

## Contracts (see src/types.ts)
- `Settings.voice: boolean` (default true), `Settings.voiceStyle: 'natural' | 'device'`
  (default 'natural'), `SpeechMode = 'letter' | 'word'` (the old `'off'`
  migrates to `voice: false, speech: 'word'`).
- `VoiceOutput` (implemented by the audio engine): `currentTime()`,
  `decodeAudio(ArrayBuffer)`, `playVoice(buffer, when?) → VoicePlayback`.
  Voice goes through master volume → fade → limiter (NOT the warmth lowpass or
  reverb — clarity first) and ducks the music bus by ~6 dB while it plays.
- `Speaker` gains optional `setStyle(style)` and `warm()`.

## Phrases — one source of truth (src/phrases.ts)
Pure string builders with **no imports**. Every spoken line in content.ts,
modes.ts and game.ts is built through them. Letter names are passed in, so the
same builder makes both the runtime text (phonetic names for Web Speech:
"bee", "double you") and the TTS input (capital letters for Kokoro: "B", "W" —
verified: Kokoro's G2P pronounces capitals as letter names; phonetic spellings
like "ay" come out wrong).

```ts
export type Namer = (letter: string) => string;           // 'B' → 'bee' | 'B'
export const lines = {
  letter: (n: string) => n,                                // speech 'letter'
  letterWord: (n: string, word: string, first: boolean) => first ? `${n}… ${n} is for ${word}` : `${n}… ${word}`,
  number: (w: string) => w,                                // 'three'
  countSummary: (w: string, noun: string) => `${w} ${noun}!`,
  zero: () => 'zero — none!',
  shape: (color: string, shape: string) => `${color} ${shape}`,
  direction: (d: string) => `${d}!`,
  clean: () => 'all clean!',
  findPrompt: (n: string) => `Can you find ${n}?`,
  yes: (n: string) => `Yes! That's ${n}!`,
  thats: (n: string) => `That's ${n}.`,
  find: (n: string) => `Find ${n}.`,
  spellPrompt: (word: string, firstName: string) => `Let's spell ${word}. Find ${firstName}.`,
  spellNext: (n: string, next: string) => `${n}! Now find ${next}.`,
  spellDone: (names: string[], word: string) => `${names.join(', ')}… ${word}! You spelled ${word}!`,
  greeting: () => "Let's play!", hello: () => 'Hello!', yay: () => 'Yay!',
  // name lines (device style only): hi(name), yayName(name), greatJobName(name)
};
```
(Exact wording may be kept from the current code — the point is that every
line comes from here.)

## Normalisation & lookup (src/voice/normalize.ts)
- `normalizeKey(text)`: NFC, `...`→`…`, curly quotes → straight, collapse
  whitespace, trim, lower-case. Punctuation is kept (it changes intonation).
- `splitSentences(text)`: split after `.`, `!`, `?`, `…` followed by spaces.
- Runtime lookup for a line: **full line** clip if present; else **every
  sentence** must have a clip (played back-to-back with ~70 ms gaps); else the
  line is not covered → device-voice fallback if an on-device voice exists,
  else silence.

## Inventory (src/voice/inventory.ts)
`allVoiceUnits(): { key: string; tts: string }[]` — every unit to synthesise:
- bounded full lines: every letter (solo and every letter-word line for every
  word in BASE_WORDS + all world words), number words 0–10, count summaries for
  each digit's fixed noun, zero line, all colour×shape combos, directions,
  rainbow colour names, picture words, clean, greeting, hello, yay, praise
  lines (nameless), location hints (describeKeyLocation for every hint key),
  find prompts (letters + numbers), spell prompts (per SPELL_WORDS word, as
  sentences), spell done lines (per word), …
- sentence units for combinatorial lines: `Yes!`, `That's X!`, `That's X.`,
  `Can you find X?`, `Find X.`, `X! Now find Y.` → `X!` + `Now find Y.`, each
  praise sentence, etc.
`key` = normalizeKey(runtime text); `tts` = the same builder with capital
letter names (and any pronunciation overrides).

## Manifest & assets
- `src/voice/manifest.json`: `{ "voice": "af_heart", "model": "kokoro-v1.0",
  "speed": 0.92, "clips": { "<normalized key>": ["<id>", <durationMs>] } }`
  — imported into the bundle (small).
- `public/voice/<id>.mp3` — mono, 24 kHz, ~40 kbps, silence-trimmed (40 ms
  pad), loudness-normalised to a common level. `<id>` = short hash of
  key+tts+voice+speed (stable → incremental regeneration).
- vite-plugin-pwa precaches `**/*.mp3`.

## Generator (tools/voice/)
- `export.mjs` — loads `src/voice/inventory.ts` through Vite's SSR loader and
  writes `tools/voice/units.json`.
- `generate.py` — Kokoro (kokoro-onnx) → trim → normalise → ffmpeg mp3; writes
  the manifest; deletes stale clips; incremental.
- QA (`--qa`): (1) phoneme check — for every capital-letter token in a `tts`
  string, the phonemized output contains that letter's IPA name; (2) Whisper
  (faster-whisper base.en) round-trip word-match ratio per clip; failures in
  `tools/voice/qa-report.json`. Letter-phoneme failures are fatal.
- `npm run voice` runs both. Models download to `tools/voice/models/`
  (gitignored); the venv lives at `tools/voice/.venv` (gitignored). Needs
  `brew install espeak-ng ffmpeg` on macOS (espeak-ng is a build-time G2P only).

## Runtime voice (src/audio/clip-voice.ts, src/audio/voice-router.ts)
- `ClipVoice implements Speaker` — fetches `voice/<id>.mp3`, decodes through
  `VoiceOutput.decodeAudio`, LRU of decoded buffers (≤ 120), plays through
  `playVoice`. Same semantics as WebSpeaker: `say` low (skip if busy or
  < 300 ms since last) / high (stop current, play now); `sequence(parts,
  stepMs, then)` schedules part i at **AudioContext time** t0 + i·step
  (sample-accurate counting), `then` after the last part ends + 250 ms;
  `sequencing`; `cancel()` stops everything. `warm()` prefetches/decodes
  letters, numbers 1–10, greeting, yes/that's/find lines (~80 small clips).
  Uncovered lines → `fallback` speaker (device) when it has an on-device voice.
- `VoiceRouter implements Speaker` — `setStyle('natural' | 'device')` picks
  ClipVoice or WebSpeaker; `setEnabled`, `cancel` reach both; `voices()` /
  `onVoicesChanged` / `setVoice` go to the device speaker (panel voice list).
- Device ranking: on-device voices whose names contain "(Premium)",
  "(Enhanced)", "Natural", "Neural" rank first.

## Game
- `speechOn = settings.voice && !settings.muted`.
- Natural style never builds name lines (greeting "Let's play!", cheers
  "Yay!", praise without the name); device style keeps the name lines.
- After `audio.unlock()` on start: `speaker.warm?.()`.

## UI
- Start screen: a pill switch under Start — "🔊 Voice on" / "🔇 Voice off"
  (`role="switch"`, `aria-checked`, `data-no-start`; Enter/Space toggle).
- Grown-up panel, first section **Voice**: big "Voice" switch; "Voice"
  segmented Natural / This device; device voice select only for "This
  device"; "Says" Letter / Letter + word; "Hear it" button. Controls below the
  switch are disabled (dimmed) while the voice is off.
