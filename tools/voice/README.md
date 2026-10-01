# Built-in voice generator

KeySplash's default "natural" voice is a set of small MP3 clips generated
**once, at build time** with the open neural TTS model Kokoro-82M, then shipped
in `public/voice/` and precached by the service worker. Nothing here runs in the
browser and the app makes no network requests for speech. See `VOICE.md` at the
repo root for the full design.

## One-time setup (macOS)

```sh
brew install espeak-ng ffmpeg
uv venv --python 3.11 tools/voice/.venv
uv pip install -p tools/voice/.venv -r tools/voice/requirements.txt
```

The Kokoro model files (`kokoro-v1.0.onnx`, ~325 MB, and `voices-v1.0.bin`,
~28 MB) are downloaded into `tools/voice/models/` from the kokoro-onnx GitHub
release `model-files-v1.0` on the first run, if they are not already there.
Whisper `base.en` (for `--qa`) is fetched by faster-whisper into the Hugging
Face cache on first use. `.venv/`, `models/`, `units.json` and `qa-report.json`
are gitignored.

espeak-ng is expected at `/opt/homebrew/lib/libespeak-ng.dylib` and
`/opt/homebrew/share/espeak-ng-data` (override with `ESPEAK_LIB` /
`ESPEAK_DATA`; `FFMPEG` overrides the ffmpeg binary).

## Regenerate

```sh
npm run voice
```

1. `export.mjs` loads `src/voice/inventory.ts` through Vite's SSR loader and
   writes `tools/voice/units.json`: every line the app can say, as
   `{ key, tts }` — `key` is the normalised runtime text (what the app looks
   up), `tts` the text Kokoro reads (capital letters for letter names).
2. `generate.py --qa` synthesises each unit (voice `af_heart`, speed 0.92),
   trims silence (keeps 40 ms), normalises loudness (−20 dBFS RMS, peak ≤ −1
   dBFS) and encodes mono 24 kHz 40 kbps MP3 to `public/voice/<id>.mp3`. It
   writes `src/voice/manifest.json` (`clips: { key: [id, durationMs] }`) and
   deletes clips that are no longer referenced.

It is incremental: `<id>` hashes the key, tts, voice, speed and a processing
version, so unchanged lines are reused and a no-change run takes well under a
second. Commit `public/voice/` and `src/voice/manifest.json` together.

Useful flags: `--only N` (first N units, no stale cleanup), `--voice`,
`--speed`, `--out`, `--manifest`, `--units`, `--qa-report`.

## QA (`--qa`)

- **Letter phoneme check (fatal):** every capital-letter token in a `tts`
  string must come out of the G2P as that letter's name (e.g. `B` → `bˈiː`).
  Exit code 1 lists the failures. Known trap: a capital letter as the subject
  of a sentence is read as the article — `A is for apple` → "uh is for apple".
  Quote it: `"A" is for apple` (also needed for `"I" is for igloo`).
- **Whisper round-trip (report only):** each clip is transcribed with
  faster-whisper `base.en` and compared word-by-word with its text (numbers and
  letter names normalised). The 20 worst matches are printed; everything is in
  `tools/voice/qa-report.json`. Single-letter clips are often misheard by
  Whisper (e.g. "B" → "B.A") — listen to those rather than trusting the score.

## Adding or changing a phrase

1. Build the line through `src/phrases.ts` where the game says it.
2. Make sure `src/voice/inventory.ts` (`allVoiceUnits()`) yields it — as a full
   line if it is a bounded set, or as sentence units if it is combinatorial.
   If Kokoro mispronounces a word, give the unit a different `tts` (spelling
   override) — the `key` stays the runtime text.
3. Run `npm run voice`, check the QA output, listen to new clips, commit.

Lines with the child's name are never generated; they only exist with the
device voice.

## Licences

- **Kokoro-82M** model and voices: Apache-2.0 (hexgrad/Kokoro-82M). The
  generated clips ship with the app.
- **kokoro-onnx**: MIT. **faster-whisper**: MIT; Whisper weights: MIT.
- **espeak-ng** (GPL-3.0) is used only as a build-time phonemizer by
  kokoro-onnx. No espeak-ng code or data ships with KeySplash.
- **ffmpeg / LAME**: build-time encoder only.
