/**
 * Every line KeySplash speaks — one source of truth (VOICE.md §Phrases).
 *
 * Pure string builders with no imports. Letter names are passed in, so the
 * same builder produces both the runtime text (phonetic names for Web Speech,
 * "bee") and the build-time TTS input (capital letters for Kokoro, "B").
 * The natural voice looks clips up by these exact strings, so change wording
 * here only together with a voice regeneration (`npm run voice`).
 */

/** Turns an upper-case letter into what the voice should read: 'B' → 'bee' | 'B'. */
export type Namer = (letter: string) => string;

/** Warm praise, said after a found answer or a palm smash. */
export const PRAISE: readonly string[] = Object.freeze([
  'Great job!', 'You did it!', 'Wonderful!', 'Well done!', 'Hooray!', 'Super!', 'Yay!', 'Amazing!',
]);

export const lines = {
  /** speech 'letter': just the name. */
  letter: (n: string): string => n,
  /** speech 'word': "bee… bee is for ball", or "ex… fox" when the letter is inside the word. */
  letterWord: (n: string, word: string, first: boolean): string => (first ? `${n}… ${n} is for ${word}` : `${n}… ${word}`),
  /** A number word: 'three'. Also each counted step and the 'letter'-mode zero. */
  number: (w: string): string => w,
  /** After counting: 'three stars!'. */
  countSummary: (w: string, noun: string): string => `${w} ${noun}!`,
  zero: (): string => 'zero — none!',
  /** 'blue circle'. */
  shape: (color: string, shape: string): string => `${color} ${shape}`,
  /** A picture key's word: 'cow'. */
  picture: (word: string): string => word,
  /** A rainbow band's colour: 'red'. */
  color: (color: string): string => color,
  direction: (d: string): string => `${d}!`,
  clean: (): string => 'all clean!',

  findPrompt: (n: string): string => `Can you find ${n}?`,
  yes: (n: string): string => `Yes! That's ${n}!`,
  /** Wrong-key redirect for Find games: "That's em. Can you find bee?" */
  thatsFind: (got: string, want: string): string => `That's ${got}. Can you find ${want}?`,
  thats: (n: string): string => `That's ${n}.`,
  find: (n: string): string => `Find ${n}.`,
  spellPrompt: (word: string, firstName: string): string => `Let's spell ${word}. Find ${firstName}.`,
  spellNext: (n: string, next: string): string => `${n}! Now find ${next}.`,
  spellDone: (names: readonly string[], word: string): string => `${names.join(', ')}… ${word}! You spelled ${word}!`,

  greeting: (): string => "Let's play!",
  hello: (): string => 'Hello!',
  yay: (): string => 'Yay!',
  /** Name lines (device style only — the natural voice cannot say arbitrary names). */
  hi: (name: string): string => `Hi, ${name}!`,
  yayName: (name: string): string => `Yay, ${name}!`,
  greatJobName: (name: string): string => `Great job, ${name}!`,
} as const;

/** "Yes! That's bee!" plus optional praise: "Yes! That's bee! Super!" */
export function withPraise(line: string, extra: string | null | undefined): string {
  return extra ? `${line} ${extra}` : line;
}

/** Greeting on start: "Hi, Emma!" with a name, otherwise "Let's play!". */
export function greetingFor(childName = ''): string {
  const name = childName.trim();
  return name ? lines.hi(name) : lines.greeting();
}

/** Returning to play: "Hi, Emma!" with a name, otherwise "Hello!". */
export function helloFor(childName = ''): string {
  const name = childName.trim();
  return name ? lines.hi(name) : lines.hello();
}

/** Warm praise; sometimes with the child's name ('' → never). */
export function pickPraise(rng: () => number, childName = ''): string {
  const name = childName.trim();
  if (name && rng() < 0.35) return lines.greatJobName(name);
  return PRAISE[Math.min(PRAISE.length - 1, Math.floor(rng() * PRAISE.length))];
}
