/**
 * Matte effects (DESIGN.md §2 Motion): small flat particles, soft ripples,
 * finger-painting strokes and the band-by-band rainbow. No additive blending,
 * no glows, no flashes. Everything is pooled or ring-buffered so a toddler
 * mashing keys for ten minutes never grows memory.
 */
import type { NamedColor, ParticleStyle } from '../types';
import { TIMING } from '../types';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Particles
// ---------------------------------------------------------------------------

export const PARTICLE_CAPACITY = 600;

const STYLE_ID: Record<ParticleStyle, number> = {
  confetti: 0, dots: 1, petals: 2, bubbles: 3, leaves: 4, snow: 5, stars: 6,
};

/** Fixed-capacity struct-of-arrays pool; spawning when full overwrites the oldest. */
export class MatteParticles {
  readonly capacity: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly size: Float32Array;
  readonly rot: Float32Array;
  readonly spin: Float32Array;
  readonly style: Uint8Array;
  /** Index into `colors`. */
  readonly color: Uint8Array;
  readonly alive: Uint8Array;
  colors: string[] = ['#4A86D8'];
  private next = 0;
  private liveCount = 0;

  constructor(capacity = PARTICLE_CAPACITY) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.rot = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    this.style = new Uint8Array(capacity);
    this.color = new Uint8Array(capacity);
    this.alive = new Uint8Array(capacity);
  }

  get count(): number {
    return this.liveCount;
  }

  spawn(style: ParticleStyle, x: number, y: number, vx: number, vy: number, life: number, size: number, colorIndex: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    if (!this.alive[i]) this.liveCount++;
    this.alive[i] = 1;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.age[i] = 0;
    this.life[i] = life;
    this.size[i] = size;
    this.rot[i] = Math.random() * TAU;
    this.spin[i] = (Math.random() - 0.5) * 4;
    this.style[i] = STYLE_ID[style] ?? 0;
    this.color[i] = Math.max(0, colorIndex) % Math.max(1, this.colors.length);
  }

  update(dt: number, gravity: number): void {
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.alive[i] = 0;
        this.liveCount--;
        continue;
      }
      const drag = this.style[i] === 0 || this.style[i] === 2 || this.style[i] === 4 ? 1.6 : 0.8;
      this.vx[i] -= this.vx[i] * drag * dt;
      this.vy[i] += gravity * dt - this.vy[i] * drag * 0.5 * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.rot[i] += this.spin[i] * dt;
    }
  }

  clear(): void {
    this.alive.fill(0);
    this.liveCount = 0;
  }

  draw(ctx: CanvasRenderingContext2D, dark: boolean): void {
    if (this.liveCount === 0) return;
    const ga = ctx.globalAlpha;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      const t = this.age[i] / this.life[i];
      ctx.globalAlpha = ga * (t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25);
      const s = this.size[i];
      const style = this.style[i];
      const color = style === 5 ? (dark ? '#E6ECF5' : '#B8C8DA') : this.colors[this.color[i]];
      const c = Math.cos(this.rot[i]);
      const sn = Math.sin(this.rot[i]);
      ctx.save();
      ctx.translate(this.x[i], this.y[i]);
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      switch (style) {
        case 0: // confetti: a flat paper strip fluttering (scaleX = cos)
          ctx.transform(c, sn, -sn, c, 0, 0);
          ctx.scale(Math.cos(this.rot[i] * 1.7), 1);
          ctx.fillRect(-s, -s * 0.45, s * 2, s * 0.9);
          break;
        case 2: // petal
        case 4: // leaf
          ctx.transform(c, sn, -sn, c, 0, 0);
          ctx.beginPath();
          ctx.ellipse(0, 0, s, s * 0.45, 0, 0, TAU);
          ctx.fill();
          break;
        case 3: // bubble outline
          ctx.lineWidth = Math.max(1, s * 0.18);
          ctx.beginPath();
          ctx.arc(0, 0, s, 0, TAU);
          ctx.stroke();
          break;
        case 6: // small flat star
          ctx.transform(c, sn, -sn, c, 0, 0);
          starPath(ctx, s);
          ctx.fill();
          break;
        default: // dots, snow
          ctx.beginPath();
          ctx.arc(0, 0, s * 0.6, 0, TAU);
          ctx.fill();
      }
      ctx.restore();
    }
    ctx.globalAlpha = ga;
  }
}

function starPath(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 === 0 ? r : r * 0.45;
    if (k === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Ripples (taps)
// ---------------------------------------------------------------------------

const RIPPLE_MAX = 10;
const RIPPLE_LIFE = 0.5;

export class Ripples {
  private readonly x = new Float32Array(RIPPLE_MAX);
  private readonly y = new Float32Array(RIPPLE_MAX);
  private readonly age = new Float32Array(RIPPLE_MAX).fill(RIPPLE_LIFE);
  private readonly color: string[] = new Array<string>(RIPPLE_MAX).fill('#000');
  private next = 0;

  add(x: number, y: number, color: NamedColor): void {
    const i = this.next;
    this.next = (this.next + 1) % RIPPLE_MAX;
    this.x[i] = x;
    this.y[i] = y;
    this.age[i] = 0;
    this.color[i] = color.hex;
  }

  update(dt: number): void {
    for (let i = 0; i < RIPPLE_MAX; i++) if (this.age[i] < RIPPLE_LIFE) this.age[i] += dt;
  }

  draw(ctx: CanvasRenderingContext2D, scale: number): void {
    const ga = ctx.globalAlpha;
    ctx.lineWidth = 2;
    for (let i = 0; i < RIPPLE_MAX; i++) {
      const t = this.age[i] / RIPPLE_LIFE;
      if (t >= 1) continue;
      ctx.globalAlpha = ga * 0.4 * (1 - t);
      ctx.strokeStyle = this.color[i];
      ctx.beginPath();
      ctx.arc(this.x[i], this.y[i], (12 + 36 * (1 - (1 - t) * (1 - t))) * scale, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = ga;
  }
}

// ---------------------------------------------------------------------------
// Finger painting
// ---------------------------------------------------------------------------

const STROKE_MAX = 10;
const STROKE_POINTS = 120;
const STROKE_FADE = 3;

interface Stroke {
  pointerId: number;
  xs: Float32Array;
  ys: Float32Array;
  /** Ring buffer: index of the oldest point and number of points. */
  head: number;
  len: number;
  color: string;
  /** Seconds since the stroke ended, or -1 while drawing. */
  ended: number;
  active: boolean;
}

export class Paint {
  private readonly strokes: Stroke[] = [];

  constructor() {
    for (let i = 0; i < STROKE_MAX; i++) {
      this.strokes.push({
        pointerId: -1, xs: new Float32Array(STROKE_POINTS), ys: new Float32Array(STROKE_POINTS),
        head: 0, len: 0, color: '#000', ended: 0, active: false,
      });
    }
  }

  add(x: number, y: number, color: NamedColor, pointerId: number): void {
    let s = this.strokes.find((k) => k.active && k.ended < 0 && k.pointerId === pointerId);
    if (!s) {
      // Reuse a free slot, else the stroke that ended longest ago, else the oldest.
      s = this.strokes.find((k) => !k.active) ?? this.strokes.reduce((a, b) => (b.ended > a.ended ? b : a));
      s.pointerId = pointerId;
      s.head = 0;
      s.len = 0;
      s.color = color.hex;
      s.ended = -1;
      s.active = true;
    }
    const i = (s.head + s.len) % STROKE_POINTS;
    if (s.len === STROKE_POINTS) s.head = (s.head + 1) % STROKE_POINTS;
    else s.len++;
    s.xs[i] = x;
    s.ys[i] = y;
  }

  end(pointerId: number): void {
    for (const s of this.strokes) if (s.active && s.ended < 0 && s.pointerId === pointerId) s.ended = 0;
  }

  update(dt: number): void {
    for (const s of this.strokes) {
      if (!s.active || s.ended < 0) continue;
      s.ended += dt;
      if (s.ended >= STROKE_FADE) s.active = false;
    }
  }

  clear(): void {
    for (const s of this.strokes) s.active = false;
  }

  draw(ctx: CanvasRenderingContext2D, width: number): void {
    const ga = ctx.globalAlpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of this.strokes) {
      if (!s.active || s.len === 0) continue;
      ctx.globalAlpha = ga * 0.85 * (s.ended < 0 ? 1 : 1 - s.ended / STROKE_FADE);
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = width;
      ctx.beginPath();
      const x0 = s.xs[s.head];
      const y0 = s.ys[s.head];
      if (s.len === 1) {
        ctx.arc(x0, y0, width / 2, 0, TAU);
        ctx.fill();
        continue;
      }
      ctx.moveTo(x0, y0);
      for (let k = 1; k < s.len - 1; k++) {
        const a = (s.head + k) % STROKE_POINTS;
        const b = (s.head + k + 1) % STROKE_POINTS;
        ctx.quadraticCurveTo(s.xs[a], s.ys[a], (s.xs[a] + s.xs[b]) / 2, (s.ys[a] + s.ys[b]) / 2);
      }
      const last = (s.head + s.len - 1) % STROKE_POINTS;
      ctx.lineTo(s.xs[last], s.ys[last]);
      ctx.stroke();
    }
    ctx.globalAlpha = ga;
  }
}

// ---------------------------------------------------------------------------
// Rainbow — flat bands painted one per TIMING.rainbowBandMs, outermost first
// ---------------------------------------------------------------------------

const BAND_SWEEP = 0.4;
const RAINBOW_HOLD = 1.5;
const RAINBOW_FADE = 0.6;

export class Rainbow {
  private t = 0;
  private colors: string[] = [];
  private active = false;
  private reduce = false;

  start(colors: readonly NamedColor[], reduceMotion: boolean): void {
    this.colors = colors.slice(0, 8).map((c) => c.hex);
    this.t = 0;
    this.active = this.colors.length > 0;
    this.reduce = reduceMotion;
  }

  get painting(): boolean {
    return this.active;
  }

  /** Total duration in seconds for the current colours. */
  duration(): number {
    const step = TIMING.rainbowBandMs / 1000;
    return (this.colors.length - 1) * step + BAND_SWEEP + RAINBOW_HOLD + RAINBOW_FADE;
  }

  update(dt: number): void {
    if (!this.active) return;
    this.t += dt;
    if (this.t >= this.duration()) this.active = false;
  }

  draw(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    if (!this.active) return;
    const step = TIMING.rainbowBandMs / 1000;
    const R = Math.min(width * 0.44, height * 0.62);
    const band = R * 0.075;
    const cx = width / 2;
    const cy = height * 0.82;
    const end = this.duration();
    const fade = this.t > end - RAINBOW_FADE ? Math.max(0, (end - this.t) / RAINBOW_FADE) : 1;
    const ga = ctx.globalAlpha;
    ctx.lineCap = 'butt';
    ctx.lineWidth = band;
    for (let i = 0; i < this.colors.length; i++) {
      const local = this.t - i * step;
      if (local <= 0) continue;
      const p = Math.min(1, local / BAND_SWEEP);
      const eased = 1 - (1 - p) * (1 - p);
      ctx.globalAlpha = ga * 0.85 * fade * (this.reduce ? eased : 1);
      ctx.strokeStyle = this.colors[i];
      ctx.beginPath();
      const r = R - i * band;
      ctx.arc(cx, cy, r, Math.PI, this.reduce ? 2 * Math.PI : Math.PI + Math.PI * eased);
      ctx.stroke();
    }
    ctx.globalAlpha = ga;
  }
}
