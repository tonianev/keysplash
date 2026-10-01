#!/usr/bin/env python3
"""Generate KeySplash's built-in voice clips with Kokoro-82M (see VOICE.md).

units.json (from export.mjs) → public/voice/<id>.mp3 + src/voice/manifest.json.
Incremental: a clip's id hashes everything that affects its audio, so existing
files are reused. Clips no longer referenced are deleted. --qa adds a phoneme
check on letter names (fatal) and a Whisper round-trip (report only).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
MODELS = HERE / "models"
MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
MODEL_FILES = ("kokoro-v1.0.onnx", "voices-v1.0.bin")
MODEL_NAME = "kokoro-v1.0"
ID_VERSION = "v1"  # bump to force regeneration of every clip (e.g. new processing)
LANG = "en-us"

ESPEAK_LIB = os.environ.get("ESPEAK_LIB", "/opt/homebrew/lib/libespeak-ng.dylib")
ESPEAK_DATA = os.environ.get("ESPEAK_DATA", "/opt/homebrew/share/espeak-ng-data")
FFMPEG = os.environ.get("FFMPEG") or shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"

# Audio processing targets.
TRIM_DB = -45.0  # silence threshold, relative to the clip's peak
PAD_S = 0.040  # silence kept at each end after trimming
TARGET_RMS_DB = -20.0
PEAK_CEIL_DB = -1.0
SAMPLE_RATE = 24000
BITRATE = "40k"

# espeak-ng (en-us) IPA for each capital letter name, as Kokoro's G2P emits it.
LETTER_IPA = {
    "A": "ˈeɪ", "B": "bˈiː", "C": "sˈiː", "D": "dˈiː", "E": "ˈiː", "F": "ˈɛf",
    "G": "dʒˈiː", "H": "ˈeɪtʃ", "I": "ˈaɪ", "J": "dʒˈeɪ", "K": "kˈeɪ", "L": "ˈɛl",
    "M": "ˈɛm", "N": "ˈɛn", "O": "ˈoʊ", "P": "pˈiː", "Q": "kjˈuː", "R": "ˈɑːɹ",
    "S": "ˈɛs", "T": "tˈiː", "U": "jˈuː", "V": "vˈiː", "W": "dˈʌbəljˌuː",
    "X": "ˈɛks", "Y": "wˈaɪ", "Z": "zˈiː",
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--units", default=str(HERE / "units.json"))
    p.add_argument("--out", default=str(ROOT / "public" / "voice"))
    p.add_argument("--manifest", default=str(ROOT / "src" / "voice" / "manifest.json"))
    p.add_argument("--voice", default="af_heart")
    p.add_argument("--speed", type=float, default=0.92)
    p.add_argument("--qa", action="store_true", help="phoneme check + Whisper round-trip")
    p.add_argument("--qa-report", default=str(HERE / "qa-report.json"))
    p.add_argument("--only", type=int, default=0, help="debug: only the first N units (no stale-clip cleanup)")
    return p.parse_args()


def clip_id(key: str, tts: str, voice: str, speed: float) -> str:
    raw = f"{key}|{tts}|{voice}|{speed:g}|{ID_VERSION}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]


def ensure_models() -> None:
    MODELS.mkdir(parents=True, exist_ok=True)
    for name in MODEL_FILES:
        dest = MODELS / name
        if dest.exists():
            continue
        print(f"downloading {name} …", flush=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        urllib.request.urlretrieve(MODEL_URL + name, tmp)
        tmp.replace(dest)


def load_kokoro():
    from kokoro_onnx import EspeakConfig, Kokoro

    for path in (ESPEAK_LIB, ESPEAK_DATA):
        if not Path(path).exists():
            sys.exit(f"espeak-ng not found at {path} — run `brew install espeak-ng` (or set ESPEAK_LIB/ESPEAK_DATA)")
    return Kokoro(
        str(MODELS / MODEL_FILES[0]),
        str(MODELS / MODEL_FILES[1]),
        espeak_config=EspeakConfig(lib_path=ESPEAK_LIB, data_path=ESPEAK_DATA),
    )


def db_to_amp(db: float) -> float:
    return float(10.0 ** (db / 20.0))


def active_mask(x: np.ndarray, sr: int) -> tuple[np.ndarray, int]:
    """Per-10ms-frame mask of frames louder than TRIM_DB below the peak."""
    hop = max(1, sr // 100)
    n = len(x) // hop * hop
    frames = np.abs(x[:n]).reshape(-1, hop).max(axis=1) if n else np.zeros(0)
    peak = float(np.abs(x).max()) if len(x) else 0.0
    return frames > peak * db_to_amp(TRIM_DB), hop


def process(x: np.ndarray, sr: int) -> np.ndarray:
    """Trim leading/trailing silence (keep PAD_S) and normalise loudness."""
    x = np.asarray(x, dtype=np.float64).reshape(-1)
    x = x - x.mean()  # remove any DC offset
    mask, hop = active_mask(x, sr)
    idx = np.flatnonzero(mask)
    if len(idx) == 0:
        raise ValueError("synthesised clip is silent")
    pad = int(PAD_S * sr)
    start = max(0, idx[0] * hop - pad)
    end = min(len(x), (idx[-1] + 1) * hop + pad)
    x = x[start:end]
    # Loudness: RMS of the voiced frames only, so short words and long sentences
    # come out at the same perceived level.
    mask, hop = active_mask(x, sr)
    n = len(mask) * hop
    voiced = x[:n].reshape(-1, hop)[mask].reshape(-1) if mask.any() else x
    rms = float(np.sqrt(np.mean(voiced**2))) or 1e-9
    gain = db_to_amp(TARGET_RMS_DB) / rms
    peak = float(np.abs(x).max()) * gain
    if peak > db_to_amp(PEAK_CEIL_DB):
        gain *= db_to_amp(PEAK_CEIL_DB) / peak
    y = x * gain
    # Short fades so the trimmed edges never click.
    fade = min(len(y) // 4, int(0.005 * sr))
    if fade > 0:
        ramp = np.linspace(0.0, 1.0, fade)
        y[:fade] *= ramp
        y[-fade:] *= ramp[::-1]
    return y.astype(np.float32)


def encode_mp3(y: np.ndarray, sr: int, dest: Path) -> None:
    with tempfile.TemporaryDirectory() as td:
        wav = Path(td) / "clip.wav"
        sf.write(wav, y, sr, subtype="FLOAT")
        tmp = dest.with_suffix(".tmp.mp3")
        cmd = [
            FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav),
            "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "libmp3lame", "-b:a", BITRATE,
            "-map_metadata", "-1", "-id3v2_version", "0", "-fflags", "+bitexact", str(tmp),
        ]
        subprocess.run(cmd, check=True)
        tmp.replace(dest)  # atomic: an interrupted run never leaves a half clip


def synthesize(kokoro, tts: str, voice: str, speed: float) -> tuple[np.ndarray, int]:
    samples, sr = kokoro.create(tts, voice=voice, speed=speed, lang=LANG)
    return process(samples, sr), sr


def mp3_duration_ms(path: Path) -> int:
    info = sf.info(str(path))  # libsndfile ≥ 1.1 reads MP3
    return int(round(info.frames * 1000 / info.samplerate))


# ---------------------------------------------------------------- QA

LETTER_TOKEN = re.compile(r"\b[A-Z]\b")
IPA_STRIP = re.compile(r"[^\wˈˌːəɪʊɛɔæɑʌɜɐɚɹɾʃʒθðŋʔ]+")


def phoneme_check(kokoro, tts: str) -> dict | None:
    """Every capital-letter token must come out as that letter's name.

    Counts whole phoneme words, so "A is for apple" fails if the A is read as
    the article (ə) even though "ˈeɪ" appears elsewhere."""
    letters = LETTER_TOKEN.findall(tts)
    if not letters:
        return None
    ipa = kokoro.tokenizer.phonemize(tts, LANG)
    words = [w for w in (IPA_STRIP.sub("", t) for t in ipa.split()) if w]
    missing = sorted(
        {L for L in letters if words.count(LETTER_IPA[L]) < letters.count(L)}
    )
    return {"ok": not missing, "letters": "".join(letters), "ipa": ipa, "missing": missing}


NUMBER_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
    "eleven": "11", "twelve": "12", "twenty": "20",
}
# How Whisper may spell a letter it heard on its own.
LETTER_WORDS = {
    "a": "a", "ay": "a", "eh": "a", "bee": "b", "be": "b", "see": "c", "sea": "c",
    "dee": "d", "e": "e", "ee": "e", "ef": "f", "eff": "f", "gee": "g", "aitch": "h",
    "h": "h", "age": "h", "i": "i", "eye": "i", "jay": "j", "kay": "k", "okay": "k", "el": "l",
    "elle": "l", "em": "m", "en": "n", "o": "o", "oh": "o", "owe": "o", "pee": "p",
    "pea": "p", "queue": "q", "cue": "q", "are": "r", "ar": "r", "ess": "s",
    "tee": "t", "tea": "t", "you": "u", "yew": "u", "vee": "v", "ex": "x",
    "why": "y", "zee": "z", "zed": "z",
}


def words_of(text: str, split_letters: bool = False) -> list[str]:
    text = re.sub(r"(?i)double[ -]?(you|u)\b", "W", text)
    text = text.replace("’", "'").replace("-", " ")
    out: list[str] = []
    for raw in re.findall(r"[A-Za-z0-9']+", text):
        raw = raw.strip("'")
        if not raw:
            continue
        # Whisper glues spelled letters together ("BB", "CAT", "3A").
        if split_letters and len(raw) <= 4 and re.fullmatch(r"[A-Z0-9]+", raw) and not raw.isdigit():
            parts = list(raw)
        else:
            parts = [raw]
        out.extend(NUMBER_WORDS.get(w.lower(), w.lower()) for w in parts)
    return out


def same_word(expected: str, heard: str) -> bool:
    # A spoken letter may come back as a word ("bee", "age", "you"); accept that
    # only where a letter was expected, so "you" in "Can you find U?" still counts.
    return heard == expected or (len(expected) == 1 and LETTER_WORDS.get(heard) == expected)


def match_ratio(expected: str, heard: str) -> float:
    """2·LCS / (len a + len b) over normalised words (like difflib's ratio)."""
    exp = words_of(expected)
    best = 0.0
    for got in (words_of(heard), words_of(heard, split_letters=True)):
        if not exp and not got:
            return 1.0
        prev = [0] * (len(got) + 1)
        for e in exp:
            cur = [0]
            for j, g in enumerate(got):
                cur.append(prev[j] + 1 if same_word(e, g) else max(prev[j + 1], cur[j]))
            prev = cur
        best = max(best, 2 * prev[-1] / (len(exp) + len(got)))
    return round(best, 3)


def whisper_check(clips: list[tuple[str, str, Path]]) -> list[dict]:
    from faster_whisper import WhisperModel

    model = WhisperModel("base.en", device="cpu", compute_type="int8")
    results = []
    for key, tts, path in clips:
        segments, _ = model.transcribe(
            str(path), language="en", beam_size=5, temperature=0.0,
            condition_on_previous_text=False, without_timestamps=True, vad_filter=False,
        )
        heard = " ".join(s.text.strip() for s in segments).strip()
        results.append({"key": key, "tts": tts, "heard": heard, "match": match_ratio(tts, heard)})
    return results


# ---------------------------------------------------------------- main


def load_units(path: Path, only: int) -> list[dict]:
    units = json.loads(path.read_text(encoding="utf-8"))
    seen: set[str] = set()
    for u in units:
        if not isinstance(u, dict) or not u.get("key") or not str(u.get("tts", "")).strip():
            sys.exit(f"bad unit in {path}: {u!r}")
        if u["key"] in seen:
            sys.exit(f"duplicate key in {path}: {u['key']!r}")
        seen.add(u["key"])
    units.sort(key=lambda u: u["key"])
    return units[:only] if only > 0 else units


def main() -> int:
    args = parse_args()
    units = load_units(Path(args.units), args.only)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    manifest_path = Path(args.manifest)
    if not Path(FFMPEG).exists():
        sys.exit(f"ffmpeg not found ({FFMPEG}) — run `brew install ffmpeg`")

    ensure_models()
    kokoro = None  # loaded lazily: an up-to-date run needs no model at all
    t0 = time.time()
    clips: dict[str, list] = {}
    made = 0
    for i, u in enumerate(units, 1):
        key, tts = u["key"], u["tts"]
        cid = clip_id(key, tts, args.voice, args.speed)
        dest = out / f"{cid}.mp3"
        if not dest.exists():
            if kokoro is None:
                kokoro = load_kokoro()
            y, sr = synthesize(kokoro, tts, args.voice, args.speed)
            encode_mp3(y, sr, dest)
            made += 1
            if made % 25 == 0:
                print(f"  {i}/{len(units)} synthesised …", flush=True)
        clips[key] = [cid, mp3_duration_ms(dest)]

    manifest = {
        "voice": args.voice,
        "model": MODEL_NAME,
        "speed": args.speed,
        "clips": dict(sorted(clips.items())),
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # Stale clips (changed wording, removed lines). Skipped with --only, which
    # deliberately covers just part of the inventory.
    removed = 0
    if args.only <= 0:
        live = {c[0] for c in clips.values()}
        for f in out.glob("*.mp3"):
            if f.stem not in live:
                f.unlink()
                removed += 1

    total = sum((out / f"{c[0]}.mp3").stat().st_size for c in clips.values())
    print(
        f"voice: {len(clips)} clips ({made} new, {removed} stale removed), "
        f"{total / 1024:.0f} KiB total, {sum(c[1] for c in clips.values()) / 1000:.0f} s audio, "
        f"{time.time() - t0:.1f} s"
    )
    print(f"voice: manifest → {manifest_path}")
    return run_qa(args, units, clips, out) if args.qa else 0


def run_qa(args: argparse.Namespace, units: list[dict], clips: dict[str, list], out: Path) -> int:
    t0 = time.time()
    kokoro = load_kokoro()
    phon = {}
    for u in units:
        r = phoneme_check(kokoro, u["tts"])
        if r is not None:
            phon[u["key"]] = r
    phon_fail = {k: r for k, r in phon.items() if not r["ok"]}

    print(f"qa: whisper round-trip on {len(units)} clips …", flush=True)
    whisper = whisper_check([(u["key"], u["tts"], out / f"{clips[u['key']][0]}.mp3") for u in units])
    by_key = {w["key"]: w for w in whisper}
    per_clip = []
    for u in units:
        w = by_key[u["key"]]
        entry = {"key": u["key"], "tts": u["tts"], "id": clips[u["key"]][0], "ms": clips[u["key"]][1],
                 "heard": w["heard"], "match": w["match"]}
        if u["key"] in phon:
            entry["phonemes"] = phon[u["key"]]
        per_clip.append(entry)
    matches = [w["match"] for w in whisper]
    summary = {
        "clips": len(units),
        "phonemeChecked": len(phon),
        "phonemeFailures": len(phon_fail),
        "whisperMeanMatch": round(float(np.mean(matches)), 3) if matches else None,
        "whisperExact": sum(1 for m in matches if m >= 0.999),
        "whisperBelow0_5": sum(1 for m in matches if m < 0.5),
        "seconds": round(time.time() - t0, 1),
    }
    report = {"voice": args.voice, "model": MODEL_NAME, "speed": args.speed, "summary": summary,
              "clips": per_clip}
    Path(args.qa_report).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    worst = sorted(whisper, key=lambda w: (w["match"], w["key"]))[:20]
    print("qa: worst Whisper matches (report only — tiny clips like single letters are often misheard):")
    for w in worst:
        print(f"  {w['match']:.2f}  {w['tts']!r:42} heard {w['heard']!r}")
    print(f"qa: {json.dumps(summary)}")
    print(f"qa: report → {args.qa_report}")
    for k, r in phon_fail.items():
        print(f"qa: PHONEME FAIL {k!r}: letters {r['letters']} missing {r['missing']} in {r['ipa']!r}")
    if phon_fail:
        print(f"qa: {len(phon_fail)} letter-name phoneme failure(s) — fix the tts text (fatal)")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
