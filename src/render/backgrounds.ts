/**
 * Flat, matte, quiet backdrops — one per world (v2, DESIGN.md §2 "Backdrops").
 *
 * Each backdrop pre-renders its static illustration (sky, hills, planets…) to
 * an offscreen canvas on resize, using a seeded PRNG so a resize never
 * reshuffles the scene, and animates only a handful of cheap elements (drifting
 * clouds, rising bubbles, falling snow, breathing stars). No gradients on
 * objects, no glows, no strobing. Scenery hugs the edges so the centre stays
 * calm for the flashcards. draw() honours the caller's globalAlpha (cross-fades).
 */
import type { BackgroundKind, World } from '../types';
import { mix, toRgba } from './color';

export interface Backdrop {
  resize(width: number, height: number, dpr: number): void;
  update(dt: number, now: number, calm: number): void;
  /** Paints the full viewport (CSS px coordinates), multiplied by ctx.globalAlpha. */
  draw(ctx: CanvasRenderingContext2D): void;
}

const TAU = Math.PI * 2;

/** Small deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Soft vertical base: the only gradient allowed (very gentle, sky colours only). */
function paintSky(ctx: CanvasRenderingContext2D, w: number, h: number, sky: [string, string]): void {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, sky[0]);
  g.addColorStop(1, sky[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** A rolling hill band across the bottom: baseline y (fraction of h), amplitude, waves. */
function paintHill(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  base: number, amp: number, waves: number, phase: number, color: string,
): void {
  ctx.beginPath();
  ctx.moveTo(0, h);
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * w;
    const y = base * h - Math.sin((i / steps) * TAU * waves + phase) * amp * h;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = color;
  ctx.fill();
}

/** Flat puffy cloud made of overlapping discs on a flat base. */
function cloud(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x - s * 0.55, y, s * 0.42, 0, TAU);
  ctx.arc(x - s * 0.1, y - s * 0.22, s * 0.55, 0, TAU);
  ctx.arc(x + s * 0.45, y - s * 0.05, s * 0.45, 0, TAU);
  ctx.fill();
  ctx.fillRect(x - s * 0.55, y - s * 0.05, s, s * 0.47);
}

/** A moving element: position, velocity, size, phase. */
interface Mover {
  x: number;
  y: number;
  vx: number;
  vy: number;
  s: number;
  p: number;
}

/**
 * Shared machinery: static layer cache + movers. Subclasses paint the static
 * layer, create their movers, and draw them.
 */
abstract class FlatBackdrop implements Backdrop {
  protected w = 1;
  protected h = 1;
  protected dpr = 1;
  protected t = 0;
  protected movers: Mover[] = [];
  private layer: HTMLCanvasElement | null = null;

  constructor(protected readonly world: World, protected readonly reduceMotion: boolean) {}

  resize(width: number, height: number, dpr: number): void {
    this.w = Math.max(1, width);
    this.h = Math.max(1, height);
    this.dpr = Math.max(1, dpr);
    const rng = prng(seedOf(this.world.id));
    this.layer = makeCanvas(this.w * this.dpr, this.h * this.dpr);
    const lctx = this.layer?.getContext('2d') ?? null;
    if (lctx) {
      lctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.paintStatic(lctx, this.w, this.h, rng);
    }
    this.movers = this.createMovers(this.w, this.h, prng(seedOf(this.world.id) ^ 0x9e3779b9));
  }

  update(dt: number, _now: number, calm: number): void {
    if (this.reduceMotion) return;
    const k = dt * (1 - 0.7 * Math.min(1, Math.max(0, calm)));
    this.t += k;
    for (const m of this.movers) this.move(m, k);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const ga = ctx.globalAlpha;
    if (this.layer) ctx.drawImage(this.layer, 0, 0, this.w, this.h);
    else paintSky(ctx, this.w, this.h, this.world.sky);
    if (this.movers.length) {
      this.drawMovers(ctx, ga);
      ctx.globalAlpha = ga;
    }
  }

  protected abstract paintStatic(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number): void;

  protected createMovers(_w: number, _h: number, _rng: () => number): Mover[] {
    return [];
  }

  /** Default motion: drift by velocity, wrap around the edges. */
  protected move(m: Mover, dt: number): void {
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    const pad = m.s * 2;
    if (m.x > this.w + pad) m.x = -pad;
    if (m.x < -pad) m.x = this.w + pad;
    if (m.y > this.h + pad) m.y = -pad;
    if (m.y < -pad) m.y = this.h + pad;
  }

  protected drawMovers(_ctx: CanvasRenderingContext2D, _ga: number): void {}
}

// ---------------------------------------------------------------------------
// Paper — warm off-white with soft pastel geometry tucked into the corners
// ---------------------------------------------------------------------------

class PaperBackdrop extends FlatBackdrop {
  protected paintStatic(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number): void {
    paintSky(ctx, w, h, this.world.sky);
    const m = Math.min(w, h);
    const tint = (name: string, a: number): string => {
      const c = this.world.palette.find((p) => p.name === name);
      return toRgba(c ? c.container : '#E9E4DA', a);
    };
    // Large quiet shapes at the edges, like a paper collage.
    disc(ctx, w * 0.95, h * 0.08, m * 0.26, tint('blue', 0.9));
    disc(ctx, w * 0.04, h * 0.98, m * 0.2, tint('yellow', 0.95));
    // Arch, bottom-right.
    ctx.beginPath();
    ctx.arc(w * 0.86, h * 1.02, m * 0.2, Math.PI, 0);
    ctx.arc(w * 0.86, h * 1.02, m * 0.11, 0, Math.PI, true);
    ctx.closePath();
    ctx.fillStyle = tint('green', 0.95);
    ctx.fill();
    // Rounded square, top-left, slightly turned.
    ctx.save();
    ctx.translate(w * 0.06, h * 0.12);
    ctx.rotate(-0.18);
    const s = m * 0.13;
    ctx.beginPath();
    ctx.roundRect(-s, -s, s * 2, s * 2, s * 0.35);
    ctx.fillStyle = tint('pink', 0.9);
    ctx.fill();
    ctx.restore();
    // A few small dots for rhythm.
    for (let i = 0; i < 6; i++) {
      const edge = i % 2 === 0;
      const x = edge ? rng() * w * 0.18 : w * (0.82 + rng() * 0.16);
      const y = h * (0.25 + rng() * 0.5);
      disc(ctx, x, y, m * (0.008 + rng() * 0.01), tint(['orange', 'purple', 'blue'][i % 3], 1));
    }
    // Very subtle paper grain.
    ctx.fillStyle = 'rgba(80,60,30,0.035)';
    const grains = Math.round((w * h) / 900);
    for (let i = 0; i < grains; i++) ctx.fillRect(rng() * w, rng() * h, 1, 1);
  }
}

// ---------------------------------------------------------------------------
// Meadow (garden) — pale sky, matte sun, drifting clouds, rolling hills
// ---------------------------------------------------------------------------

class MeadowBackdrop extends FlatBackdrop {
  protected paintStatic(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number): void {
    paintSky(ctx, w, h, this.world.sky);
    const m = Math.min(w, h);
    disc(ctx, w * 0.88, h * 0.14, m * 0.075, '#F4D58A');
    paintHill(ctx, w, h, 0.8, 0.03, 1.2, 0.6, '#D4E7C8');
    paintHill(ctx, w, h, 0.86, 0.035, 1.6, 2.1, '#BCDBAE');
    paintHill(ctx, w, h, 0.93, 0.025, 2.1, 4.0, '#A3CD95');
    // Tiny flat flowers on the nearest hill.
    const petals = ['#F6C9C2', '#F8E3A8', '#D9CFF3', '#FBD9E7'];
    for (let i = 0; i < 26; i++) {
      const x = rng() * w;
      const y = h * (0.94 + rng() * 0.05);
      disc(ctx, x, y, m * 0.006, petals[i % petals.length]);
    }
  }

  protected override createMovers(w: number, h: number, rng: () => number): Mover[] {
    const m = Math.min(w, h);
    return [0, 1].map((i) => ({ x: rng() * w, y: h * (0.12 + i * 0.12), vx: 4 + rng() * 3, vy: 0, s: m * (0.07 + rng() * 0.03), p: 0 }));
  }

  protected override drawMovers(ctx: CanvasRenderingContext2D, ga: number): void {
    ctx.globalAlpha = ga * 0.9;
    for (const c of this.movers) cloud(ctx, c.x, c.y, c.s, '#FFFFFF');
  }
}

// ---------------------------------------------------------------------------
// Ocean — layered flat waves, slow bubbles, a sandy floor
// ---------------------------------------------------------------------------

const WAVES = [
  { base: 0.74, amp: 0.012, waves: 2.2, speed: 0.12, color: '#B9D7E6' },
  { base: 0.82, amp: 0.014, waves: 1.7, speed: -0.09, color: '#A2C8DC' },
  { base: 0.89, amp: 0.012, waves: 2.6, speed: 0.07, color: '#8DBAD2' },
];

class OceanBackdrop extends FlatBackdrop {
  protected paintStatic(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number): void {
    paintSky(ctx, w, h, this.world.sky);
    // Sandy floor with simple shells and seaweed silhouettes.
    ctx.fillStyle = '#EADFC8';
    ctx.fillRect(0, h * 0.955, w, h * 0.05);
    const m = Math.min(w, h);
    ctx.strokeStyle = '#8FBFA4';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(3, m * 0.008);
    for (let i = 0; i < 7; i++) {
      const x = i < 4 ? rng() * w * 0.2 : w * (0.8 + rng() * 0.2);
      const top = h * (0.84 + rng() * 0.06);
      ctx.beginPath();
      ctx.moveTo(x, h * 0.96);
      ctx.quadraticCurveTo(x + m * 0.025, (top + h * 0.96) / 2, x, top);
      ctx.stroke();
    }
    for (let i = 0; i < 4; i++) disc(ctx, w * (0.3 + rng() * 0.4), h * 0.972, m * 0.008, '#F2C9B8');
  }

  protected override createMovers(w: number, h: number, rng: () => number): Mover[] {
    const m = Math.min(w, h);
    const bubbles: Mover[] = [];
    for (let i = 0; i < 8; i++) {
      const edge = i % 2 === 0 ? rng() * 0.18 : 0.82 + rng() * 0.18;
      bubbles.push({ x: edge * w, y: rng() * h, vx: 0, vy: -(6 + rng() * 6), s: m * (0.006 + rng() * 0.008), p: rng() * TAU });
    }
    return bubbles;
  }

  protected override drawMovers(ctx: CanvasRenderingContext2D, ga: number): void {
    // Waves drift sideways (redrawn each frame: three cheap paths).
    for (const wv of WAVES) {
      ctx.globalAlpha = ga;
      paintHill(ctx, this.w, this.h, wv.base, wv.amp, wv.waves, this.t * wv.speed * TAU, wv.color);
    }
    ctx.globalAlpha = ga;
    ctx.fillStyle = '#EADFC8';
    ctx.fillRect(0, this.h * 0.955, this.w, this.h * 0.05);
    ctx.globalAlpha = ga * 0.7;
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.5;
    for (const b of this.movers) {
      ctx.beginPath();
      ctx.arc(b.x + Math.sin(this.t + b.p) * 3, b.y, b.s, 0, TAU);
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// Space — deep matte navy, still stars (a few breathing slowly), flat planet & moon
// ---------------------------------------------------------------------------

function paintStars(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number, count: number): void {
  ctx.fillStyle = 'rgba(238,241,247,0.55)';
  for (let i = 0; i < count; i++) {
    const r = rng() < 0.85 ? 0.8 : 1.4;
    ctx.beginPath();
    ctx.arc(rng() * w, rng() * h, r, 0, TAU);
    ctx.fill();
  }
}

function breathingStars(w: number, h: number, rng: () => number, n: number): Mover[] {
  const out: Mover[] = [];
  for (let i = 0; i < n; i++) out.push({ x: rng() * w, y: rng() * h * 0.7, vx: 0, vy: 0, s: 1.6 + rng(), p: rng() * TAU });
  return out;
}

class SpaceBackdrop extends FlatBackdrop {
  protected paintStatic(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number): void {
    paintSky(ctx, w, h, this.world.sky);
    paintStars(ctx, w, h, rng, Math.round((w * h) / 9000));
    const m = Math.min(w, h);
    // Ringed planet, bottom-left.
    const px = w * 0.1;
    const py = h * 0.86;
    const pr = m * 0.1;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-0.35);
    ctx.lineWidth = m * 0.012;
    ctx.strokeStyle = '#8E86B8';
    ctx.beginPath();
    ctx.ellipse(0, 0, pr * 1.7, pr * 0.45, 0, Math.PI, TAU);
    ctx.stroke();
    disc(ctx, 0, 0, pr, '#6E6A9E');
    ctx.beginPath();
    ctx.ellipse(0, 0, pr * 1.7, pr * 0.45, 0, 0, Math.PI);
    ctx.stroke();
    ctx.restore();
    // Flat moon with craters, top-right.
    const mx = w * 0.9;
    const my = h * 0.14;
    const mr = m * 0.055;
    disc(ctx, mx, my, mr, '#C9CCD8');
    disc(ctx, mx - mr * 0.35, my - mr * 0.2, mr * 0.22, '#B5B9C8');
    disc(ctx, mx + mr * 0.3, my + mr * 0.3, mr * 0.16, '#B5B9C8');
    disc(ctx, mx + mr * 0.2, my - mr * 0.45, mr * 0.1, '#B5B9C8');
  }

  protected override createMovers(w: number, h: number, rng: () => number): Mover[] {
    return breathingStars(w, h, rng, 6);
  }

  protected override drawMovers(ctx: CanvasRenderingContext2D, ga: number): void {
    ctx.fillStyle = '#EEF1F7';
    for (const s of this.movers) {
      // ≤ 0.2 Hz, gentle: never a twinkle strobe.
      ctx.globalAlpha = ga * (0.45 + 0.35 * Math.sin(this.t * 1.1 + s.p));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.s, 0, TAU);
      ctx.fill();
    }
  }
}

// ---------------------------------------------------------------------------
// Jungle — muted greens, distant volcano, layered leaf silhouettes at the edges
// ---------------------------------------------------------------------------

function leaf(ctx: CanvasRenderingContext2D, x: number, y: number, len: number, angle: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.ellipse(len / 2, 0, len / 2, len * 0.18, 0, 0, TAU);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

class JungleBackdrop extends FlatBackdrop {
  protected paintStatic(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number): void {
    paintSky(ctx, w, h, this.world.sky);
    const m = Math.min(w, h);
    // Distant volcano with a still smoke cloud.
    const vx = w * 0.78;
    const vy = h * 0.82;
    ctx.beginPath();
    ctx.moveTo(vx - m * 0.28, vy);
    ctx.lineTo(vx - m * 0.06, vy - m * 0.26);
    ctx.quadraticCurveTo(vx, vy - m * 0.29, vx + m * 0.06, vy - m * 0.26);
    ctx.lineTo(vx + m * 0.28, vy);
    ctx.closePath();
    ctx.fillStyle = '#C9C2B2';
    ctx.fill();
    cloud(ctx, vx + m * 0.03, vy - m * 0.34, m * 0.06, 'rgba(255,255,255,0.75)');
    paintHill(ctx, w, h, 0.84, 0.02, 1.3, 1.2, '#CADBB8');
    paintHill(ctx, w, h, 0.92, 0.025, 1.8, 3.3, '#AFCB9A');
    // Leaf fronds from the sides and bottom corners.
    const tones = ['#8FB57E', '#7BA66C', '#9DC08B'];
    for (let i = 0; i < 26; i++) {
      const left = i % 2 === 0;
      const x = left ? -m * 0.02 : w + m * 0.02;
      const y = h * (0.45 + rng() * 0.55);
      const angle = (left ? -0.6 : Math.PI + 0.6) + (rng() - 0.5) * 0.9;
      leaf(ctx, x, y, m * (0.12 + rng() * 0.1), angle, tones[i % tones.length]);
    }
  }
}

// ---------------------------------------------------------------------------
// Snow — pale sky, rounded snow hills, flat pines, slow flakes
// ---------------------------------------------------------------------------

function pine(ctx: CanvasRenderingContext2D, x: number, base: number, s: number, color: string): void {
  ctx.fillStyle = color;
  for (let i = 0; i < 3; i++) {
    const top = base - s * (0.55 + i * 0.4);
    const half = s * (0.42 - i * 0.1);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x + half, top + s * 0.55);
    ctx.lineTo(x - half, top + s * 0.55);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillRect(x - s * 0.05, base - s * 0.1, s * 0.1, s * 0.12);
}

class SnowBackdrop extends FlatBackdrop {
  protected paintStatic(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number): void {
    paintSky(ctx, w, h, this.world.sky);
    const m = Math.min(w, h);
    paintHill(ctx, w, h, 0.84, 0.03, 1.1, 0.4, '#F2F6FA');
    for (let i = 0; i < 5; i++) {
      const x = i < 3 ? w * (0.03 + i * 0.06 + rng() * 0.02) : w * (0.86 + (i - 3) * 0.07);
      pine(ctx, x, h * (0.86 + rng() * 0.02), m * (0.09 + rng() * 0.04), '#9DB5A9');
    }
    paintHill(ctx, w, h, 0.92, 0.025, 1.7, 2.5, '#FFFFFF');
  }

  protected override createMovers(w: number, h: number, rng: () => number): Mover[] {
    const flakes: Mover[] = [];
    for (let i = 0; i < 28; i++) flakes.push({ x: rng() * w, y: rng() * h, vx: 0, vy: 10 + rng() * 10, s: 1.5 + rng() * 2.2, p: rng() * TAU });
    return flakes;
  }

  protected override drawMovers(ctx: CanvasRenderingContext2D, ga: number): void {
    ctx.globalAlpha = ga * 0.8;
    ctx.fillStyle = '#B8C8DA';
    for (const f of this.movers) {
      ctx.beginPath();
      ctx.arc(f.x + Math.sin(this.t * 0.6 + f.p) * 6, f.y, f.s, 0, TAU);
      ctx.fill();
    }
  }
}

// ---------------------------------------------------------------------------
// Night — the calmest: deep blue, flat crescent moon, still stars, dark hills
// ---------------------------------------------------------------------------

class NightBackdrop extends FlatBackdrop {
  protected paintStatic(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number): void {
    paintSky(ctx, w, h, this.world.sky);
    paintStars(ctx, w, h * 0.75, rng, Math.round((w * h) / 14000));
    const m = Math.min(w, h);
    // Crescent: a disc with a sky-coloured disc over it.
    const mx = w * 0.86;
    const my = h * 0.16;
    const r = m * 0.07;
    disc(ctx, mx, my, r, '#F1E3B5');
    disc(ctx, mx + r * 0.45, my - r * 0.2, r * 0.86, mix(this.world.sky[0], this.world.sky[1], 0.15));
    paintHill(ctx, w, h, 0.86, 0.03, 1.2, 0.9, '#1E2744');
    paintHill(ctx, w, h, 0.93, 0.025, 1.9, 2.8, '#19213A');
  }

  protected override createMovers(w: number, h: number, rng: () => number): Mover[] {
    return breathingStars(w, h, rng, 4);
  }

  protected override drawMovers(ctx: CanvasRenderingContext2D, ga: number): void {
    ctx.fillStyle = '#F1E3B5';
    for (const s of this.movers) {
      ctx.globalAlpha = ga * (0.35 + 0.3 * Math.sin(this.t * 0.8 + s.p));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.s, 0, TAU);
      ctx.fill();
    }
  }
}

const BACKDROPS: Record<BackgroundKind, new (world: World, reduceMotion: boolean) => FlatBackdrop> = {
  paper: PaperBackdrop,
  meadow: MeadowBackdrop,
  ocean: OceanBackdrop,
  space: SpaceBackdrop,
  jungle: JungleBackdrop,
  snow: SnowBackdrop,
  night: NightBackdrop,
};

/** Creates the backdrop for a world. Call resize() before the first draw. */
export function createBackdrop(world: World, options: { reduceMotion: boolean }): Backdrop {
  const Ctor = BACKDROPS[world.background] ?? PaperBackdrop;
  return new Ctor(world, !!options.reduceMotion);
}
