import { describe, expect, it } from 'vitest';
import { letterName } from '../src/content';
import { describeVoiceCoverage } from './voice-coverage';
import { buildVoiceInventory, allVoiceUnits } from '../src/voice/inventory';
import { normalizeKey, resolveClips, splitSentences } from '../src/voice/normalize';

describe('normalizeKey', () => {
  it('canonicalises spacing, case, ellipses and quotes but keeps punctuation', () => {
    expect(normalizeKey("  Yes!   That's  BEE! ")).toBe("yes! that's bee!");
    expect(normalizeKey('bee... bee is for ball')).toBe('bee… bee is for ball');
    expect(normalizeKey('That’s em.')).toBe("that's em.");
    expect(normalizeKey('“hi”')).toBe('"hi"');
    expect(normalizeKey('Yes!')).not.toBe(normalizeKey('Yes.'));
    expect(normalizeKey('café')).toBe('café');
    expect(normalizeKey('a\n\tb')).toBe('a b');
    expect(normalizeKey('')).toBe('');
  });
});

describe('splitSentences', () => {
  it('splits after . ! ? … followed by whitespace', () => {
    expect(splitSentences("Yes! That's bee! Great job!")).toEqual(['Yes!', "That's bee!", 'Great job!']);
    expect(splitSentences("That's em. Can you find bee? It is in the middle row, on the left.")).toEqual([
      "That's em.", 'Can you find bee?', 'It is in the middle row, on the left.',
    ]);
    expect(splitSentences('see, ay, tee… cat! You spelled cat!')).toEqual(['see, ay, tee…', 'cat!', 'You spelled cat!']);
    expect(splitSentences('bee… bee is for ball')).toEqual(['bee…', 'bee is for ball']);
    expect(splitSentences('blue circle')).toEqual(['blue circle']);
    expect(splitSentences('zero — none!')).toEqual(['zero — none!']);
    expect(splitSentences('  ')).toEqual([]);
  });
});

describe('resolveClips', () => {
  const clips: Record<string, [string, number]> = {
    "yes! that's bee!": ['full', 900],
    'yes!': ['yes', 300],
    "that's em!": ['em', 400],
    'great job!': ['gj', 500],
  };
  it('prefers the whole line', () => {
    expect(resolveClips("Yes!  That's bee!", clips)).toEqual([{ id: 'full', ms: 900 }]);
  });
  it('falls back to every sentence', () => {
    expect(resolveClips("Yes! That's em! Great job!", clips)).toEqual([
      { id: 'yes', ms: 300 }, { id: 'em', ms: 400 }, { id: 'gj', ms: 500 },
    ]);
  });
  it('is null when any sentence is missing, or for empty / prototype keys', () => {
    expect(resolveClips("Yes! That's ex!", clips)).toBeNull();
    expect(resolveClips('Hello!', clips)).toBeNull();
    expect(resolveClips('', clips)).toBeNull();
    expect(resolveClips('constructor', clips)).toBeNull();
    expect(resolveClips('__proto__', clips)).toBeNull();
  });
});

describe('allVoiceUnits', () => {
  const units = allVoiceUnits();

  it('is deterministic, non-empty and has unique, normalised keys', () => {
    expect(units.length).toBeGreaterThan(300);
    expect(allVoiceUnits()).toEqual(units);
    const keys = units.map((u) => u.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const u of units) {
      expect(u.key).toBe(normalizeKey(u.key));
      expect(u.key.length).toBeGreaterThan(0);
      expect(u.tts.trim()).toBe(u.tts);
      expect(u.tts.length).toBeGreaterThan(0);
    }
  });

  it('reads letters as capitals in tts and phonetic names in keys', () => {
    for (const u of units) {
      // Every capital-letter token in the tts maps back to its phonetic name in the key.
      // Pronunciation quotes ('A… "A" is for apple') are tts-only.
      const back = u.tts.replace(/"([A-Z])"/g, '$1').replace(/(?<![\p{L}'])([A-Z])(?![\p{L}'])/gu, (_, l: string) => letterName(l));
      expect(normalizeKey(back)).toBe(u.key);
    }
    const byKey = new Map(units.map((u) => [u.key, u.tts]));
    expect(byKey.get('double you')).toBe('W');
    expect(byKey.get('bee… bee is for ball')).toBe('B… "B" is for ball');
    expect(byKey.get('ay… ay is for apple')).toBe('A… "A" is for apple');
    expect(byKey.get('can you find aitch?')).toBe('Can you find H?');
    expect(byKey.get('can you find three?')).toBe('Can you find three?');
    expect(byKey.get('see, ay, tee… cat! you spelled cat!')).toBe('C, A, T… cat! You spelled cat!');
  });

  it('only reports homophone conflicts (same sound, different spelling)', () => {
    const { conflicts } = buildVoiceInventory();
    for (const c of conflicts) {
      expect(c.kept.replace(/^[A-Z]$/, (l) => letterName(l)).toLowerCase()).toBe(c.dropped.toLowerCase());
    }
  });
});

// ---------------------------------------------------------------------------
// Coverage: simulate the app and check every line it can say has clips.
// ---------------------------------------------------------------------------

describeVoiceCoverage(
  'coverage: every line the app says resolves to clips',
  Object.fromEntries(allVoiceUnits().map((u) => [u.key, [u.key, 1]])),
);
