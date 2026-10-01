/**
 * Voice clip lookup keys (VOICE.md §Normalisation & lookup).
 *
 * The build-time generator and the runtime player must agree on how a spoken
 * line maps to a clip, so both go through `normalizeKey`. Punctuation is kept:
 * "Yes!" and "Yes." are said differently.
 */

/** Canonical lookup key for a spoken line. */
export function normalizeKey(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\.\.\./g, '…')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Splits a line into sentences: after `.`, `!`, `?` or `…` followed by
 * whitespace. "Yes! That's bee!" → ["Yes!", "That's bee!"]. Empty parts are dropped.
 */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\.\.\./g, '…')
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface ClipRef {
  id: string;
  ms: number;
}

/**
 * The clips that say `text`: the whole line's clip when there is one, else one
 * clip per sentence (all must exist), else null (not covered).
 */
export function resolveClips(text: string, clips: Readonly<Record<string, readonly [string, number]>>): ClipRef[] | null {
  const lookup = (t: string): ClipRef | null => {
    const key = normalizeKey(t);
    if (!key || !Object.prototype.hasOwnProperty.call(clips, key)) return null;
    const [id, ms] = clips[key];
    return { id, ms };
  };
  const whole = lookup(text);
  if (whole) return [whole];
  const parts = splitSentences(text);
  if (parts.length < 2) return null;
  const out: ClipRef[] = [];
  for (const part of parts) {
    const clip = lookup(part);
    if (!clip) return null;
    out.push(clip);
  }
  return out;
}
