/**
 * Pure easing and math helpers. Every easing maps t in [0, 1] to a value with
 * f(0) = 0 and f(1) = 1 (overshooting easings may leave [0, 1] in between).
 * Inputs outside [0, 1] are clamped so callers can pass raw progress values.
 */

export const TAU = Math.PI * 2;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Moves `current` toward `target` by at most `maxDelta` (never overshoots). */
export function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(target, current + maxDelta);
  return Math.max(target, current - maxDelta);
}

export function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

export function easeInCubic(t: number): number {
  const c = clamp01(t);
  return c * c * c;
}

export function easeOutQuad(t: number): number {
  const c = clamp01(t);
  return c * (2 - c);
}

export function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;
}

/**
 * Overshoots then settles. The peak is 1 + 4s³ / (27(s+1)²): the default
 * s = 1.70158 peaks at ~1.10, s = 2.16 at ~1.15 (our spring pop).
 */
export function easeOutBack(t: number, overshoot = 1.70158): number {
  const c = clamp01(t);
  if (c === 1) return 1;
  const u = c - 1;
  return 1 + (overshoot + 1) * u * u * u + overshoot * u * u;
}

/** Springy settle with a few decaying wobbles. */
export function easeOutElastic(t: number): number {
  const c = clamp01(t);
  if (c === 0 || c === 1) return c;
  return Math.pow(2, -10 * c) * Math.sin((c * 10 - 0.75) * (TAU / 3)) + 1;
}

/** Hermite smoothstep between edges a and b. */
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
