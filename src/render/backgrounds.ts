/**
 * Animated world backdrops.
 *
 * Each backdrop pre-renders everything static (sky gradient, hills,
 * silhouettes, planet bodies, coral…) into one offscreen layer in resize(),
 * plus a few small sprites, and per frame blits that layer and animates a
 * bounded set of cheap elements. Layout comes from a PRNG seeded by the world,
 * stored in normalised coordinates, so a resize rescales the scene instead of
 * reshuffling it.
 *
 * Motion runs on an internal clock: `calm` slows it, reduced motion freezes
 * it. Every animated value is a pure function of that clock (no accumulated
 * state, no per-frame allocation), and all twinkles/pulses stay well under
 * 0.5 Hz. Backdrops sit behind big bright glyphs, so colours are softened and
 * contrast kept low on purpose.
 */
import type { BackgroundKind, World } from '../types';

type Ctx = CanvasRenderingContext2D;

export interface Backdrop {
  resize(width: number, height: number, dpr: number): void;
  update(dt: number, now: number, calm: number): void;
  /** Paints the full viewport (CSS px coordinates; the dpr transform is already applied). */
  draw(ctx: CanvasRenderingContext2D): void;
}

export interface BackdropOptions {
  reduceMotion: boolean;
}

export function createBackdrop(world: World, options: BackdropOptions): Backdrop {
  const Ctor = BACKDROPS[world.background] ?? MeadowBackdrop;
  return new Ctor(world, options.reduceMotion);
}

// ---------------------------------------------------------------------------
// Math, randomness, colour
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

/** The static layer is capped at ~6 MP; beyond that (5K screens) soft art loses nothing. */
const MAX_BASE_PIXELS = 6_000_000;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wraps `v` into [lo, lo + span). */
function wrap(v: number, lo: number, span: number): number {
  const m = (v - lo) % span;
  return lo + (m < 0 ? m + span : m);
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stateless integer hash to [0, 1), for per-event randomness without allocating. */
function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

interface Rgb { r: number; g: number; b: number }

function rgb(r: number, g: number, b: number): Rgb {
  return { r, g, b };
}

const WHITE = rgb(255, 255, 255);

function parseColor(value: string): Rgb {
  const s = value.trim();
  if (s[0] === '#') {
    let hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    const n = Number.parseInt(hex.slice(0, 6), 16);
    if (hex.length >= 6 && !Number.isNaN(n)) return rgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return rgb(clamp(+m[1], 0, 255), clamp(+m[2], 0, 255), clamp(+m[3], 0, 255));
  return rgb(60, 70, 110);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return rgb(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
}

/** Pulls a colour toward grey of the same luminance (0 = unchanged, 1 = grey). */
function soften(c: Rgb, amount: number): Rgb {
  const l = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  return mix(c, rgb(l, l, l), amount);
}

function css(c: Rgb, alpha = 1): string {
  const a = clamp(alpha, 0, 1);
  return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${a.toFixed(3)})`;
}

// ---------------------------------------------------------------------------
// Offscreen layers and static painting helpers (resize-time only)
// ---------------------------------------------------------------------------

interface Layer {
  canvas: HTMLCanvasElement;
  ctx: Ctx;
  /** Size in CSS px. */
  w: number;
  h: number;
}

/** Offscreen canvas of w×h CSS px at `scale` device px per CSS px, transform preset. */
function createLayer(w: number, h: number, scale: number): Layer | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w * scale));
  canvas.height = Math.max(1, Math.ceil(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  return { canvas, ctx, w, h };
}

function sprite(w: number, h: number, scale: number, paint: (c: Ctx, w: number, h: number) => void): Layer | null {
  const layer = createLayer(w, h, scale);
  if (layer) paint(layer.ctx, w, h);
  return layer;
}

function release(layer: Layer | null): null {
  if (layer) layer.canvas.width = 0; // frees the backing store promptly
  return null;
}

/** Soft radial glow filling a square around (x, y). */
function glow(c: Ctx, x: number, y: number, r: number, color: Rgb, alpha: number): void {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, css(color, alpha));
  g.addColorStop(0.45, css(color, alpha * 0.4));
  g.addColorStop(1, css(color, 0));
  c.fillStyle = g;
  c.fillRect(x - r, y - r, r * 2, r * 2);
}

function glowSprite(radius: number, color: Rgb, scale: number, core = 0): Layer | null {
  return sprite(radius * 2, radius * 2, scale, (c) => {
    glow(c, radius, radius, radius, color, 1);
    if (core > 0) {
      c.fillStyle = css(mix(color, WHITE, 0.75));
      c.beginPath();
      c.arc(radius, radius, core, 0, TAU);
      c.fill();
    }
  });
}

/** Tiny star: soft glow, bright core, optionally a 4-point sparkle. */
function starSprite(core: number, tint: Rgb, scale: number, sparkle: boolean): Layer | null {
  const R = core * 4;
  return sprite(R * 2, R * 2, scale, (c) => {
    const g = c.createRadialGradient(R, R, 0, R, R, R);
    g.addColorStop(0, css(tint, 0.85));
    g.addColorStop(0.22, css(tint, 0.3));
    g.addColorStop(1, css(tint, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, R * 2, R * 2);
    if (sparkle) {
      const L = R * 0.95;
      c.fillStyle = css(tint, 0.55);
      c.beginPath();
      c.moveTo(R, R - L);
      c.quadraticCurveTo(R, R, R + L, R);
      c.quadraticCurveTo(R, R, R, R + L);
      c.quadraticCurveTo(R, R, R - L, R);
      c.quadraticCurveTo(R, R, R, R - L);
      c.fill();
    }
    c.fillStyle = css(mix(tint, WHITE, 0.6));
    c.beginPath();
    c.arc(R, R, core * 0.6, 0, TAU);
    c.fill();
  });
}

/** Rolling-hill profile: two sines, seeded once so resizes keep the same landscape. */
interface HillShape { k1: number; k2: number; p1: number; p2: number }

function makeHill(rng: () => number): HillShape {
  return { k1: 0.7 + rng() * 1.1, k2: 1.8 + rng() * 2.2, p1: rng() * TAU, p2: rng() * TAU };
}

function hillY(s: HillShape, x: number, w: number, base: number, amp: number): number {
  const u = (x / w) * TAU;
  return base + amp * (0.62 * Math.sin(u * s.k1 + s.p1) + 0.38 * Math.sin(u * s.k2 + s.p2));
}

function traceHill(c: Ctx, s: HillShape, w: number, h: number, base: number, amp: number): void {
  const step = Math.max(6, w / 160);
  c.beginPath();
  c.moveTo(-2, h + 2);
  for (let x = -2; x <= w + step; x += step) c.lineTo(x, hillY(s, x, w, base, amp));
  c.lineTo(w + step, h + 2);
  c.closePath();
}

function fillHill(c: Ctx, s: HillShape, w: number, h: number, base: number, amp: number, top: Rgb, bottom: Rgb): void {
  traceHill(c, s, w, h, base, amp);
  const g = c.createLinearGradient(0, base - amp, 0, h);
  g.addColorStop(0, css(top));
  g.addColorStop(1, css(bottom));
  c.fillStyle = g;
  c.fill();
}

function verticalGradient(c: Ctx, w: number, h: number, top: Rgb, bottom: Rgb, mid?: Rgb): void {
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, css(top));
  if (mid) g.addColorStop(0.55, css(mid));
  g.addColorStop(1, css(bottom));
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
}

/** Fluffy cloud of overlapping puffs with a flat-ish bottom, `width` wide, centred on (cx, cy). */
function drawPuffyCloud(c: Ctx, cx: number, cy: number, width: number, color: string, rng: () => number): void {
  const u = width;
  const j = () => 0.9 + rng() * 0.2;
  c.fillStyle = color;
  c.beginPath();
  c.arc(cx - 0.3 * u, cy + 0.06 * u, 0.17 * u * j(), 0, TAU);
  c.moveTo(cx + 0.1 * u, cy);
  c.arc(cx - 0.1 * u, cy - 0.06 * u, 0.22 * u * j(), 0, TAU);
  c.moveTo(cx + 0.38 * u, cy);
  c.arc(cx + 0.13 * u, cy - 0.09 * u, 0.24 * u * j(), 0, TAU);
  c.moveTo(cx + 0.5 * u, cy);
  c.arc(cx + 0.32 * u, cy + 0.05 * u, 0.16 * u * j(), 0, TAU);
  c.fill();
  c.beginPath();
  const top = cy + 0.02 * u;
  const bottom = cy + 0.2 * u;
  const rad = (bottom - top) / 2;
  c.moveTo(cx - 0.36 * u + rad, top);
  c.lineTo(cx + 0.38 * u - rad, top);
  c.arc(cx + 0.38 * u - rad, top + rad, rad, -Math.PI / 2, Math.PI / 2);
  c.lineTo(cx - 0.36 * u + rad, bottom);
  c.arc(cx - 0.36 * u + rad, top + rad, rad, Math.PI / 2, Math.PI * 1.5);
  c.fill();
}

/** Palm tree silhouette: trunk base at (x, y), `height` tall, leaning right (lean > 0) or left. */
function drawPalm(c: Ctx, x: number, y: number, height: number, trunk: Rgb, leaf: Rgb, lean: number, rng: () => number): void {
  const tx = x + height * 0.12 * lean;
  const ty = y - height * 0.66;
  const w0 = height * 0.045;
  const w1 = height * 0.022;
  c.fillStyle = css(trunk);
  c.beginPath();
  c.moveTo(x - w0, y);
  c.quadraticCurveTo(x - w0 * 0.6 + (tx - x) * 0.15, (y + ty) / 2, tx - w1, ty);
  c.lineTo(tx + w1, ty);
  c.quadraticCurveTo(x + w0 * 1.2 + (tx - x) * 0.15, (y + ty) / 2, x + w0, y);
  c.closePath();
  c.fill();
  // Trunk rings
  c.strokeStyle = css(mix(trunk, WHITE, 0.18), 0.6);
  c.lineWidth = Math.max(1, height * 0.006);
  for (let i = 1; i < 7; i++) {
    const t = i / 7;
    const px = x + (tx - x) * t * t;
    const py = y + (ty - y) * t;
    const hw = w0 + (w1 - w0) * t;
    c.beginPath();
    c.moveTo(px - hw, py);
    c.quadraticCurveTo(px, py + hw * 0.5, px + hw, py);
    c.stroke();
  }
  // Fronds: drooping leaves fanning out from the crown
  const fronds = 7;
  const len = height * 0.38;
  c.fillStyle = css(leaf);
  c.strokeStyle = css(mix(leaf, trunk, 0.5), 0.5);
  for (let i = 0; i < fronds; i++) {
    const a = -Math.PI + (i / (fronds - 1)) * Math.PI + (rng() - 0.5) * 0.25;
    const L = len * (0.85 + rng() * 0.25);
    const ex = tx + Math.cos(a) * L;
    const ey = ty + Math.sin(a) * L * 0.75 + L * 0.42 * Math.abs(Math.cos(a));
    const mx = tx + Math.cos(a) * L * 0.55;
    const my = ty + Math.sin(a) * L * 0.6 - L * 0.12;
    const nx = -(ey - ty) / L;
    const ny = (ex - tx) / L;
    const fw = L * 0.16;
    c.beginPath();
    c.moveTo(tx, ty);
    c.quadraticCurveTo(mx + nx * fw, my + ny * fw, ex, ey);
    c.quadraticCurveTo(mx - nx * fw * 0.6, my - ny * fw * 0.6, tx, ty);
    c.fill();
    c.lineWidth = Math.max(1, height * 0.005);
    c.beginPath();
    c.moveTo(tx, ty);
    c.quadraticCurveTo(mx, my, ex, ey);
    c.stroke();
  }
  // Coconuts
  c.fillStyle = css(mix(trunk, rgb(60, 40, 30), 0.3));
  for (let i = 0; i < 3; i++) {
    c.beginPath();
    c.arc(tx + (i - 1) * height * 0.03, ty + height * 0.025, height * 0.022, 0, TAU);
    c.fill();
  }
}

/**
 * Fern silhouette: arching fronds of leaflets fanning out from (x, y) between
 * angles `from` and `to` (default: rising upward). Fronds droop with gravity.
 */
function drawFern(
  c: Ctx, x: number, y: number, size: number, color: Rgb, rng: () => number,
  from = -Math.PI * 0.92, to = -Math.PI * 0.08,
): void {
  c.fillStyle = css(color);
  c.strokeStyle = css(color);
  const fronds = 6;
  const mid = (from + to) / 2;
  for (let i = 0; i < fronds; i++) {
    const a = from + (i / (fronds - 1)) * (to - from) + (rng() - 0.5) * 0.15;
    const L = size * (0.75 + rng() * 0.3) * (1 - Math.abs(a - mid) * 0.25);
    const ex = x + Math.cos(a) * L;
    const ey = y + Math.sin(a) * L * 0.9 + L * 0.3 * Math.abs(Math.cos(a));
    const cxp = x + Math.cos(a) * L * 0.5;
    const cyp = y + Math.sin(a) * L * 0.75 - L * 0.1;
    c.lineWidth = Math.max(1, size * 0.02);
    c.beginPath();
    c.moveTo(x, y);
    c.quadraticCurveTo(cxp, cyp, ex, ey);
    c.stroke();
    for (let s = 0.14; s < 0.98; s += 0.09) {
      const it = 1 - s;
      const px = it * it * x + 2 * it * s * cxp + s * s * ex;
      const py = it * it * y + 2 * it * s * cyp + s * s * ey;
      const dx = 2 * it * (cxp - x) + 2 * s * (ex - cxp);
      const dy = 2 * it * (cyp - y) + 2 * s * (ey - cyp);
      const ang = Math.atan2(dy, dx);
      const leafLen = size * 0.11 * (1 - s * 0.65);
      for (let side = -1; side <= 1; side += 2) {
        const la = ang + side * 1.15;
        c.beginPath();
        c.ellipse(px + Math.cos(la) * leafLen * 0.55, py + Math.sin(la) * leafLen * 0.55, leafLen * 0.6, leafLen * 0.24, la, 0, TAU);
        c.fill();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

abstract class BaseBackdrop implements Backdrop {
  protected w = 0;
  protected h = 0;
  protected dpr = 1;
  /** min(w, h): most sizes are fractions of this. */
  protected unit = 1;
  /** Size/speed multiplier relative to a 900 px reference viewport. */
  protected k = 1;
  /** Animation clock in seconds; slowed by calm, frozen by reduced motion. */
  protected t = 0;
  /** The caller's globalAlpha at draw() (cross-fades); multiplied into every sprite alpha. */
  protected ga = 1;
  protected readonly world: World;
  protected readonly reduceMotion: boolean;
  protected readonly sky0: Rgb;
  protected readonly sky1: Rgb;
  /** Layout PRNG, seeded per world: consume it only in constructors. */
  protected readonly rng: () => number;
  private base: Layer | null = null;
  private readonly fallback: string;

  constructor(world: World, reduceMotion: boolean) {
    this.world = world;
    this.reduceMotion = reduceMotion;
    this.sky0 = parseColor(world.sky[0]);
    this.sky1 = parseColor(world.sky[1]);
    this.rng = mulberry32(hashString(`${world.id}:${world.background}`));
    this.fallback = css(mix(this.sky0, this.sky1, 0.5));
  }

  resize(width: number, height: number, dpr: number): void {
    const w = Math.max(1, Math.round(width || 0));
    const h = Math.max(1, Math.round(height || 0));
    const d = clamp(dpr || 1, 0.5, 3);
    if (w === this.w && h === this.h && d === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = d;
    this.unit = Math.min(w, h);
    this.k = clamp(this.unit / 900, 0.4, 2.5);
    this.layout();
    this.base = release(this.base);
    this.base = createLayer(w, h, Math.min(d, Math.sqrt(MAX_BASE_PIXELS / (w * h))));
    if (this.base) this.paintBase(this.base.ctx, w, h);
  }

  update(dt: number, _now: number, calm: number): void {
    if (this.reduceMotion || !(dt > 0)) return;
    const c = calm > 0 ? (calm < 1 ? calm : 1) : 0;
    this.t += Math.min(dt, 0.1) * (1 - 0.7 * c);
  }

  draw(ctx: Ctx): void {
    if (this.w === 0) {
      // Not sized yet: still clear to the sky colour so nothing smears.
      const canvas = ctx.canvas as HTMLCanvasElement | undefined;
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = this.fallback;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
      return;
    }
    ctx.save();
    this.ga = ctx.globalAlpha;
    ctx.imageSmoothingEnabled = true;
    if (this.base) {
      ctx.drawImage(this.base.canvas, 0, 0, this.w, this.h);
    } else {
      ctx.fillStyle = this.fallback;
      ctx.fillRect(0, 0, this.w, this.h);
    }
    this.paint(ctx);
    ctx.restore();
  }

  /** Recompute size-dependent values and sprites (runs before paintBase on every resize). */
  protected abstract layout(): void;
  /** Paint the static layer, in CSS px. */
  protected abstract paintBase(c: Ctx, w: number, h: number): void;
  /** Paint the animated elements over the static layer. */
  protected abstract paint(ctx: Ctx): void;

  /** Blits a sprite centred on (cx, cy). */
  protected blit(ctx: Ctx, layer: Layer | null, cx: number, cy: number, w: number, h: number, alpha: number): void {
    if (!layer || alpha <= 0.004) return;
    ctx.globalAlpha = this.ga * (alpha < 1 ? alpha : 1);
    ctx.drawImage(layer.canvas, cx - w * 0.5, cy - h * 0.5, w, h);
  }

  /** Blits a sprite rotated about a pivot; (ax, ay) is the sprite's anchor in 0..1. */
  protected blitRotated(
    ctx: Ctx, layer: Layer | null, px: number, py: number, w: number, h: number,
    ax: number, ay: number, angle: number, alpha: number, flip = false,
  ): void {
    if (!layer || alpha <= 0.004) return;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    if (flip) ctx.scale(-1, 1);
    ctx.globalAlpha = this.ga * (alpha < 1 ? alpha : 1);
    ctx.drawImage(layer.canvas, -w * ax, -h * ay, w, h);
    ctx.restore();
  }

  /** Softened copies of the world palette (for bokeh, bunting, bulbs), never empty. */
  protected softPalette(amount: number): Rgb[] {
    const list = this.world.palette.map((p) => soften(parseColor(p.hex), amount));
    return list.length > 0 ? list : [rgb(255, 160, 180), rgb(255, 220, 120), rgb(140, 210, 255)];
  }
}

// ---------------------------------------------------------------------------
// Starfield (space)
// ---------------------------------------------------------------------------

const STAR_MAX = 260;
const STAR_SPEED = [1.6, 3.6, 7.5]; // px/s at the reference size, per parallax layer
const STAR_ALPHA = [0.5, 0.72, 0.95];
const STAR_CORE = [1.0, 1.5, 2.3];
const STAR_TINTS = [WHITE, rgb(255, 236, 190), rgb(190, 215, 255)];

class StarfieldBackdrop extends BaseBackdrop {
  private readonly sx = new Float32Array(STAR_MAX);
  private readonly sy = new Float32Array(STAR_MAX);
  private readonly layerOf = new Uint8Array(STAR_MAX);
  private readonly tintOf = new Uint8Array(STAR_MAX);
  private readonly phase = new Float32Array(STAR_MAX);
  private readonly freq = new Float32Array(STAR_MAX);
  private readonly amp = new Float32Array(STAR_MAX);
  private readonly spriteSize = new Float32Array(3);
  private readonly nebula: Array<{ x: number; y: number; r: number; color: Rgb; alpha: number }> = [];
  private readonly planetLeft: boolean;
  private readonly craterSeed: number;
  private count = 0;
  private stars: Array<Layer | null> = [];
  private planet: Layer | null = null;
  private moon: Layer | null = null;
  private streak: Layer | null = null;
  private planetR = 0;
  private streakLen = 0;

  constructor(world: World, reduceMotion: boolean) {
    super(world, reduceMotion);
    const rng = this.rng;
    for (let i = 0; i < STAR_MAX; i++) {
      this.sx[i] = rng();
      this.sy[i] = rng();
      const layer = rng();
      this.layerOf[i] = layer < 0.55 ? 0 : layer < 0.86 ? 1 : 2;
      const tint = rng();
      this.tintOf[i] = tint < 0.6 ? 0 : tint < 0.8 ? 1 : 2;
      this.phase[i] = rng() * TAU;
      this.freq[i] = 0.35 + rng() * 0.8; // 5–18 s twinkle period
      this.amp[i] = 0.12 + rng() * 0.33;
    }
    const nebulaColors = [rgb(150, 90, 220), rgb(60, 170, 200), rgb(220, 100, 170)];
    const nebulaAlpha = [0.16, 0.1, 0.08];
    for (let i = 0; i < 3; i++) {
      this.nebula.push({ x: 0.15 + rng() * 0.7, y: 0.15 + rng() * 0.7, r: 0.35 + rng() * 0.25, color: nebulaColors[i], alpha: nebulaAlpha[i] });
    }
    this.planetLeft = rng() < 0.5;
    this.craterSeed = Math.floor(rng() * 1e9);
  }

  protected layout(): void {
    const { w, h, dpr, unit } = this;
    this.count = Math.round(clamp((w * h) / 8000, 60, STAR_MAX));
    this.stars.forEach(release);
    this.stars = [];
    const size = clamp(this.k, 0.8, 1.6);
    for (let layer = 0; layer < 3; layer++) {
      const core = STAR_CORE[layer] * size;
      this.spriteSize[layer] = core * 8;
      for (const tint of STAR_TINTS) this.stars.push(starSprite(core, tint, dpr, layer === 2));
    }
    this.planetR = clamp(unit * 0.085, 26, 130);
    this.planet = release(this.planet);
    this.planet = this.ringedPlanet(this.planetR);
    this.moon = release(this.moon);
    this.moon = this.cratered(this.planetR * 0.5);
    this.streakLen = clamp(unit * 0.2, 70, 240);
    this.streak = release(this.streak);
    const len = this.streakLen;
    this.streak = sprite(len + 6, 8, dpr, (c) => {
      const g = c.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, css(WHITE, 0));
      g.addColorStop(1, css(WHITE, 0.8));
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(0, 4);
      c.lineTo(len, 2.2);
      c.lineTo(len, 5.8);
      c.closePath();
      c.fill();
      glow(c, len, 4, 4, WHITE, 0.9);
    });
  }

  private ringedPlanet(R: number): Layer | null {
    const body = mix(soften(rgb(240, 160, 150), 0.15), this.sky1, 0.12);
    const ring = rgb(255, 228, 175);
    return sprite(R * 4.1, R * 2.4, this.dpr, (c, w, h) => {
      c.translate(w / 2, h / 2);
      c.rotate(-0.35);
      const rx = R * 1.9;
      const ry = R * 0.5;
      c.lineWidth = R * 0.2;
      c.strokeStyle = css(ring, 0.6);
      c.beginPath();
      c.ellipse(0, 0, rx, ry, 0, Math.PI, TAU); // back half of the ring
      c.stroke();
      const g = c.createRadialGradient(-R * 0.35, -R * 0.4, R * 0.1, 0, 0, R);
      g.addColorStop(0, css(mix(body, WHITE, 0.35)));
      g.addColorStop(0.6, css(body));
      g.addColorStop(1, css(mix(body, rgb(60, 30, 70), 0.35)));
      c.fillStyle = g;
      c.beginPath();
      c.arc(0, 0, R, 0, TAU);
      c.fill();
      c.save();
      c.clip();
      c.fillStyle = css(WHITE, 0.14);
      c.fillRect(-R, -R * 0.38, R * 2, R * 0.16);
      c.fillRect(-R, R * 0.12, R * 2, R * 0.22);
      c.restore();
      c.strokeStyle = css(ring, 0.75);
      c.beginPath();
      c.ellipse(0, 0, rx, ry, 0, 0, Math.PI); // front half
      c.stroke();
      c.lineWidth = Math.max(1, R * 0.03);
      c.strokeStyle = css(WHITE, 0.35);
      c.beginPath();
      c.ellipse(0, 0, rx * 0.93, ry * 0.86, 0, 0, Math.PI);
      c.stroke();
    });
  }

  private cratered(R: number): Layer | null {
    const body = rgb(205, 200, 230);
    const rng = mulberry32(this.craterSeed);
    return sprite(R * 2.2, R * 2.2, this.dpr, (c, w) => {
      const cx = w / 2;
      const g = c.createRadialGradient(cx - R * 0.35, cx - R * 0.35, R * 0.1, cx, cx, R);
      g.addColorStop(0, css(mix(body, WHITE, 0.4)));
      g.addColorStop(1, css(mix(body, rgb(70, 60, 110), 0.35)));
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cx, R, 0, TAU);
      c.fill();
      for (let i = 0; i < 4; i++) {
        const a = rng() * TAU;
        const d = rng() * R * 0.55;
        const cr = R * (0.12 + rng() * 0.14);
        c.fillStyle = css(mix(body, rgb(80, 70, 120), 0.3), 0.55);
        c.beginPath();
        c.arc(cx + Math.cos(a) * d, cx + Math.sin(a) * d, cr, 0, TAU);
        c.fill();
      }
    });
  }

  protected paintBase(c: Ctx, w: number, h: number): void {
    verticalGradient(c, w, h, this.sky0, this.sky1, mix(this.sky0, this.sky1, 0.45));
    const big = Math.max(w, h);
    for (const n of this.nebula) glow(c, n.x * w, n.y * h, n.r * big, n.color, n.alpha);
    // Fixed faint dust behind the drifting stars
    const dust = mulberry32(hashString(`dust:${this.world.id}`));
    const count = Math.min(700, Math.round((w * h) / 2400));
    c.fillStyle = css(WHITE);
    for (let i = 0; i < count; i++) {
      c.globalAlpha = 0.12 + dust() * 0.3;
      c.beginPath();
      c.arc(dust() * w, dust() * h, 0.4 + dust() * 0.6, 0, TAU);
      c.fill();
    }
    c.globalAlpha = 1;
  }

  protected paint(ctx: Ctx): void {
    const { w, h, t, k } = this;
    const span = w + 24;
    for (let i = 0; i < this.count; i++) {
      const layer = this.layerOf[i];
      const star = this.stars[layer * 3 + this.tintOf[i]];
      if (!star) continue;
      const x = wrap(this.sx[i] * span - t * STAR_SPEED[layer] * k, -12, span);
      const twinkle = 1 - this.amp[i] * (0.5 + 0.5 * Math.sin(t * this.freq[i] + this.phase[i]));
      const s = this.spriteSize[layer];
      ctx.globalAlpha = this.ga * STAR_ALPHA[layer] * twinkle;
      ctx.drawImage(star.canvas, x - s * 0.5, this.sy[i] * h - s * 0.5, s, s);
    }
    this.paintShootingStar(ctx);
    const R = this.planetR;
    const bob = Math.sin(t * 0.35) * R * 0.06;
    const left = this.planetLeft;
    this.blit(ctx, this.planet, w * (left ? 0.17 : 0.83), h * 0.2 + bob, R * 4.1, R * 2.4, 0.92);
    this.blit(ctx, this.moon, w * (left ? 0.86 : 0.13), h * 0.78 - bob * 0.7, R * 1.1, R * 1.1, 0.9);
  }

  /** One slow shooting star at a varying moment in every 15 s window. */
  private paintShootingStar(ctx: Ctx): void {
    const streak = this.streak;
    if (!streak) return;
    const period = 15;
    const duration = 1.8;
    const n = Math.floor(this.t / period);
    const start = 4 + hash01(n) * 8;
    const p = (this.t - n * period - start) / duration;
    if (p <= 0 || p >= 1) return;
    const fromLeft = hash01(n * 3 + 1) < 0.5;
    const x0 = this.w * (fromLeft ? 0.1 + 0.4 * hash01(n * 3 + 2) : 0.5 + 0.4 * hash01(n * 3 + 2));
    const y0 = this.h * (0.06 + 0.22 * hash01(n * 3 + 3));
    const angle = fromLeft ? 0.42 : Math.PI - 0.42;
    const dist = this.unit * 0.42 * (1 - (1 - p) * (1 - p));
    ctx.save();
    ctx.translate(x0 + Math.cos(angle) * dist, y0 + Math.sin(angle) * dist);
    ctx.rotate(angle);
    ctx.globalAlpha = this.ga * Math.sin(Math.PI * p) * 0.85;
    ctx.drawImage(streak.canvas, -this.streakLen, -4, streak.w, streak.h);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Underwater (ocean)
// ---------------------------------------------------------------------------

const RAYS = 5;
const BUBBLE_COLS = 6;
const BUBBLES_PER_COL = 6;
const WEED_CLUSTERS = 9;
const WEED_MAX = WEED_CLUSTERS * 3;
const CORALS = 6;

class UnderwaterBackdrop extends BaseBackdrop {
  private readonly rayX = new Float32Array(RAYS);
  private readonly rayTilt = new Float32Array(RAYS);
  private readonly rayPh = new Float32Array(RAYS);
  private readonly rayScale = new Float32Array(RAYS);
  private readonly colX = new Float32Array(BUBBLE_COLS);
  private readonly bOff = new Float32Array(BUBBLE_COLS * BUBBLES_PER_COL);
  private readonly bSpeed = new Float32Array(BUBBLE_COLS * BUBBLES_PER_COL);
  private readonly bSize = new Float32Array(BUBBLE_COLS * BUBBLES_PER_COL);
  private readonly bWob = new Float32Array(BUBBLE_COLS * BUBBLES_PER_COL);
  private readonly bFreq = new Float32Array(BUBBLE_COLS * BUBBLES_PER_COL);
  private readonly bPh = new Float32Array(BUBBLE_COLS * BUBBLES_PER_COL);
  private readonly weedX = new Float32Array(WEED_MAX);
  private readonly weedH = new Float32Array(WEED_MAX);
  private readonly weedW = new Float32Array(WEED_MAX);
  private readonly weedPh = new Float32Array(WEED_MAX);
  private readonly weedShade = new Uint8Array(WEED_MAX);
  private readonly weedCluster = new Uint8Array(WEED_MAX);
  private readonly weedFill: string[];
  private readonly corals: Array<{ x: number; kind: number; size: number; color: Rgb; seed: number }> = [];
  private readonly sand: HillShape;
  private readonly farRocks: HillShape;
  private weeds = 0;
  private cols = 3;
  private clusters = 4;
  private ray: Layer | null = null;
  private rayW = 0;
  private rayH = 0;
  private bubble: Layer | null = null;
  private caustic: Layer | null = null;
  private floorY = 0;
  private floorH = 0;

  constructor(world: World, reduceMotion: boolean) {
    super(world, reduceMotion);
    const rng = this.rng;
    for (let i = 0; i < RAYS; i++) {
      this.rayX[i] = (i + 0.2 + rng() * 0.6) / RAYS;
      this.rayTilt[i] = 0.18 + (rng() - 0.5) * 0.12; // light comes in from the upper left
      this.rayPh[i] = rng() * TAU;
      this.rayScale[i] = 0.7 + rng() * 0.6;
    }
    for (let c = 0; c < BUBBLE_COLS; c++) this.colX[c] = (c + 0.15 + rng() * 0.7) / BUBBLE_COLS;
    shuffleInPlace(this.colX, rng); // the first `cols` columns are spread out at any width
    for (let i = 0; i < BUBBLE_COLS * BUBBLES_PER_COL; i++) {
      this.bOff[i] = rng();
      this.bSpeed[i] = 24 + rng() * 22;
      this.bSize[i] = 3 + rng() * 6;
      this.bWob[i] = 3 + rng() * 7;
      this.bFreq[i] = 0.9 + rng() * 1.1;
      this.bPh[i] = rng() * TAU;
    }
    const clusterX = new Float32Array(WEED_CLUSTERS);
    for (let c = 0; c < WEED_CLUSTERS; c++) clusterX[c] = (c + 0.15 + rng() * 0.7) / WEED_CLUSTERS;
    shuffleInPlace(clusterX, rng);
    for (let c = 0; c < WEED_CLUSTERS; c++) {
      const blades = 2 + Math.floor(rng() * 2);
      for (let b = 0; b < blades && this.weeds < WEED_MAX; b++) {
        const i = this.weeds++;
        this.weedCluster[i] = c;
        this.weedX[i] = clusterX[c] + (b - (blades - 1) / 2) * 0.012;
        this.weedH[i] = (0.13 + rng() * 0.15) * (b === 1 ? 1.15 : 0.9);
        this.weedW[i] = 16 + rng() * 10;
        this.weedPh[i] = rng() * TAU;
        this.weedShade[i] = Math.floor(rng() * 3);
      }
    }
    const kelp = [rgb(47, 158, 110), rgb(70, 176, 122), rgb(38, 132, 100)];
    this.weedFill = kelp.map((k) => css(mix(soften(k, 0.15), this.sky1, 0.32)));
    const coralColors = [rgb(240, 128, 150), rgb(250, 165, 105), rgb(175, 135, 215), rgb(255, 190, 120)];
    for (let i = 0; i < CORALS; i++) {
      const leftSide = i % 2 === 0;
      this.corals.push({
        x: leftSide ? 0.02 + rng() * 0.26 : 0.72 + rng() * 0.26,
        kind: Math.floor(rng() * 3),
        size: 0.7 + rng() * 0.5,
        color: coralColors[Math.floor(rng() * coralColors.length)],
        seed: Math.floor(rng() * 1e9),
      });
    }
    this.sand = makeHill(rng);
    this.farRocks = makeHill(rng);
  }

  protected layout(): void {
    const { w, h, dpr, unit } = this;
    this.floorH = clamp(h * 0.12, 36, 170);
    this.floorY = h - this.floorH;
    this.cols = Math.round(clamp(w / 380, 3, BUBBLE_COLS));
    this.clusters = Math.round(clamp(w / 200, 4, WEED_CLUSTERS));
    this.rayW = clamp(w * 0.16, 90, 420);
    this.rayH = h * 0.9;
    this.ray = release(this.ray);
    // Rays are soft gradients: a quarter-resolution sprite upscales smoothly and saves memory.
    this.ray = sprite(this.rayW, this.rayH, 0.25, (c, rw, rh) => {
      for (let i = 0; i < 4; i++) {
        const f = 1 - i * 0.22;
        const g = c.createLinearGradient(0, 0, 0, rh);
        g.addColorStop(0, css(WHITE, 0.07));
        g.addColorStop(0.6, css(WHITE, 0.03));
        g.addColorStop(1, css(WHITE, 0));
        c.fillStyle = g;
        c.beginPath();
        c.moveTo(rw / 2 - rw * 0.18 * f, 0);
        c.lineTo(rw / 2 + rw * 0.18 * f, 0);
        c.lineTo(rw / 2 + rw * 0.5 * f, rh);
        c.lineTo(rw / 2 - rw * 0.5 * f, rh);
        c.closePath();
        c.fill();
      }
    });
    this.bubble = release(this.bubble);
    this.bubble = sprite(36, 36, dpr * 1.5, (c) => {
      const g = c.createRadialGradient(15, 15, 2, 18, 18, 16);
      g.addColorStop(0, css(WHITE, 0.04));
      g.addColorStop(1, css(WHITE, 0.2));
      c.fillStyle = g;
      c.beginPath();
      c.arc(18, 18, 16, 0, TAU);
      c.fill();
      c.lineWidth = 1.8;
      c.strokeStyle = css(WHITE, 0.6);
      c.stroke();
      c.fillStyle = css(WHITE, 0.85);
      c.beginPath();
      c.ellipse(12.5, 12, 4, 2.4, -0.7, 0, TAU);
      c.fill();
    });
    // Caustic net on the sand: a horizontally wrapping tile of wobbly light rings.
    this.caustic = release(this.caustic);
    const cw = clamp(unit * 0.6, 240, 640);
    const ch = this.floorH;
    const rng = mulberry32(hashString('caustic'));
    this.caustic = sprite(cw, ch, Math.min(dpr, 1.5), (c) => {
      c.strokeStyle = css(WHITE, 0.5);
      c.lineWidth = 1.5;
      for (let i = 0; i < 40; i++) {
        const x = rng() * cw;
        const y = rng() * ch;
        const rx = 10 + rng() * 22;
        const ry = rx * (0.35 + rng() * 0.2);
        for (let o = -1; o <= 1; o++) {
          c.beginPath();
          c.ellipse(x + o * cw, y, rx, ry, (rng() - 0.5) * 0.4, 0, TAU);
          c.stroke();
        }
      }
    });
  }

  protected paintBase(c: Ctx, w: number, h: number): void {
    const { sky0, sky1, floorY, floorH, unit } = this;
    verticalGradient(c, w, h, mix(sky0, WHITE, 0.1), sky1, mix(sky0, sky1, 0.6));
    // Sheen just under the surface
    const sheen = c.createLinearGradient(0, 0, 0, h * 0.14);
    sheen.addColorStop(0, css(WHITE, 0.14));
    sheen.addColorStop(1, css(WHITE, 0));
    c.fillStyle = sheen;
    c.fillRect(0, 0, w, h * 0.14);
    // Distant rocks, almost the colour of the water
    const far = mix(mix(sky1, sky0, 0.25), rgb(10, 30, 50), 0.12);
    fillHill(c, this.farRocks, w, h, floorY - floorH * 0.35, floorH * 0.45, far, far);
    // Sand
    const sandTop = mix(soften(rgb(236, 214, 160), 0.1), sky1, 0.35);
    const sandBottom = mix(rgb(205, 178, 120), sky1, 0.45);
    fillHill(c, this.sand, w, h, floorY + floorH * 0.12, floorH * 0.08, sandTop, sandBottom);
    // Pebbles and a starfish
    const rng = mulberry32(hashString(`sand:${this.world.id}`));
    c.fillStyle = css(mix(sandBottom, rgb(40, 50, 60), 0.2), 0.45);
    for (let i = 0; i < Math.round(w / 30); i++) {
      const x = rng() * w;
      const y = floorY + floorH * (0.35 + rng() * 0.6);
      c.beginPath();
      c.ellipse(x, y, (2 + rng() * 4) * this.k, (1.2 + rng() * 2) * this.k, 0, 0, TAU);
      c.fill();
    }
    const sx = w * (0.35 + rng() * 0.3);
    const sy = floorY + floorH * 0.6;
    const sr = clamp(unit * 0.022, 8, 30);
    c.fillStyle = css(mix(rgb(240, 140, 110), sky1, 0.3));
    c.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 === 0 ? sr : sr * 0.45;
      if (i === 0) c.moveTo(sx + Math.cos(a) * rr, sy + Math.sin(a) * rr * 0.6);
      else c.lineTo(sx + Math.cos(a) * rr, sy + Math.sin(a) * rr * 0.6);
    }
    c.closePath();
    c.lineJoin = 'round';
    c.lineWidth = sr * 0.25;
    c.strokeStyle = c.fillStyle;
    c.fill();
    c.stroke();
    // Coral
    for (const coral of this.corals) {
      const color = mix(soften(coral.color, 0.12), sky1, 0.25);
      const x = coral.x * w;
      const y = floorY + floorH * 0.3;
      const size = unit * 0.16 * coral.size;
      const crng = mulberry32(coral.seed);
      c.fillStyle = css(color);
      c.strokeStyle = css(color);
      c.lineCap = 'round';
      if (coral.kind === 0) {
        branchCoral(c, x, y, size * 0.36, -Math.PI / 2, size * 0.12, 3, crng);
      } else if (coral.kind === 1) {
        // Brain coral mound with soft grooves
        c.beginPath();
        c.ellipse(x, y, size * 0.32, size * 0.24, 0, Math.PI, TAU);
        c.fill();
        c.strokeStyle = css(mix(color, sky1, 0.35), 0.8);
        c.lineWidth = Math.max(1, size * 0.02);
        for (let i = 1; i < 4; i++) {
          c.beginPath();
          c.ellipse(x, y, size * 0.32 * (1 - i * 0.22), size * 0.24 * (1 - i * 0.22), 0, Math.PI * 1.08, Math.PI * 1.92);
          c.stroke();
        }
      } else {
        // Sea fan: ribs radiating from the base, joined by a few arcs
        c.lineWidth = Math.max(1, size * 0.025);
        for (let i = 0; i < 9; i++) {
          const a = -Math.PI * 0.85 + (i / 8) * Math.PI * 0.7;
          c.beginPath();
          c.moveTo(x, y);
          c.quadraticCurveTo(x + Math.cos(a) * size * 0.25, y + Math.sin(a) * size * 0.3, x + Math.cos(a) * size * 0.45, y + Math.sin(a) * size * 0.5);
          c.stroke();
        }
        for (let i = 1; i <= 3; i++) {
          c.beginPath();
          c.ellipse(x, y, size * 0.15 * i, size * 0.165 * i, 0, Math.PI * 1.15, Math.PI * 1.85);
          c.stroke();
        }
      }
    }
  }

  protected paint(ctx: Ctx): void {
    const { w, h, t, k } = this;
    // Light rays sway from the surface
    const ray = this.ray;
    if (ray) {
      for (let i = 0; i < RAYS; i++) {
        const rw = this.rayW * this.rayScale[i];
        const angle = this.rayTilt[i] + Math.sin(t * 0.12 + this.rayPh[i]) * 0.05;
        const alpha = 0.6 + 0.3 * Math.sin(t * 0.18 + this.rayPh[i] * 1.7);
        this.blitRotated(ctx, ray, this.rayX[i] * w, -this.unit * 0.05, rw, this.rayH, 0.5, 0, angle, alpha);
      }
    }
    // Caustic shimmer: two copies of the tile drifting against each other
    const caustic = this.caustic;
    if (caustic) {
      const cw = caustic.w;
      const y = this.floorY + this.floorH * 0.08;
      for (let pass = 0; pass < 2; pass++) {
        const offset = wrap(pass === 0 ? t * 6 * k : cw * 0.37 - t * 4.5 * k, 0, cw);
        ctx.globalAlpha = this.ga * (0.16 + 0.06 * Math.sin(t * 0.4 + pass * 2));
        for (let x = -offset; x < w; x += cw) ctx.drawImage(caustic.canvas, x, y, cw, caustic.h);
      }
    }
    // Seaweed: tapered blades, bending more toward the tip
    ctx.globalAlpha = this.ga;
    ctx.lineJoin = 'round';
    const baseY = this.floorY + this.floorH * 0.4;
    for (let i = 0; i < this.weeds; i++) {
      if (this.weedCluster[i] >= this.clusters) continue;
      const bx = this.weedX[i] * w;
      const bh = this.weedH[i] * this.unit * 1.25;
      const bw = this.weedW[i] * k;
      const sway = Math.sin(t * 0.55 + this.weedPh[i]) * bh * 0.12;
      const sway2 = Math.sin(t * 0.55 + this.weedPh[i] + 1.4) * bh * 0.08;
      const x1 = bx + sway2;
      const x2 = bx + sway * 0.7 - sway2 * 0.5;
      const x3 = bx + sway;
      const y1 = baseY - bh * 0.35;
      const y2 = baseY - bh * 0.7;
      const y3 = baseY - bh;
      ctx.fillStyle = this.weedFill[this.weedShade[i]];
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = bw * 0.3;
      ctx.beginPath();
      ctx.moveTo(bx - bw * 0.5, baseY);
      ctx.bezierCurveTo(x1 - bw * 0.45, y1, x2 - bw * 0.3, y2, x3, y3);
      ctx.bezierCurveTo(x2 + bw * 0.3, y2, x1 + bw * 0.45, y1, bx + bw * 0.5, baseY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke(); // same colour: rounds the tip
    }
    // Bubble columns
    const bubble = this.bubble;
    if (bubble) {
      const margin = 20;
      const span = h + margin * 2;
      for (let col = 0; col < this.cols; col++) {
        const cx = this.colX[col] * w;
        for (let j = 0; j < BUBBLES_PER_COL; j++) {
          const i = col * BUBBLES_PER_COL + j;
          const y = h + margin - wrap(t * this.bSpeed[i] * k + this.bOff[i] * span, 0, span);
          const x = cx + Math.sin(t * this.bFreq[i] + this.bPh[i]) * this.bWob[i] * k;
          const s = this.bSize[i] * k * (1 + 0.4 * (1 - y / h)) * 2;
          this.blit(ctx, bubble, x, y, s, s, 0.75);
        }
      }
    }
  }
}

function shuffleInPlace(a: Float32Array, rng: () => number): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
}

/** Recursive branching coral with rounded tips (static layer only). */
function branchCoral(c: Ctx, x: number, y: number, len: number, angle: number, width: number, depth: number, rng: () => number): void {
  const x2 = x + Math.cos(angle) * len;
  const y2 = y + Math.sin(angle) * len;
  c.lineWidth = width;
  c.beginPath();
  c.moveTo(x, y);
  c.quadraticCurveTo(x + Math.cos(angle + 0.3) * len * 0.5, y + Math.sin(angle + 0.3) * len * 0.5, x2, y2);
  c.stroke();
  if (depth <= 0) {
    c.beginPath();
    c.arc(x2, y2, width * 0.75, 0, TAU);
    c.fill();
    return;
  }
  const branches = rng() < 0.4 ? 3 : 2;
  for (let i = 0; i < branches; i++) {
    const spread = branches === 3 ? (i - 1) * 0.55 : (i === 0 ? -0.45 : 0.45);
    branchCoral(c, x2, y2, len * (0.68 + rng() * 0.12), angle + spread + (rng() - 0.5) * 0.25, width * 0.72, depth - 1, rng);
  }
}

// ---------------------------------------------------------------------------
// Meadow (garden)
// ---------------------------------------------------------------------------

const CLOUD_MAX = 6;
const CLOUD_ASPECT = 0.62;
const TUFT_MAX = 40;
const TUFT_VARIANTS = 4; // the last one carries a daisy

class MeadowBackdrop extends BaseBackdrop {
  private readonly hills: HillShape[];
  private readonly sunLeft: boolean;
  private readonly cX = new Float32Array(CLOUD_MAX);
  private readonly cY = new Float32Array(CLOUD_MAX);
  private readonly cScale = new Float32Array(CLOUD_MAX);
  private readonly cSpeed = new Float32Array(CLOUD_MAX);
  private readonly cVariant = new Uint8Array(CLOUD_MAX);
  private readonly tX = new Float32Array(TUFT_MAX);
  private readonly tScale = new Float32Array(TUFT_MAX);
  private readonly tPh = new Float32Array(TUFT_MAX);
  private readonly tVariant = new Uint8Array(TUFT_MAX);
  private clouds = 3;
  private tufts = 10;
  private sunR = 0;
  private sunX = 0;
  private sunY = 0;
  private cloudW = 0;
  private tuftW = 0;
  private sunBody: Layer | null = null;
  private sunRays: Layer | null = null;
  private cloudSprites: Array<Layer | null> = [];
  private tuftSprites: Array<Layer | null> = [];

  constructor(world: World, reduceMotion: boolean) {
    super(world, reduceMotion);
    const rng = this.rng;
    this.hills = [makeHill(rng), makeHill(rng), makeHill(rng)];
    this.sunLeft = rng() < 0.35;
    for (let i = 0; i < CLOUD_MAX; i++) {
      this.cX[i] = (i + rng() * 0.6) / CLOUD_MAX;
      this.cY[i] = 0.07 + rng() * 0.22;
      this.cScale[i] = 0.7 + rng() * 0.55;
      this.cSpeed[i] = 5 + rng() * 7;
      this.cVariant[i] = i % 2;
    }
    shuffleInPlace(this.cX, rng);
    for (let i = 0; i < TUFT_MAX; i++) {
      this.tX[i] = rng();
      this.tScale[i] = 0.75 + rng() * 0.5;
      this.tPh[i] = rng() * TAU;
      this.tVariant[i] = rng() < 0.18 ? TUFT_VARIANTS - 1 : Math.floor(rng() * (TUFT_VARIANTS - 1));
    }
  }

  protected layout(): void {
    const { w, dpr, unit, sky1 } = this;
    this.clouds = Math.round(clamp(w / 380, 3, CLOUD_MAX));
    this.tufts = Math.round(clamp(w / 55, 10, TUFT_MAX));
    this.sunR = clamp(unit * 0.075, 30, 120);
    this.sunX = this.sunLeft ? this.sunR * 2.3 : w - this.sunR * 2.3;
    this.sunY = this.sunR * 2.1;
    const R = this.sunR;
    this.sunRays = release(this.sunRays);
    this.sunRays = sprite(R * 3.8, R * 3.8, dpr, (c, sw) => {
      const o = sw / 2;
      c.fillStyle = css(rgb(255, 222, 120), 0.5);
      for (let i = 0; i < 12; i++) {
        const a = (i * TAU) / 12;
        const r0 = R * 1.12;
        const r1 = R * (i % 2 === 0 ? 1.8 : 1.55);
        const hw = 0.1;
        c.beginPath();
        c.moveTo(o + Math.cos(a - hw) * r0, o + Math.sin(a - hw) * r0);
        c.lineTo(o + Math.cos(a) * r1, o + Math.sin(a) * r1);
        c.lineTo(o + Math.cos(a + hw) * r0, o + Math.sin(a + hw) * r0);
        c.closePath();
        c.lineJoin = 'round';
        c.lineWidth = R * 0.12;
        c.strokeStyle = c.fillStyle;
        c.fill();
        c.stroke();
      }
    });
    this.sunBody = release(this.sunBody);
    this.sunBody = sprite(R * 2.2, R * 2.2, dpr, (c, sw) => {
      const o = sw / 2;
      const g = c.createRadialGradient(o - R * 0.3, o - R * 0.3, R * 0.1, o, o, R);
      g.addColorStop(0, css(rgb(255, 244, 170)));
      g.addColorStop(1, css(rgb(255, 205, 80)));
      c.fillStyle = g;
      c.beginPath();
      c.arc(o, o, R, 0, TAU);
      c.fill();
      // Sleepy-happy face: closed ∩ eyes, small smile, rosy cheeks
      const ink = css(rgb(205, 125, 50), 0.75);
      c.strokeStyle = ink;
      c.lineCap = 'round';
      c.lineWidth = R * 0.07;
      for (let s = -1; s <= 1; s += 2) {
        c.beginPath();
        c.arc(o + s * R * 0.32, o - R * 0.05, R * 0.12, Math.PI * 1.15, Math.PI * 1.85);
        c.stroke();
      }
      c.beginPath();
      c.arc(o, o + R * 0.12, R * 0.22, Math.PI * 0.2, Math.PI * 0.8);
      c.stroke();
      c.fillStyle = css(rgb(255, 140, 120), 0.35);
      for (let s = -1; s <= 1; s += 2) {
        c.beginPath();
        c.ellipse(o + s * R * 0.55, o + R * 0.18, R * 0.16, R * 0.1, 0, 0, TAU);
        c.fill();
      }
    });
    this.cloudW = clamp(unit * 0.28, 110, 380);
    this.cloudSprites.forEach(release);
    this.cloudSprites = [];
    for (let v = 0; v < 2; v++) {
      const cw = this.cloudW;
      const rng = mulberry32(hashString(`cloud${v}`));
      this.cloudSprites.push(sprite(cw, cw * CLOUD_ASPECT, dpr, (c, sw, sh) => {
        drawPuffyCloud(c, sw / 2, sh * 0.58, sw * 0.92, css(WHITE, 0.95), rng);
        // Soft blue-grey underside, only where the cloud is
        c.globalCompositeOperation = 'source-atop';
        const g = c.createLinearGradient(0, sh * 0.35, 0, sh);
        g.addColorStop(0, css(WHITE, 0));
        g.addColorStop(1, css(mix(sky1, rgb(150, 170, 200), 0.6), 0.45));
        c.fillStyle = g;
        c.fillRect(0, 0, sw, sh);
        c.globalCompositeOperation = 'source-over';
      }));
    }
    this.tuftW = clamp(unit * 0.06, 22, 80);
    this.tuftSprites.forEach(release);
    this.tuftSprites = [];
    const greens = [rgb(86, 170, 80), rgb(110, 190, 95), rgb(70, 150, 75)].map((g) => mix(soften(g, 0.1), sky1, 0.08));
    for (let v = 0; v < TUFT_VARIANTS; v++) {
      const rng = mulberry32(hashString(`tuft${v}`));
      const daisy = v === TUFT_VARIANTS - 1;
      const tw = this.tuftW;
      const th = tw * (daisy ? 1.6 : 1.1);
      this.tuftSprites.push(sprite(tw, th, dpr, (c) => {
        if (daisy) {
          const hx = tw * 0.58;
          const hy = tw * 0.32;
          c.strokeStyle = css(greens[2]);
          c.lineWidth = Math.max(1.5, tw * 0.05);
          c.lineCap = 'round';
          c.beginPath();
          c.moveTo(tw * 0.5, th);
          c.quadraticCurveTo(tw * 0.48, th * 0.5, hx, hy);
          c.stroke();
          c.fillStyle = css(WHITE, 0.95);
          for (let p = 0; p < 8; p++) {
            const a = (p * TAU) / 8;
            c.beginPath();
            c.ellipse(hx + Math.cos(a) * tw * 0.12, hy + Math.sin(a) * tw * 0.12, tw * 0.1, tw * 0.05, a, 0, TAU);
            c.fill();
          }
          c.fillStyle = css(rgb(255, 205, 70));
          c.beginPath();
          c.arc(hx, hy, tw * 0.07, 0, TAU);
          c.fill();
        }
        const blades = 5 + Math.floor(rng() * 3);
        const bladeH = tw * 1.1;
        for (let b = 0; b < blades; b++) {
          const f = blades === 1 ? 0 : b / (blades - 1) - 0.5;
          const angle = f * 1.0 + (rng() - 0.5) * 0.2;
          const len = bladeH * (0.6 + rng() * 0.4);
          const bx = tw * 0.5 + f * tw * 0.35;
          const bw = tw * 0.07;
          const tipX = bx + Math.sin(angle) * len;
          const tipY = th - Math.cos(angle) * len;
          const cx = bx + Math.sin(angle) * len * 0.3;
          const cy = th - len * 0.6;
          c.fillStyle = css(greens[Math.floor(rng() * greens.length)]);
          c.beginPath();
          c.moveTo(bx - bw, th);
          c.quadraticCurveTo(cx - bw * 0.3, cy, tipX, tipY);
          c.quadraticCurveTo(cx + bw * 0.3, cy, bx + bw, th);
          c.closePath();
          c.fill();
        }
      }));
    }
  }

  protected paintBase(c: Ctx, w: number, h: number): void {
    const { sky0, sky1 } = this;
    verticalGradient(c, w, h, sky0, sky1);
    glow(c, this.sunX, this.sunY, this.sunR * 4.2, rgb(255, 240, 180), 0.45);
    const layers = [
      { base: 0.62, amp: 0.045, color: rgb(150, 205, 140), haze: 0.45, flowers: 0, size: 0 },
      { base: 0.72, amp: 0.04, color: rgb(120, 195, 110), haze: 0.22, flowers: 1 / 32, size: 2.2 },
      { base: 0.84, amp: 0.035, color: rgb(95, 180, 90), haze: 0.1, flowers: 1 / 18, size: 3.4 },
    ];
    const petals = [WHITE, rgb(255, 170, 200), rgb(255, 225, 110), rgb(200, 170, 255)].map((p) => css(soften(p, 0.15)));
    const rng = mulberry32(hashString(`meadow:${this.world.id}`));
    layers.forEach((layer, i) => {
      const color = mix(soften(layer.color, 0.1), sky1, layer.haze);
      const shape = this.hills[i];
      const base = layer.base * h;
      const amp = layer.amp * h;
      fillHill(c, shape, w, h, base, amp, mix(color, WHITE, 0.12), mix(color, rgb(40, 90, 50), 0.12));
      if (i === 1) {
        // A few lollipop trees on the middle hill
        for (let tIdx = 0; tIdx < 3; tIdx++) {
          const x = w * (0.15 + tIdx * 0.3 + rng() * 0.12);
          const y = hillY(shape, x, w, base, amp) + 4;
          const s = clamp(this.unit * 0.028, 10, 40);
          c.fillStyle = css(mix(rgb(120, 90, 70), sky1, 0.3));
          c.fillRect(x - s * 0.12, y - s * 1.6, s * 0.24, s * 1.6);
          c.fillStyle = css(mix(color, rgb(40, 110, 60), 0.35));
          c.beginPath();
          c.arc(x, y - s * 1.8, s, 0, TAU);
          c.fill();
        }
      }
      if (layer.flowers > 0) {
        const next = layers[i + 1];
        const pr = Math.max(1.5, layer.size * this.k);
        const count = Math.round(w * layer.flowers);
        for (let f = 0; f < count; f++) {
          const x = rng() * w;
          const top = hillY(shape, x, w, base, amp) + pr * 3;
          const bottom = next ? Math.min(h, hillY(this.hills[i + 1], x, w, next.base * h, next.amp * h)) - pr : h - pr;
          if (bottom <= top) continue;
          const y = top + rng() * (bottom - top);
          c.fillStyle = petals[Math.floor(rng() * petals.length)];
          c.beginPath();
          for (let p = 0; p < 5; p++) {
            const a = (p * TAU) / 5;
            const px = x + Math.cos(a) * pr * 0.9;
            const py = y + Math.sin(a) * pr * 0.9;
            c.moveTo(px + pr * 0.6, py);
            c.arc(px, py, pr * 0.6, 0, TAU);
          }
          c.fill();
          c.fillStyle = css(rgb(255, 200, 70));
          c.beginPath();
          c.arc(x, y, pr * 0.5, 0, TAU);
          c.fill();
        }
      }
    });
  }

  protected paint(ctx: Ctx): void {
    const { w, h, t, k } = this;
    const R = this.sunR;
    this.blitRotated(ctx, this.sunRays, this.sunX, this.sunY, R * 3.8, R * 3.8, 0.5, 0.5, t * 0.05, 1);
    this.blit(ctx, this.sunBody, this.sunX, this.sunY, R * 2.2, R * 2.2, 1);
    for (let i = 0; i < this.clouds; i++) {
      const cw = this.cloudW * this.cScale[i];
      const span = w + cw * 2;
      const x = wrap(this.cX[i] * span + t * this.cSpeed[i] * k, -cw, span);
      this.blit(ctx, this.cloudSprites[this.cVariant[i]] ?? null, x, this.cY[i] * h, cw, cw * CLOUD_ASPECT, 0.95);
    }
    const tw = this.tuftW;
    for (let i = 0; i < this.tufts; i++) {
      const v = this.tVariant[i];
      const s = this.tScale[i];
      const th = tw * (v === TUFT_VARIANTS - 1 ? 1.6 : 1.1);
      const x = this.tX[i] * w;
      const sway = 0.07 * Math.sin(t * 0.8 + this.tPh[i]) + 0.03 * Math.sin(t * 0.23 + x * 0.004);
      this.blitRotated(ctx, this.tuftSprites[v] ?? null, x, h + 3, tw * s, th * s, 0.5, 1, sway, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Party
// ---------------------------------------------------------------------------

const BOKEH_MAX = 24;
const BULB_MAX = 64;

class PartyBackdrop extends BaseBackdrop {
  private readonly colors: Rgb[];
  private readonly bX = new Float32Array(BOKEH_MAX);
  private readonly bY = new Float32Array(BOKEH_MAX);
  private readonly bR = new Float32Array(BOKEH_MAX);
  private readonly bVX = new Float32Array(BOKEH_MAX);
  private readonly bVY = new Float32Array(BOKEH_MAX);
  private readonly bAlpha = new Float32Array(BOKEH_MAX);
  private readonly bPh = new Float32Array(BOKEH_MAX);
  private readonly bColor = new Uint8Array(BOKEH_MAX);
  private readonly bulbX = new Float32Array(BULB_MAX);
  private readonly bulbY = new Float32Array(BULB_MAX);
  private readonly bulbColor = new Uint8Array(BULB_MAX);
  private bokehCount = 10;
  private bulbs = 0;
  private bulbR = 0;
  private bokehSprites: Array<Layer | null> = [];
  private glowSprites: Array<Layer | null> = [];

  constructor(world: World, reduceMotion: boolean) {
    super(world, reduceMotion);
    const rng = this.rng;
    this.colors = this.softPalette(0.22).slice(0, 8);
    for (let i = 0; i < BOKEH_MAX; i++) {
      this.bX[i] = rng();
      this.bY[i] = rng();
      this.bR[i] = 0.04 + rng() * 0.09;
      const a = rng() * TAU;
      const speed = 2 + rng() * 6;
      this.bVX[i] = Math.cos(a) * speed;
      this.bVY[i] = Math.sin(a) * speed - 2; // mostly drifting up
      this.bAlpha[i] = 0.1 + rng() * 0.14;
      this.bPh[i] = rng() * TAU;
      this.bColor[i] = Math.floor(rng() * (this.colors.length + 1)); // last index = warm white
    }
  }

  private colorAt(i: number): Rgb {
    return i < this.colors.length ? this.colors[i] : rgb(255, 236, 210);
  }

  protected layout(): void {
    const { w, h, dpr, unit } = this;
    this.bokehCount = Math.round(clamp((w * h) / 90000, 10, BOKEH_MAX));
    this.bokehSprites.forEach(release);
    this.bokehSprites = [];
    for (let i = 0; i <= this.colors.length; i++) {
      const color = this.colorAt(i);
      // Soft discs: low resolution is fine, they are blurred light.
      this.bokehSprites.push(sprite(128, 128, 1, (c) => {
        const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
        g.addColorStop(0, css(color, 0.55));
        g.addColorStop(0.72, css(color, 0.62));
        g.addColorStop(0.9, css(color, 0.75));
        g.addColorStop(1, css(color, 0));
        c.fillStyle = g;
        c.fillRect(0, 0, 128, 128);
      }));
    }
    // String lights hang in swags along the top
    this.bulbR = clamp(unit * 0.012, 4, 14);
    const spacing = clamp(unit * 0.075, 34, 110);
    const swags = w > 900 ? 3 : 2;
    const anchorY = h * 0.035;
    const sag = clamp(h * 0.09, 30, 120);
    this.bulbs = 0;
    for (let x = spacing * 0.5; x < w && this.bulbs < BULB_MAX; x += spacing) {
      const i = this.bulbs++;
      const u = (x / (w / swags)) % 1;
      this.bulbX[i] = x;
      this.bulbY[i] = anchorY + sag * 4 * u * (1 - u) + this.bulbR * 1.6;
      this.bulbColor[i] = i % this.colors.length;
    }
    this.glowSprites.forEach(release);
    this.glowSprites = this.colors.map((c) => glowSprite(this.bulbR * 4.5, mix(c, WHITE, 0.3), Math.min(dpr, 1.5)));
  }

  protected paintBase(c: Ctx, w: number, h: number): void {
    const { sky0, sky1, unit } = this;
    verticalGradient(c, w, h, sky0, sky1);
    glow(c, w * 0.5, h * 1.05, Math.max(w, h) * 0.7, rgb(255, 170, 120), 0.18);
    // Soft vignette keeps the eye in the middle
    const v = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.6);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(10,0,20,0.28)');
    c.fillStyle = v;
    c.fillRect(0, 0, w, h);
    // Bunting along the very top
    const flagW = clamp(unit * 0.06, 26, 80);
    const flagH = flagW * 1.1;
    const wire = css(rgb(255, 230, 240), 0.35);
    c.strokeStyle = wire;
    c.lineWidth = Math.max(1, unit * 0.002);
    const buntingY = h * 0.012;
    const buntingSag = clamp(h * 0.04, 14, 50);
    const swagW = w / 2;
    const yAt = (x: number) => {
      const u = (x / swagW) % 1;
      return buntingY + buntingSag * 4 * u * (1 - u);
    };
    c.beginPath();
    for (let x = 0; x <= w; x += 8) {
      if (x === 0) c.moveTo(x, yAt(x));
      else c.lineTo(x, yAt(x));
    }
    c.stroke();
    let idx = 0;
    c.lineJoin = 'round';
    for (let x = flagW * 0.7; x < w - flagW * 0.3; x += flagW * 1.25) {
      const color = mix(this.colors[idx++ % this.colors.length], sky0, 0.15);
      const y0 = yAt(x - flagW / 2);
      const y1 = yAt(x + flagW / 2);
      c.fillStyle = css(color, 0.85);
      c.strokeStyle = css(color, 0.85);
      c.lineWidth = flagW * 0.08;
      c.beginPath();
      c.moveTo(x - flagW / 2, y0);
      c.lineTo(x + flagW / 2, y1);
      c.lineTo(x, (y0 + y1) / 2 + flagH);
      c.closePath();
      c.fill();
      c.stroke();
    }
    // Light string wire + bulb bodies (the glow is animated)
    const swags = w > 900 ? 3 : 2;
    const lightSwag = w / swags;
    const anchorY = h * 0.035;
    const sag = clamp(h * 0.09, 30, 120);
    c.strokeStyle = css(rgb(40, 20, 50), 0.6);
    c.lineWidth = Math.max(1.2, unit * 0.0025);
    c.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const u = (x / lightSwag) % 1;
      const y = anchorY + sag * 4 * u * (1 - u);
      if (x === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
    const br = this.bulbR;
    for (let i = 0; i < this.bulbs; i++) {
      const x = this.bulbX[i];
      const y = this.bulbY[i];
      c.fillStyle = css(rgb(60, 40, 70));
      c.fillRect(x - br * 0.45, y - br * 1.7, br * 0.9, br * 0.8);
      const color = this.colors[this.bulbColor[i]];
      const g = c.createRadialGradient(x - br * 0.3, y - br * 0.3, br * 0.1, x, y, br * 1.1);
      g.addColorStop(0, css(mix(color, WHITE, 0.6)));
      g.addColorStop(1, css(color));
      c.fillStyle = g;
      c.beginPath();
      c.ellipse(x, y, br * 0.75, br, 0, 0, TAU);
      c.fill();
    }
  }

  protected paint(ctx: Ctx): void {
    const { w, h, t, k, unit } = this;
    for (let i = 0; i < this.bokehCount; i++) {
      const r = this.bR[i] * unit;
      const x = wrap(this.bX[i] * (w + r * 2) + this.bVX[i] * t * k, -r, w + r * 2);
      const y = wrap(this.bY[i] * (h + r * 2) + this.bVY[i] * t * k, -r, h + r * 2);
      const alpha = this.bAlpha[i] * (0.85 + 0.15 * Math.sin(t * 0.35 + this.bPh[i]));
      this.blit(ctx, this.bokehSprites[this.bColor[i]] ?? null, x, y, r * 2, r * 2, alpha);
    }
    // Bulbs glow with a slow travelling pulse (0.22 Hz, never blinking off)
    const gs = this.bulbR * 9;
    for (let i = 0; i < this.bulbs; i++) {
      const alpha = 0.6 + 0.3 * Math.sin(TAU * 0.22 * t - i * 0.6);
      this.blit(ctx, this.glowSprites[this.bulbColor[i]] ?? null, this.bulbX[i], this.bulbY[i], gs, gs, alpha);
    }
  }
}

// ---------------------------------------------------------------------------
// Bubbles
// ---------------------------------------------------------------------------

const FAR_BUBBLES = 18;
const NEAR_BUBBLES = 10;

class BubblesBackdrop extends BaseBackdrop {
  private readonly x = new Float32Array(FAR_BUBBLES + NEAR_BUBBLES);
  private readonly y = new Float32Array(FAR_BUBBLES + NEAR_BUBBLES);
  private readonly r = new Float32Array(FAR_BUBBLES + NEAR_BUBBLES);
  private readonly speed = new Float32Array(FAR_BUBBLES + NEAR_BUBBLES);
  private readonly wobble = new Float32Array(FAR_BUBBLES + NEAR_BUBBLES);
  private readonly wobbleFreq = new Float32Array(FAR_BUBBLES + NEAR_BUBBLES);
  private readonly ph = new Float32Array(FAR_BUBBLES + NEAR_BUBBLES);
  private readonly washes: Array<{ x: number; y: number; color: Rgb; alpha: number }>;
  private far = 8;
  private near = 4;
  private bubble: Layer | null = null;
  private spriteR = 0;

  constructor(world: World, reduceMotion: boolean) {
    super(world, reduceMotion);
    const rng = this.rng;
    for (let i = 0; i < FAR_BUBBLES + NEAR_BUBBLES; i++) {
      const isNear = i >= FAR_BUBBLES;
      this.x[i] = rng();
      this.y[i] = rng();
      this.r[i] = isNear ? 0.06 + rng() * 0.07 : 0.02 + rng() * 0.025;
      this.speed[i] = isNear ? 14 + rng() * 12 : 9 + rng() * 8;
      this.wobble[i] = isNear ? 10 + rng() * 14 : 5 + rng() * 8;
      this.wobbleFreq[i] = 0.25 + rng() * 0.3;
      this.ph[i] = rng() * TAU;
    }
    this.washes = [
      { x: 0.2, y: 0.3, color: rgb(255, 170, 210), alpha: 0.25 },
      { x: 0.82, y: 0.72, color: rgb(160, 240, 210), alpha: 0.22 },
      { x: 0.62, y: 0.12, color: rgb(200, 180, 255), alpha: 0.2 },
    ].map((wash) => ({ ...wash, x: clamp(wash.x + (rng() - 0.5) * 0.2, 0, 1), y: clamp(wash.y + (rng() - 0.5) * 0.2, 0, 1) }));
  }

  protected layout(): void {
    const { w, h, unit, dpr } = this;
    this.far = Math.round(clamp((w * h) / 110000, 8, FAR_BUBBLES));
    this.near = Math.round(clamp((w * h) / 260000, 4, NEAR_BUBBLES));
    this.spriteR = clamp(unit * 0.13, 24, 200);
    const R = this.spriteR;
    this.bubble = release(this.bubble);
    this.bubble = sprite(R * 2 + 4, R * 2 + 4, Math.min(dpr, 1.5), (c, sw) => {
      const o = sw / 2;
      const body = c.createRadialGradient(o - R * 0.2, o - R * 0.2, R * 0.1, o, o, R);
      body.addColorStop(0, css(WHITE, 0.02));
      body.addColorStop(0.75, css(WHITE, 0.07));
      body.addColorStop(1, css(WHITE, 0.24));
      c.fillStyle = body;
      c.beginPath();
      c.arc(o, o, R, 0, TAU);
      c.fill();
      // Iridescent rim: overlapping soft arcs of pink, gold, aqua and violet
      const hues = [rgb(255, 140, 200), rgb(255, 222, 120), rgb(120, 228, 220), rgb(170, 140, 255)];
      c.lineCap = 'round';
      c.lineWidth = R * 0.075;
      hues.forEach((hue, i) => {
        c.strokeStyle = css(hue, 0.42);
        c.beginPath();
        c.arc(o, o, R * 0.93, (i * TAU) / 4 + 0.3, ((i + 1) * TAU) / 4 + 0.55);
        c.stroke();
      });
      c.lineWidth = Math.max(1, R * 0.02);
      c.strokeStyle = css(WHITE, 0.6);
      c.beginPath();
      c.arc(o, o, R * 0.985, 0, TAU);
      c.stroke();
      // Window highlight + sparkle + a faint lower reflection
      c.fillStyle = css(WHITE, 0.65);
      c.beginPath();
      c.ellipse(o - R * 0.38, o - R * 0.42, R * 0.2, R * 0.11, -0.7, 0, TAU);
      c.fill();
      c.beginPath();
      c.arc(o - R * 0.12, o - R * 0.62, R * 0.05, 0, TAU);
      c.fill();
      c.strokeStyle = css(WHITE, 0.3);
      c.lineWidth = R * 0.04;
      c.beginPath();
      c.arc(o, o, R * 0.78, Math.PI * 0.15, Math.PI * 0.45);
      c.stroke();
    });
  }

  protected paintBase(c: Ctx, w: number, h: number): void {
    verticalGradient(c, w, h, this.sky0, this.sky1);
    const big = Math.max(w, h);
    for (const wash of this.washes) glow(c, wash.x * w, wash.y * h, big * 0.5, wash.color, wash.alpha);
  }

  protected paint(ctx: Ctx): void {
    if (!this.bubble) return;
    for (let i = 0; i < this.far; i++) this.paintBubble(ctx, this.bubble, i, 0.5);
    for (let i = 0; i < this.near; i++) this.paintBubble(ctx, this.bubble, FAR_BUBBLES + i, 0.88);
  }

  /** Bubbles rise and wrap from the bottom, wobbling sideways and "breathing" a little. */
  private paintBubble(ctx: Ctx, bubble: Layer, i: number, alpha: number): void {
    const { w, h, t, k } = this;
    const r = this.r[i] * this.unit;
    const span = h + r * 2;
    const y = wrap(this.y[i] * span - t * this.speed[i] * k, -r, span);
    const x = this.x[i] * w + Math.sin(t * this.wobbleFreq[i] + this.ph[i]) * this.wobble[i] * k;
    const breathe = 0.025 * Math.sin(t * 0.9 + this.ph[i]);
    const size = (bubble.w * r) / this.spriteR; // sprite includes a 2 px margin around the rim
    this.blit(ctx, bubble, x, y, size * (1 + breathe), size * (1 - breathe), alpha);
  }
}

// ---------------------------------------------------------------------------
// Jungle (dino)
// ---------------------------------------------------------------------------

const PALMS = 3;
const FERNS = 4;
const SMOKE_PUFFS = 4;

class JungleBackdrop extends BaseBackdrop {
  private readonly volcanoX: number;
  private readonly treeline: HillShape;
  private readonly ground: HillShape;
  private readonly palmX = new Float32Array(PALMS);
  private readonly palmScale = new Float32Array(PALMS);
  private readonly palmPh = new Float32Array(PALMS);
  private readonly fernX = new Float32Array(FERNS);
  private readonly fernScale = new Float32Array(FERNS);
  private readonly fernPh = new Float32Array(FERNS);
  private readonly farPalms: Array<{ x: number; s: number; lean: number; seed: number }> = [];
  private readonly seed: number;
  /** Silhouette tones derived from the sky, each nearer layer darker, so it reads on light or dark skies. */
  private readonly tones: { rock: Rgb; far: Rgb; ground: Rgb; mid: Rgb; trunk: Rgb; near: Rgb };
  private palmH = 0;
  private fernW = 0;
  private peakX = 0;
  private peakY = 0;
  private craterW = 0;
  private volcanoHalf = 0;
  private palms: Array<Layer | null> = [];
  private ferns: Array<Layer | null> = [];
  private smoke: Layer | null = null;

  constructor(world: World, reduceMotion: boolean) {
    super(world, reduceMotion);
    const rng = this.rng;
    this.volcanoX = rng() < 0.5 ? 0.3 + rng() * 0.08 : 0.62 + rng() * 0.08;
    this.treeline = makeHill(rng);
    this.ground = makeHill(rng);
    const palmSlots = [0.07, 0.9, 0.22];
    for (let i = 0; i < PALMS; i++) {
      this.palmX[i] = palmSlots[i] + (rng() - 0.5) * 0.06;
      this.palmScale[i] = i === 2 ? 0.7 : 0.9 + rng() * 0.2;
      this.palmPh[i] = rng() * TAU;
    }
    const fernSlots = [0.0, 0.14, 0.86, 1.0];
    for (let i = 0; i < FERNS; i++) {
      this.fernX[i] = fernSlots[i] + (rng() - 0.5) * 0.05;
      this.fernScale[i] = 0.8 + rng() * 0.4;
      this.fernPh[i] = rng() * TAU;
    }
    for (let i = 0; i < 4; i++) {
      this.farPalms.push({ x: (i + 0.2 + rng() * 0.6) / 4, s: 0.6 + rng() * 0.3, lean: rng() < 0.5 ? -1 : 1, seed: Math.floor(rng() * 1e9) });
    }
    this.seed = Math.floor(rng() * 1e9);
    const { sky0, sky1 } = this;
    const leaf = rgb(30, 90, 50);
    const shadow = rgb(4, 16, 9);
    this.tones = {
      rock: mix(mix(sky0, sky1, 0.3), rgb(80, 60, 95), 0.4),
      far: mix(mix(mix(sky0, sky1, 0.66), leaf, 0.25), shadow, 0.25),
      ground: mix(mix(sky1, leaf, 0.3), shadow, 0.3),
      mid: mix(mix(sky1, leaf, 0.25), shadow, 0.45),
      trunk: mix(mix(sky1, rgb(70, 50, 35), 0.35), shadow, 0.4),
      near: mix(mix(sky1, leaf, 0.2), shadow, 0.6),
    };
  }

  protected layout(): void {
    const { w, h, unit, dpr } = this;
    this.palmH = clamp(unit * 0.55, 140, 640);
    this.fernW = clamp(unit * 0.34, 90, 400);
    this.peakX = w * this.volcanoX;
    // Height follows width so the cone stays a friendly shape on narrow screens.
    this.volcanoHalf = Math.min(w * 0.3, unit * 0.6);
    this.peakY = h * 0.66 - Math.min(h * 0.36, this.volcanoHalf);
    this.craterW = Math.min(w * 0.06, unit * 0.1);
    // Palm/fern sprites are silhouettes: cap resolution to keep memory modest.
    const scale = Math.min(dpr, 1.5);
    const { trunk, mid, near } = this.tones;
    this.palms.forEach(release);
    this.palms = [0, 1].map((v) => {
      const ph = this.palmH;
      const rng = mulberry32(this.seed + v);
      return sprite(ph, ph, scale, (c, sw, sh) => drawPalm(c, sw * 0.4, sh, sh, trunk, mid, 1, rng));
    });
    this.ferns.forEach(release);
    this.ferns = [0, 1].map((v) => {
      const fw = this.fernW;
      const rng = mulberry32(this.seed + 10 + v);
      return sprite(fw, fw * 0.75, scale, (c, sw, sh) => drawFern(c, sw / 2, sh, sw * 0.55, near, rng));
    });
    this.smoke = release(this.smoke);
    this.smoke = glowSprite(64, rgb(245, 240, 235), 1);
  }

  protected paintBase(c: Ctx, w: number, h: number): void {
    const { sky0, sky1, unit, tones } = this;
    verticalGradient(c, w, h, sky0, sky1);
    glow(c, w * 0.5, h * 0.66, Math.max(w, h) * 0.6, rgb(255, 228, 165), 0.24); // warm haze
    // Volcano, hazy and low-contrast
    const horizon = h * 0.66;
    const half = this.volcanoHalf;
    const px = this.peakX;
    const py = this.peakY;
    const cw = this.craterW;
    const rock = tones.rock;
    const shade = c.createLinearGradient(px - half, 0, px + half, 0);
    shade.addColorStop(0, css(mix(rock, WHITE, 0.08)));
    shade.addColorStop(1, css(mix(rock, rgb(40, 30, 60), 0.15)));
    c.fillStyle = shade;
    c.beginPath();
    c.moveTo(px - half, horizon);
    c.quadraticCurveTo(px - cw * 1.4, py + h * 0.08, px - cw / 2, py);
    c.lineTo(px + cw / 2, py);
    c.quadraticCurveTo(px + cw * 1.4, py + h * 0.08, px + half, horizon);
    c.closePath();
    c.fill();
    glow(c, px, py, cw * 1.6, rgb(255, 150, 80), 0.32);
    c.fillStyle = css(rgb(255, 150, 80), 0.5);
    c.beginPath();
    c.ellipse(px, py + 1, cw * 0.5, cw * 0.11, 0, 0, TAU);
    c.fill();
    // Far treeline with a few small palms on it
    const far = tones.far;
    const lineBase = h * 0.66;
    const bump = clamp(unit * 0.035, 12, 50);
    c.fillStyle = css(far);
    c.beginPath();
    for (let x = -bump; x < w + bump; x += bump * 1.1) {
      const y = hillY(this.treeline, x, w, lineBase, bump * 0.9);
      c.moveTo(x + bump * 1.2, y);
      c.arc(x, y, bump * 1.2, 0, TAU);
    }
    c.fill();
    c.fillRect(0, lineBase, w, h - lineBase);
    for (const p of this.farPalms) {
      const x = p.x * w;
      const height = this.palmH * 0.45 * p.s;
      drawPalm(c, x, hillY(this.treeline, x, w, lineBase, bump * 0.9) + bump * 0.6, height, far, far, p.lean, mulberry32(p.seed));
    }
    // Mid ground
    fillHill(c, this.ground, w, h, h * 0.9, h * 0.02, mix(tones.ground, WHITE, 0.06), mix(tones.ground, rgb(4, 16, 9), 0.2));
    // Canopy: fronds hanging into the top corners, and a few vines
    const rng = mulberry32(this.seed + 99);
    const size = clamp(unit * 0.3, 80, 360);
    for (let side = 0; side < 2; side++) {
      const left = side === 0;
      const x0 = left ? -size * 0.05 : w + size * 0.05;
      const from = left ? Math.PI * 0.02 : Math.PI * 0.5;
      const to = left ? Math.PI * 0.5 : Math.PI * 0.98;
      drawFern(c, x0, -size * 0.08, size, tones.mid, rng, from, to);
      drawFern(c, left ? size * 0.55 : w - size * 0.55, -size * 0.12, size * 0.6, tones.mid, rng, from, to);
      c.strokeStyle = css(tones.mid);
      c.fillStyle = css(tones.mid);
      for (let v = 0; v < 3; v++) {
        const vx = left ? w * (0.04 + v * 0.07 + rng() * 0.03) : w * (0.96 - v * 0.07 - rng() * 0.03);
        const len = h * (0.12 + rng() * 0.16);
        const bend = (rng() - 0.5) * size * 0.3;
        c.lineWidth = Math.max(1.5, unit * 0.004);
        c.beginPath();
        c.moveTo(vx, 0);
        c.quadraticCurveTo(vx + bend, len * 0.5, vx + bend * 0.3, len);
        c.stroke();
        for (let s = 0.2; s < 1; s += 0.16) {
          const it = 1 - s;
          const lx = 2 * it * s * (vx + bend) + s * s * (vx + bend * 0.3) + it * it * vx;
          const ly = 2 * it * s * len * 0.5 + s * s * len;
          const leaf = clamp(unit * 0.012, 4, 14);
          const dir = Math.round(s * 6.25) % 2 === 0 ? 1 : -1;
          c.beginPath();
          c.ellipse(lx + dir * leaf * 0.8, ly, leaf, leaf * 0.45, dir * 0.5, 0, TAU);
          c.fill();
        }
      }
    }
  }

  protected paint(ctx: Ctx): void {
    const { w, h, t, unit } = this;
    // Smoke puffs rise, grow and fade on a loop
    const smoke = this.smoke;
    if (smoke) {
      for (let i = 0; i < SMOKE_PUFFS; i++) {
        const p = wrap(t * 0.045 + i / SMOKE_PUFFS, 0, 1);
        const x = this.peakX + p * unit * 0.06 + Math.sin(p * 4 + i) * unit * 0.01;
        const y = this.peakY - p * unit * 0.22;
        const size = this.craterW * (0.9 + 2.6 * p);
        this.blit(ctx, smoke, x, y, size, size, 0.34 * Math.sin(Math.PI * p));
      }
    }
    const ph = this.palmH;
    for (let i = 0; i < PALMS; i++) {
      const s = this.palmScale[i];
      const sway = 0.015 * Math.sin(t * 0.45 + this.palmPh[i]);
      const flip = this.palmX[i] > 0.5;
      this.blitRotated(ctx, this.palms[i % 2] ?? null, this.palmX[i] * w, h * 0.93, ph * s, ph * s, 0.4, 1, sway, 1, flip);
    }
    const fw = this.fernW;
    for (let i = 0; i < FERNS; i++) {
      const s = this.fernScale[i];
      const sway = 0.03 * Math.sin(t * 0.6 + this.fernPh[i]);
      this.blitRotated(ctx, this.ferns[i % 2] ?? null, this.fernX[i] * w, h + 6, fw * s, fw * 0.75 * s, 0.5, 1, sway, 1, i >= 2);
    }
  }
}

// ---------------------------------------------------------------------------
// Night
// ---------------------------------------------------------------------------

const NIGHT_STARS = 150;
const FIREFLIES = 12;
const WISPS = 2;

class NightBackdrop extends BaseBackdrop {
  private readonly sx = new Float32Array(NIGHT_STARS);
  private readonly sy = new Float32Array(NIGHT_STARS);
  private readonly phase = new Float32Array(NIGHT_STARS);
  private readonly freq = new Float32Array(NIGHT_STARS);
  private readonly big = new Uint8Array(NIGHT_STARS);
  private readonly hidden = new Uint8Array(NIGHT_STARS);
  private readonly fx = new Float32Array(FIREFLIES * 9);
  private readonly wispY = new Float32Array(WISPS);
  private readonly wispX = new Float32Array(WISPS);
  private readonly hills: HillShape[];
  private stars = 40;
  private flies = 5;
  private moonR = 0;
  private moonX = 0;
  private moonY = 0;
  private smallStar: Layer | null = null;
  private bigStar: Layer | null = null;
  private firefly: Layer | null = null;
  private wisp: Layer | null = null;
  private starSize = 0;
  private bigSize = 0;

  constructor(world: World, reduceMotion: boolean) {
    super(world, reduceMotion);
    const rng = this.rng;
    for (let i = 0; i < NIGHT_STARS; i++) {
      this.sx[i] = rng();
      this.sy[i] = rng() * 0.7;
      this.phase[i] = rng() * TAU;
      this.freq[i] = 0.25 + rng() * 0.45; // slower than space: 9–25 s
      this.big[i] = rng() < 0.15 ? 1 : 0;
    }
    // Stratified, then shuffled, so the visible subset is spread across any width.
    const centres = new Float32Array(FIREFLIES);
    for (let i = 0; i < FIREFLIES; i++) centres[i] = (i + 0.2 + rng() * 0.6) / FIREFLIES;
    shuffleInPlace(centres, rng);
    for (let i = 0; i < FIREFLIES; i++) {
      const o = i * 9;
      this.fx[o] = centres[i]; // centre x
      this.fx[o + 1] = 0.7 + rng() * 0.24; // centre y
      this.fx[o + 2] = 20 + rng() * 40; // x amplitude
      this.fx[o + 3] = 10 + rng() * 22; // y amplitude
      this.fx[o + 4] = 0.12 + rng() * 0.18; // x angular speed
      this.fx[o + 5] = 0.17 + rng() * 0.22; // y angular speed
      this.fx[o + 6] = rng() * TAU;
      this.fx[o + 7] = rng() * TAU;
      this.fx[o + 8] = rng() * TAU; // glow pulse phase
    }
    for (let i = 0; i < WISPS; i++) {
      this.wispY[i] = 0.12 + rng() * 0.22;
      this.wispX[i] = rng();
    }
    this.hills = [makeHill(rng), makeHill(rng)];
  }

  protected layout(): void {
    const { w, h, unit, dpr } = this;
    this.stars = Math.round(clamp((w * h) / 14000, 40, NIGHT_STARS));
    this.flies = Math.round(clamp(w / 220, 5, FIREFLIES));
    const landscape = w >= h;
    this.moonR = clamp(unit * 0.1, 36, 150);
    this.moonX = w * (landscape ? 0.8 : 0.72);
    this.moonY = h * (landscape ? 0.22 : 0.15);
    // Hide stars behind the moon's glow or the far hills
    const keepOut = this.moonR * 2.2;
    for (let i = 0; i < NIGHT_STARS; i++) {
      const x = this.sx[i] * w;
      const y = this.sy[i] * h;
      const nearMoon = Math.hypot(x - this.moonX, y - this.moonY) < keepOut;
      const belowHill = y > hillY(this.hills[0], x, w, h * 0.76, h * 0.04) - 10;
      this.hidden[i] = nearMoon || belowHill ? 1 : 0;
    }
    const size = clamp(this.k, 0.8, 1.6);
    this.starSize = 8 * size;
    this.bigSize = 8 * 1.8 * size;
    this.smallStar = release(this.smallStar);
    this.smallStar = starSprite(1 * size, rgb(255, 248, 225), dpr, false);
    this.bigStar = release(this.bigStar);
    this.bigStar = starSprite(1.8 * size, rgb(255, 245, 210), dpr, true);
    this.firefly = release(this.firefly);
    this.firefly = glowSprite(16, rgb(215, 255, 130), Math.min(dpr, 2), 2.2);
    this.wisp = release(this.wisp);
    const ww = clamp(unit * 0.5, 160, 600);
    this.wisp = sprite(ww, ww * 0.18, 0.5, (c, sw, sh) => {
      c.scale(sw / sh, 1);
      glow(c, sh / 2, sh / 2, sh / 2, rgb(200, 210, 255), 0.5);
    });
  }

  protected paintBase(c: Ctx, w: number, h: number): void {
    const { sky0, sky1, moonX, moonY, moonR } = this;
    verticalGradient(c, w, h, sky0, sky1);
    // Faint fixed dust stars
    const dust = mulberry32(hashString(`nightdust:${this.world.id}`));
    c.fillStyle = css(WHITE);
    const count = Math.min(400, Math.round((w * h) / 4000));
    for (let i = 0; i < count; i++) {
      const x = dust() * w;
      const y = dust() * h * 0.7;
      const a = 0.1 + dust() * 0.25;
      if (Math.hypot(x - moonX, y - moonY) < moonR * 2) continue;
      c.globalAlpha = a;
      c.beginPath();
      c.arc(x, y, 0.5 + dust() * 0.5, 0, TAU);
      c.fill();
    }
    c.globalAlpha = 1;
    // Moon with a soft glow and a subtle sleeping face
    glow(c, moonX, moonY, moonR * 3.4, rgb(255, 240, 200), 0.26);
    const g = c.createRadialGradient(moonX - moonR * 0.3, moonY - moonR * 0.3, moonR * 0.1, moonX, moonY, moonR);
    g.addColorStop(0, css(rgb(255, 250, 225)));
    g.addColorStop(1, css(rgb(238, 224, 170)));
    c.fillStyle = g;
    c.beginPath();
    c.arc(moonX, moonY, moonR, 0, TAU);
    c.fill();
    c.fillStyle = css(rgb(200, 185, 130), 0.18);
    const craters = [[0.35, -0.4, 0.14], [-0.45, 0.35, 0.1], [0.5, 0.42, 0.08]];
    for (const [cx, cy, cr] of craters) {
      c.beginPath();
      c.arc(moonX + cx * moonR, moonY + cy * moonR, cr * moonR, 0, TAU);
      c.fill();
    }
    const ink = css(rgb(170, 150, 95), 0.55);
    c.strokeStyle = ink;
    c.lineCap = 'round';
    c.lineWidth = Math.max(1.5, moonR * 0.05);
    for (let s = -1; s <= 1; s += 2) {
      c.beginPath();
      c.arc(moonX + s * moonR * 0.32, moonY - moonR * 0.08, moonR * 0.13, Math.PI * 0.15, Math.PI * 0.85); // sleeping ∪ eyes
      c.stroke();
    }
    c.beginPath();
    c.arc(moonX, moonY + moonR * 0.2, moonR * 0.12, Math.PI * 0.25, Math.PI * 0.75);
    c.stroke();
    c.fillStyle = css(rgb(255, 160, 150), 0.18);
    for (let s = -1; s <= 1; s += 2) {
      c.beginPath();
      c.ellipse(moonX + s * moonR * 0.55, moonY + moonR * 0.18, moonR * 0.14, moonR * 0.08, 0, 0, TAU);
      c.fill();
    }
    // Hills, with a faint moonlit rim on the far one
    const farColor = mix(sky1, rgb(8, 12, 35), 0.4);
    const nearColor = mix(sky1, rgb(5, 8, 25), 0.65);
    const farBase = h * 0.76;
    const farAmp = h * 0.04;
    fillHill(c, this.hills[0], w, h, farBase, farAmp, farColor, farColor);
    c.strokeStyle = css(rgb(255, 240, 200), 0.07);
    c.lineWidth = 2;
    c.stroke();
    // Little round trees on the far hill
    c.fillStyle = css(mix(farColor, rgb(5, 8, 25), 0.3));
    const treeRng = mulberry32(hashString(`trees:${this.world.id}`));
    for (let i = 0; i < 5; i++) {
      const x = w * (0.08 + i * 0.2 + treeRng() * 0.08);
      const y = hillY(this.hills[0], x, w, farBase, farAmp) + 3;
      const s = clamp(this.unit * 0.02, 7, 28) * (0.8 + treeRng() * 0.4);
      c.fillRect(x - s * 0.1, y - s * 1.4, s * 0.2, s * 1.4);
      c.beginPath();
      c.arc(x, y - s * 1.6, s, 0, TAU);
      c.fill();
    }
    fillHill(c, this.hills[1], w, h, h * 0.87, h * 0.03, nearColor, nearColor);
  }

  protected paint(ctx: Ctx): void {
    const { w, h, t, k } = this;
    for (let i = 0; i < this.stars; i++) {
      if (this.hidden[i]) continue;
      const big = this.big[i] === 1;
      const s = big ? this.bigSize : this.starSize;
      const twinkle = 0.65 + 0.35 * Math.sin(t * this.freq[i] + this.phase[i]);
      this.blit(ctx, big ? this.bigStar : this.smallStar, this.sx[i] * w, this.sy[i] * h, s, s, twinkle * (big ? 0.9 : 0.7));
    }
    const wisp = this.wisp;
    if (wisp) {
      for (let i = 0; i < WISPS; i++) {
        const span = w + wisp.w * 2;
        const x = wrap(this.wispX[i] * span + t * 4 * k, -wisp.w, span);
        this.blit(ctx, wisp, x, this.wispY[i] * h, wisp.w, wisp.h, 0.16);
      }
    }
    const fireflySize = 32 * clamp(k, 0.7, 1.5);
    for (let i = 0; i < this.flies; i++) {
      const o = i * 9;
      const x = this.fx[o] * w + Math.sin(t * this.fx[o + 4] + this.fx[o + 6]) * this.fx[o + 2] * k;
      const y = this.fx[o + 1] * h + Math.sin(t * this.fx[o + 5] + this.fx[o + 7]) * this.fx[o + 3] * k;
      const pulse = 0.3 + 0.6 * (0.5 + 0.5 * Math.sin(t * 0.8 + this.fx[o + 8]));
      this.blit(ctx, this.firefly, x, y, fireflySize, fireflySize, pulse);
    }
  }
}

// ---------------------------------------------------------------------------

type BackdropCtor = new (world: World, reduceMotion: boolean) => BaseBackdrop;

const BACKDROPS: Record<BackgroundKind, BackdropCtor> = {
  starfield: StarfieldBackdrop,
  underwater: UnderwaterBackdrop,
  meadow: MeadowBackdrop,
  party: PartyBackdrop,
  bubbles: BubblesBackdrop,
  jungle: JungleBackdrop,
  night: NightBackdrop,
};
