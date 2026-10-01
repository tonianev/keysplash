/**
 * Pure colour helpers for hex colours ('#rgb' / '#rrggbb'). Mixing happens in
 * sRGB space, which is what designers expect for tints and shades. These run
 * when sprites/colours are prepared, never per particle per frame.
 */

export interface Rgb {
  r: number; // 0..255
  g: number;
  b: number;
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Mid grey used when a colour string cannot be parsed (never throws). */
const FALLBACK: Readonly<Rgb> = { r: 128, g: 128, b: 128 };

/** Parses '#rgb' or '#rrggbb' (the '#' is optional). Returns null when invalid. */
export function parseHex(hex: string): Rgb | null {
  const m = HEX_RE.exec(hex.trim());
  if (!m) return null;
  const h = m[1];
  if (h.length === 3) {
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16),
    };
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbOf(hex: string): Rgb {
  return parseHex(hex) ?? { ...FALLBACK };
}

function channel(v: number): string {
  const c = Math.round(v < 0 ? 0 : v > 255 ? 255 : v);
  return (c < 16 ? '0' : '') + c.toString(16);
}

export function toHex(rgb: Rgb): string {
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

/** 'rgba(r, g, b, a)' for a hex colour. */
export function toRgba(hex: string, alpha: number): string {
  const { r, g, b } = rgbOf(hex);
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

/** Linear sRGB mix: t = 0 → a, t = 1 → b. Returns '#rrggbb'. */
export function mix(a: string, b: string, t: number): string {
  const ca = rgbOf(a);
  const cb = rgbOf(b);
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return toHex({
    r: ca.r + (cb.r - ca.r) * k,
    g: ca.g + (cb.g - ca.g) * k,
    b: ca.b + (cb.b - ca.b) * k,
  });
}

/** Mix toward white by `amount` (0..1). */
export function lighten(hex: string, amount: number): string {
  return mix(hex, '#ffffff', amount);
}

/** Mix toward black by `amount` (0..1). */
export function darken(hex: string, amount: number): string {
  return mix(hex, '#000000', amount);
}

function linear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x relative luminance, 0 (black) … 1 (white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = rgbOf(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio, 1 … 21. Order of arguments does not matter. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = la > lb ? la : lb;
  const lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}
