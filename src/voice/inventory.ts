/**
 * Everything the natural (recorded) voice must be able to say — the input to
 * the build-time clip generator (VOICE.md §Inventory, tools/voice/export.mjs).
 *
 * Each unit pairs a lookup `key` (the runtime text, phonetic letter names,
 * normalised) with `tts` (the same line with capital letters, which Kokoro
 * reads as letter names). Bounded lines are listed whole; combinatorial lines
 * (wrong-key redirects, spelling steps) are listed sentence by sentence and the
 * player stitches them together. Order is deterministic so regeneration is
 * incremental and diffs stay readable.
 */
import { COUNTABLES, NUMBER_WORDS, PICTURES, RAINBOW_ORDER, SHAPES, letterName, numberWord, shapeLabel, wordsFor } from '../content';
import { KEYBOARD_ROWS, describeKeyLocation } from '../keymap';
import { SPELL_WORDS } from '../modes';
import { PRAISE, lines, type Namer } from '../phrases';
import type { DirectionName } from '../types';
import { WORLDS, WORLD_ORDER } from '../worlds';
import { normalizeKey, splitSentences } from './normalize';

export interface VoiceUnit {
  /** normalizeKey(runtime text) — the manifest key. */
  key: string;
  /** Text handed to the TTS model. */
  tts: string;
}

export interface VoiceInventory {
  units: VoiceUnit[];
  /** Same key, different tts: the first was kept. Should be harmless homophones only. */
  conflicts: Array<{ key: string; kept: string; dropped: string }>;
}

const LETTERS = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const DIRECTIONS: DirectionName[] = ['up', 'down', 'left', 'right'];

const RUNTIME: Namer = letterName;
const TTS: Namer = (l) => l.toUpperCase();

/** Builds the inventory from the app's real data. */
export function buildVoiceInventory(): VoiceInventory {
  const units: VoiceUnit[] = [];
  const conflicts: VoiceInventory['conflicts'] = [];
  const byKey = new Map<string, string>();

  const push = (runtime: string, tts: string): void => {
    const key = normalizeKey(runtime);
    if (!key) return;
    const kept = byKey.get(key);
    if (kept === undefined) {
      byKey.set(key, tts);
      units.push({ key, tts });
    } else if (kept !== tts) {
      conflicts.push({ key, kept, dropped: tts });
    }
  };
  /** A whole line, built once per namer. */
  const line = (build: (n: Namer) => string): void => push(build(RUNTIME), build(TTS));
  /** Each sentence of a line as its own unit (for lines that are combined at runtime). */
  const sentences = (build: (n: Namer) => string): void => {
    const a = splitSentences(build(RUNTIME));
    const b = splitSentences(build(TTS));
    if (a.length !== b.length) throw new Error(`voice inventory: sentence mismatch in "${a.join(' ')}"`);
    a.forEach((s, i) => push(s, b[i]));
  };
  const plain = (text: string): void => push(text, text);

  // Greetings and cheers.
  plain(lines.greeting());
  plain(lines.hello());
  plain(lines.yay());
  for (const p of PRAISE) plain(p);

  // Letters: solo, and every letter-word line in every world.
  for (const l of LETTERS) line((n) => lines.letter(n(l)));
  for (const id of WORLD_ORDER) {
    for (const l of LETTERS) {
      for (const w of wordsFor(l, WORLDS[id])) {
        const first = (w.at ?? 0) === 0;
        // Kokoro reads a sentence-initial "A" as the article ("uh is for apple"); quoting the
        // letter in the tts only keeps it a letter name. The key stays the runtime text.
        push(lines.letterWord(RUNTIME(l), w.word, first), lines.letterWord(TTS(l), w.word, first).replace(/… ([A-Z]) is for /, '… "$1" is for '));
      }
    }
  }

  // Numbers and counting.
  for (const w of NUMBER_WORDS) plain(lines.number(w));
  plain(lines.zero());
  for (let d = 1; d <= 9; d++) {
    const [singular, plural] = COUNTABLES[d % COUNTABLES.length];
    plain(lines.countSummary(numberWord(d), d === 1 ? singular : plural));
  }

  // Colours, shapes, directions, pictures, clear.
  const colorNames: string[] = [...RAINBOW_ORDER];
  for (const id of WORLD_ORDER) {
    for (const c of WORLDS[id].palette) if (!colorNames.includes(c.name)) colorNames.push(c.name);
  }
  for (const c of colorNames) plain(lines.color(c));
  for (const c of colorNames) for (const s of SHAPES) plain(lines.shape(c, shapeLabel(s)));
  for (const d of DIRECTIONS) plain(lines.direction(d));
  for (const [word] of PICTURES) plain(lines.picture(word));
  plain(lines.clean());

  // Find games: prompts, yes lines (whole and per sentence), redirects per sentence.
  const targets: Array<(n: Namer) => string> = [
    ...LETTERS.map((l) => (n: Namer) => n(l)),
    ...DIGITS.map((d) => () => numberWord(d)),
  ];
  for (const t of targets) {
    line((n) => lines.findPrompt(t(n)));
    line((n) => lines.yes(t(n)));
    sentences((n) => lines.yes(t(n)));
    sentences((n) => lines.thatsFind(t(n), t(n)));
  }
  for (const l of LETTERS) line((n) => lines.find(n(l)));

  // Spell: "B! Now find C." per sentence, prompts per sentence, done lines whole.
  for (const l of LETTERS) sentences((n) => lines.spellNext(n(l), n(l)));
  for (const w of SPELL_WORDS) {
    const letters = Array.from(w.word.toUpperCase()).filter((c) => c >= 'A' && c <= 'Z');
    sentences((n) => lines.spellPrompt(w.word, n(letters[0])));
    line((n) => lines.spellDone(letters.map((c) => n(c)), w.word));
  }

  // Where a key is (hint level 2), for every hint key and the fallback.
  const codes = [...KEYBOARD_ROWS.flat(), ...DIGITS.map((d) => `Numpad${d}`), ''];
  for (const code of codes) plain(describeKeyLocation(code));

  return { units, conflicts };
}

/** Every unit to synthesise, deduplicated by key, in a stable order. */
export function allVoiceUnits(): VoiceUnit[] {
  return buildVoiceInventory().units;
}
