/**
 * Special effects (rainbow, fireworks, sweep, comets), tap ripples and pointer
 * trails. Every effect is bounded: the scene keeps at most 8 effects, ripples
 * live in a 16-slot ring and trails in 10 pointer slots × 32-point rings.
 *
 * Photosensitivity: nothing here fills the screen with a bright colour or
 * flashes. Large translucent effects (rainbow, sweep) change slowly and the
 * scene allows only one of each at a time; additive glows stay small.
 */

import type { SpecialEffect } from '../types';
import type { SpriteFactory } from './sprites';
import type { ObjectLayer } from './entities';
import { SPR_GLOW, SPR_TAIL } from './sprites';
import { PS_BUBBLE, PS_EMBER, PS_SPARK, PS_STAR, type Emitter, type RenderEnv } from './particles';
import { TAU, clamp, clamp01, easeInOutSine, easeOutCubic, lerp } from './easing';

export interface EffectHost {
  readonly env: RenderEnv;
  readonly emitter: Emitter;
  readonly sprites: SpriteFactory;
  readonly objects: ObjectLayer;
}

export interface Effect {
  readonly kind: SpecialEffect;
  /** Drawn above particles (true) or behind trails and objects (false). */
  readonly front: boolean;
  /** Advances by simulation seconds; returns false once finished. */
  update(dt: number): boolean;
  draw(ctx: CanvasRenderingContext2D): void;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Emits `rate` particles per second across frames without allocation. */
class Accumulator {
  private acc = 0;
  take(rate: number, dt: number): number {
    this.acc += rate * dt;
    const n = Math.floor(this.acc);
    this.acc -= n;
    return n;
  }
}

// ---------------------------------------------------------------------------
// Rainbow
// ---------------------------------------------------------------------------

const RAINBOW = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#748ffc', '#da77f2'];

export class Rainbow implements Effect {
  readonly kind = 'rainbow';
  readonly front = false;
  private t = 0;
  private readonly drawIn: number;
  private readonly hold: number;
  private readonly fade: number;
  private readonly ids: number[];
  private readonly sparkles = new Accumulator();
  // Arc geometry, refreshed from the viewport each use (handles resizes).
  private cx = 0;
  private cy = 0;
  private R = 1;
  private bw = 1;

  constructor(private readonly host: EffectHost) {
    const reduce = host.env.reduceMotion;
    this.drawIn = reduce ? 0.7 : 0.9;
    this.hold = reduce ? 1.6 : 1.4;
    this.fade = reduce ? 1.0 : 0.9;
    this.ids = RAINBOW.map((hex) => host.sprites.colors.id(hex));
  }

  private layout(): void {
    const { width: w, height: h } = this.host.env;
    this.R = Math.min(w * 0.46, h * 0.78);
    this.bw = this.R * 0.075;
    this.cx = w / 2;
    this.cy = h * 0.94;
  }

  /** Emits one star sparkle on band `band` at angle `a`. */
  private sparkleAt(a: number, band: number, speed: number): void {
    const r = this.R - this.bw * (band + 0.5);
    this.host.emitter.one(PS_STAR, this.cx + Math.cos(a) * r, this.cy + Math.sin(a) * r, this.ids[band], speed);
  }

  private progress(): number {
    return this.host.env.reduceMotion ? 1 : easeInOutSine(this.t / this.drawIn);
  }

  /** Extra sparkles along the arc (used when Space is pressed again). */
  sparkle(): void {
    this.layout();
    const p = this.progress();
    const n = Math.max(2, Math.round(10 * this.host.env.emitScale));
    for (let i = 0; i < n; i++) this.sparkleAt(Math.PI + Math.PI * p * Math.random(), (Math.random() * 7) | 0, 0.4);
    // Keep it on screen a little longer.
    const end = this.drawIn + this.hold;
    if (this.t > this.drawIn && this.t < end) this.t = Math.max(this.drawIn, this.t - 0.6);
  }

  update(dt: number): boolean {
    this.t += dt;
    if (!this.host.env.reduceMotion && this.t < this.drawIn) {
      const n = this.sparkles.take(40 * this.host.env.emitScale, dt);
      if (n > 0) {
        this.layout();
        const a = Math.PI + Math.PI * this.progress();
        for (let i = 0; i < n; i++) this.sparkleAt(a, (Math.random() * 7) | 0, 0.35);
      }
    }
    return this.t < this.drawIn + this.hold + this.fade;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const reduce = this.host.env.reduceMotion;
    const t = this.t;
    const p = this.progress();
    if (p <= 0.002) return;
    let alpha = 1;
    if (reduce && t < this.drawIn) alpha = easeOutCubic(t / this.drawIn);
    else if (t > this.drawIn + this.hold) alpha = 1 - clamp01((t - this.drawIn - this.hold) / this.fade);
    if (alpha <= 0.002) return;
    this.layout();
    const { cx, cy, R, bw } = this;
    const a0 = Math.PI;
    const a1 = Math.PI + Math.PI * p;
    ctx.lineCap = 'round';
    // Soft halo behind the bands.
    ctx.globalAlpha = alpha * 0.2;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = bw * 9;
    ctx.beginPath();
    ctx.arc(cx, cy, R - bw * 3.5, a0, a1);
    ctx.stroke();
    ctx.globalAlpha = alpha * 0.86;
    ctx.lineWidth = bw * 1.06;
    for (let i = 0; i < 7; i++) {
      ctx.strokeStyle = RAINBOW[i];
      ctx.beginPath();
      ctx.arc(cx, cy, R - bw * (i + 0.5), a0, a1);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------
// Fireworks
// ---------------------------------------------------------------------------

interface Rocket {
  delay: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dur: number;
  color: number;
  color2: number;
  exploded: boolean;
  boomAt: number;
}

export class Fireworks implements Effect {
  readonly kind = 'fireworks';
  readonly front = true;
  private t = 0;
  private readonly rockets: Rocket[] = [];
  private readonly trail = new Accumulator();
  private readonly end: number;

  constructor(
    private readonly host: EffectHost,
    at?: { x: number; y: number },
  ) {
    const { width: w, height: h } = host.env;
    const reduce = host.env.reduceMotion;
    const n = 3 + ((Math.random() * 3) | 0);
    let delay = 0;
    for (let i = 0; i < n; i++) {
      let x1: number;
      let y1: number;
      if (at && i === 0) {
        x1 = at.x;
        y1 = at.y;
      } else if (at) {
        x1 = at.x + rand(-0.22, 0.22) * w;
        y1 = at.y + rand(-0.2, 0.15) * h;
      } else {
        x1 = rand(0.15, 0.85) * w;
        y1 = rand(0.12, 0.5) * h;
      }
      x1 = clamp(x1, w * 0.08, w * 0.92);
      y1 = clamp(y1, h * 0.08, h * 0.75);
      const color = host.env.randomPalette();
      this.rockets.push({
        delay,
        x0: x1 + rand(-0.08, 0.08) * w,
        y0: h + 24,
        x1,
        y1,
        dur: reduce ? 0 : rand(0.55, 0.8),
        color,
        color2: host.env.randomPalette(),
        exploded: false,
        boomAt: 0,
      });
      delay += reduce ? rand(0.3, 0.45) : rand(0.14, 0.3);
    }
    const last = this.rockets[this.rockets.length - 1];
    this.end = last.delay + last.dur + (reduce ? 1.7 : 0.5);
  }

  update(dt: number): boolean {
    this.t += dt;
    const reduce = this.host.env.reduceMotion;
    const trailN = reduce ? 0 : this.trail.take(50 * this.host.env.emitScale, dt);
    for (let i = 0; i < this.rockets.length; i++) {
      const r = this.rockets[i];
      const local = this.t - r.delay;
      if (local < 0 || r.exploded) continue;
      if (local < r.dur) {
        // Fizzy trail behind the rising rocket.
        const p = easeOutCubic(local / r.dur);
        const x = lerp(r.x0, r.x1, p);
        const y = lerp(r.y0, r.y1, p);
        for (let k = 0; k < trailN; k++) {
          const j = this.host.emitter.pool.spawn(x + rand(-3, 3), y + 6, rand(-25, 25), rand(40, 110), rand(0.25, 0.45), rand(3, 5), PS_SPARK, r.color);
          this.host.emitter.pool.drag[j] = 2;
        }
      } else {
        this.explode(r);
      }
    }
    return this.t < this.end;
  }

  private explode(r: Rocket): void {
    r.exploded = true;
    r.boomAt = this.t;
    const env = this.host.env;
    const em = this.host.emitter;
    if (env.reduceMotion) {
      em.spray(PS_STAR, r.x1, r.y1, r.color, 8, 0.5);
      return;
    }
    const n = Math.max(10, Math.round(46 * env.emitScale));
    const base = 250 * (0.7 + 0.3 * env.energy);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU + rand(-0.08, 0.08);
      const sp = base * rand(0.78, 1.05);
      const q = Math.random();
      const c = q < 0.68 ? r.color : q < 0.84 ? env.white : r.color2;
      const j = em.pool.spawn(r.x1, r.y1, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.9, 1.4), rand(5, 8), PS_EMBER, c);
      em.pool.drag[j] = 1.6;
      em.pool.ay[j] = 60;
    }
    em.spray(PS_STAR, r.x1, r.y1, this.host.sprites.colors.light(r.color), 6, 0.6);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const env = this.host.env;
    const sprites = this.host.sprites;
    if (env.dark) ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.rockets.length; i++) {
      const r = this.rockets[i];
      const local = this.t - r.delay;
      if (local < 0) continue;
      if (!r.exploded) {
        const p = easeOutCubic(local / r.dur);
        const x = lerp(r.x0, r.x1, p) + Math.sin(local * 18) * 2;
        const y = lerp(r.y0, r.y1, p);
        const s = 26;
        ctx.globalAlpha = 1;
        ctx.drawImage(sprites.particle(SPR_GLOW, r.color), x - s / 2, y - s / 2, s, s);
        continue;
      }
      const since = this.t - r.boomAt;
      if (env.reduceMotion) {
        // Gentle version: a soft ring that blooms and fades.
        const f = since / 1.6;
        if (f >= 1) continue;
        const e = easeOutCubic(f);
        ctx.globalAlpha = 0.6 * (1 - f);
        ctx.strokeStyle = sprites.colors.hex(r.color);
        ctx.lineWidth = lerp(10, 2, f);
        ctx.beginPath();
        ctx.arc(r.x1, r.y1, lerp(16, 120, e), 0, TAU);
        ctx.stroke();
        const g = lerp(40, 150, e);
        ctx.globalAlpha = 0.3 * (1 - f);
        ctx.drawImage(sprites.particle(SPR_GLOW, r.color), r.x1 - g / 2, r.y1 - g / 2, g, g);
      } else {
        // Small soft bloom at the burst point (never a screen flash).
        const f = since / 0.35;
        if (f >= 1) continue;
        const g = lerp(30, 120, easeOutCubic(f));
        ctx.globalAlpha = 0.55 * (1 - f);
        ctx.drawImage(sprites.particle(SPR_GLOW, r.color), r.x1 - g / 2, r.y1 - g / 2, g, g);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

const SWEEP_TRAVEL = 0.9;
const SWEEP_FADE = 0.4;

export class Sweep implements Effect {
  readonly kind = 'sweep';
  readonly front = false;
  private t = 0;
  private grad: CanvasGradient | null = null;
  private gradBand = 0;
  private gradDark = false;
  private readonly foam = new Accumulator();

  constructor(private readonly host: EffectHost) {}

  private frontX(): number {
    const w = this.host.env.width;
    return lerp(-0.12 * w, 1.12 * w, easeInOutSine(this.t / SWEEP_TRAVEL));
  }

  private wave(y: number): number {
    return Math.sin(y * 0.012 + this.t * 7) * 16 + Math.sin(y * 0.031 - this.t * 5) * 7;
  }

  update(dt: number): boolean {
    this.t += dt;
    const env = this.host.env;
    if (this.t <= SWEEP_TRAVEL + 0.05) {
      const fx = this.frontX();
      this.host.objects.sweep(fx);
      const n = this.foam.take(70 * env.emitScale, dt);
      const pool = this.host.emitter.pool;
      for (let k = 0; k < n; k++) {
        const y = Math.random() * env.height;
        const i = this.host.emitter.one(PS_BUBBLE, fx + this.wave(y), y, env.white, 0.6);
        pool.vx[i] = rand(90, 280);
        pool.vy[i] = rand(-70, 50);
        pool.size[i] *= 0.7;
      }
    }
    return this.t < SWEEP_TRAVEL + SWEEP_FADE;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const env = this.host.env;
    const { width: w, height: h, dpr } = env;
    const alpha = this.t > SWEEP_TRAVEL ? 1 - clamp01((this.t - SWEEP_TRAVEL) / SWEEP_FADE) : 1;
    if (alpha <= 0.002) return;
    const band = Math.max(120, w * 0.3);
    if (!this.grad || this.gradBand !== band || this.gradDark !== env.dark) {
      // Built once in local coordinates; the curtain is moved with setTransform.
      // A soft water tint: pale aqua on dark skies, a deeper aqua on light ones.
      const tint = env.dark ? '159, 216, 255' : '96, 190, 255';
      const g = ctx.createLinearGradient(-band, 0, 0, 0);
      g.addColorStop(0, `rgba(${tint}, 0)`);
      g.addColorStop(0.7, `rgba(${tint}, ${env.dark ? 0.16 : 0.2})`);
      g.addColorStop(1, `rgba(${tint}, ${env.dark ? 0.3 : 0.34})`);
      this.grad = g;
      this.gradBand = band;
      this.gradDark = env.dark;
    }
    const fx = this.frontX();
    ctx.setTransform(dpr, 0, 0, dpr, dpr * fx, 0);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.grad;
    ctx.beginPath();
    ctx.moveTo(-band, 0);
    const steps = 28;
    for (let k = 0; k <= steps; k++) {
      const y = (k / steps) * h;
      ctx.lineTo(this.wave(y), y);
    }
    ctx.lineTo(-band, h);
    ctx.closePath();
    ctx.fill();
    // Foamy leading edge.
    ctx.globalAlpha = alpha * 0.6;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let k = 0; k <= steps; k++) {
      const y = (k / steps) * h;
      if (k === 0) ctx.moveTo(this.wave(y), y);
      else ctx.lineTo(this.wave(y), y);
    }
    ctx.stroke();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------
// Comets
// ---------------------------------------------------------------------------

export type CometDirection = 'up' | 'down' | 'left' | 'right';

export class Comet implements Effect {
  readonly kind: SpecialEffect;
  readonly front = true;
  private t = 0;
  private readonly dur: number;
  private readonly dx: number;
  private readonly dy: number;
  private readonly sx: number;
  private readonly sy: number;
  private readonly ex: number;
  private readonly ey: number;
  private readonly len: number;
  private readonly headR: number;
  private readonly color: number;
  private readonly stars = new Accumulator();

  constructor(
    private readonly host: EffectHost,
    dir: CometDirection,
  ) {
    this.kind = `comet-${dir}`;
    const { width: w, height: h, reduceMotion: reduce } = host.env;
    const m = Math.min(w, h);
    this.dx = dir === 'right' ? 1 : dir === 'left' ? -1 : 0;
    this.dy = dir === 'down' ? 1 : dir === 'up' ? -1 : 0;
    this.color = host.env.randomPalette();
    this.headR = clamp(m * 0.03, 14, 40);
    const horizontal = this.dy === 0;
    const lane = rand(0.15, 0.85) * (horizontal ? h : w);
    if (reduce) {
      // Gentle version: a short streak that drifts a little and fades.
      this.len = m * 0.14;
      this.dur = 1.0;
      const cx = horizontal ? rand(0.3, 0.7) * w : lane;
      const cy = horizontal ? lane : rand(0.3, 0.7) * h;
      this.sx = cx - this.dx * 35;
      this.sy = cy - this.dy * 35;
      this.ex = cx + this.dx * 35;
      this.ey = cy + this.dy * 35;
    } else {
      this.len = m * 0.42;
      this.dur = rand(1.05, 1.25);
      const pad = this.headR * 2;
      if (horizontal) {
        this.sx = this.dx > 0 ? -pad : w + pad;
        this.ex = this.dx > 0 ? w + this.len + pad : -this.len - pad;
        this.sy = lane;
        this.ey = lane + rand(-0.08, 0.08) * h;
      } else {
        this.sy = this.dy > 0 ? -pad : h + pad;
        this.ey = this.dy > 0 ? h + this.len + pad : -this.len - pad;
        this.sx = lane;
        this.ex = lane + rand(-0.08, 0.08) * w;
      }
    }
  }

  private head(p: number, out: { x: number; y: number }): void {
    out.x = lerp(this.sx, this.ex, p);
    out.y = lerp(this.sy, this.ey, p);
  }

  private readonly pos = { x: 0, y: 0 };

  update(dt: number): boolean {
    this.t += dt;
    const env = this.host.env;
    if (!env.reduceMotion && this.t < this.dur) {
      const n = this.stars.take(36 * env.emitScale, dt);
      if (n > 0) {
        this.head(this.t / this.dur, this.pos);
        const pool = this.host.emitter.pool;
        const light = this.host.sprites.colors.light(this.color);
        for (let k = 0; k < n; k++) {
          const i = this.host.emitter.one(PS_STAR, this.pos.x, this.pos.y, k % 2 ? light : this.color, 0.25);
          pool.vx[i] -= this.dx * 60;
          pool.vy[i] -= this.dy * 60;
          pool.size[i] *= 0.8;
        }
      }
    }
    return this.t < this.dur;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const env = this.host.env;
    const sprites = this.host.sprites;
    const dpr = env.dpr;
    const p = clamp01(this.t / this.dur);
    this.head(env.reduceMotion ? easeOutCubic(p) : p, this.pos);
    const alpha = env.reduceMotion ? Math.sin(Math.PI * p) : 1;
    if (alpha <= 0.002) return;
    const x = this.pos.x;
    const y = this.pos.y;
    if (env.dark) ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha;
    // Tail sprite points +x with its head at the right edge; rotate to the travel direction.
    const thick = this.headR * 2.2;
    const c = this.dx * dpr;
    const s = this.dy * dpr;
    ctx.setTransform(c, s, -s, c, x * dpr, y * dpr);
    ctx.drawImage(sprites.particle(SPR_TAIL, this.color), -this.len, -thick / 2, this.len + this.headR, thick);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = this.headR * 2 * 2.4;
    ctx.drawImage(sprites.particle(SPR_GLOW, this.color), x - g / 2, y - g / 2, g, g);
    const core = this.headR * 1.6;
    ctx.drawImage(sprites.particle(SPR_GLOW, env.white), x - core / 2, y - core / 2, core, core);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the effect object for a special. Returns null for specials that act
 * immediately without a visual of their own ('pop-all', reduced-motion sweep).
 */
export function createEffect(kind: SpecialEffect, host: EffectHost, at?: { x: number; y: number }): Effect | null {
  switch (kind) {
    case 'rainbow':
      return new Rainbow(host);
    case 'fireworks':
      return new Fireworks(host, at);
    case 'sweep':
      if (host.env.reduceMotion) {
        host.objects.fadeAll();
        return null;
      }
      return new Sweep(host);
    case 'pop-all':
      host.objects.popAll();
      return null;
    case 'comet-up':
      return new Comet(host, 'up');
    case 'comet-down':
      return new Comet(host, 'down');
    case 'comet-left':
      return new Comet(host, 'left');
    case 'comet-right':
      return new Comet(host, 'right');
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Ripples
// ---------------------------------------------------------------------------

const RIPPLE_SLOTS = 16;
const RIPPLE_DUR = 0.6;

export class RippleLayer {
  private readonly x = new Float32Array(RIPPLE_SLOTS);
  private readonly y = new Float32Array(RIPPLE_SLOTS);
  private readonly t0 = new Float64Array(RIPPLE_SLOTS).fill(-1e9);
  private readonly color = new Uint8Array(RIPPLE_SLOTS);
  private next = 0;

  constructor(private readonly host: EffectHost) {}

  add(x: number, y: number, colorId: number): void {
    const i = this.next;
    this.next = (i + 1) % RIPPLE_SLOTS;
    this.x[i] = x;
    this.y[i] = y;
    this.t0[i] = this.host.env.time;
    this.color[i] = colorId;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const env = this.host.env;
    const colors = this.host.sprites.colors;
    const t = env.time;
    const scale = env.reduceMotion ? 0.75 : 1;
    for (let i = 0; i < RIPPLE_SLOTS; i++) {
      const age = t - this.t0[i];
      if (age < 0 || age >= RIPPLE_DUR) continue;
      const p = age / RIPPLE_DUR;
      const r = lerp(12, 96, easeOutCubic(p)) * scale;
      ctx.globalAlpha = 0.9 * (1 - p);
      ctx.strokeStyle = colors.hex(this.color[i]);
      ctx.lineWidth = lerp(9, 1.5, p);
      ctx.beginPath();
      ctx.arc(this.x[i], this.y[i], r, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 0.45 * (1 - p);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = lerp(5, 1, p);
      ctx.beginPath();
      ctx.arc(this.x[i], this.y[i], r * 0.62, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  clear(): void {
    this.t0.fill(-1e9);
  }
}

// ---------------------------------------------------------------------------
// Pointer trails
// ---------------------------------------------------------------------------

const TRAIL_SLOTS = 10;
const TRAIL_POINTS = 32;
const TRAIL_TTL = 0.65;
const TRAIL_MIN_STEP = 2.5;
const TRAIL_SHED_EVERY = 26; // px travelled per shed particle
/** Length of each palette-colour stripe along the ribbon, in ribbon widths. */
const TRAIL_STRIPE = 2.4;

class TrailSlot {
  id = -1;
  ended = true;
  readonly xs = new Float32Array(TRAIL_POINTS);
  readonly ys = new Float32Array(TRAIL_POINTS);
  readonly ts = new Float64Array(TRAIL_POINTS);
  /** Distance travelled when each point was added (stable stripe colours). */
  readonly ds = new Float32Array(TRAIL_POINTS);
  head = 0;
  len = 0;
  travelled = 0;
  lastUsed = -1e9;
  colorBase = 0;
  shed = 0;

  reset(id: number, colorBase: number): void {
    this.id = id;
    this.ended = false;
    this.head = 0;
    this.len = 0;
    this.travelled = 0;
    this.colorBase = colorBase;
    this.shed = 0;
  }

  /** Ring index of the k-th point, oldest first. */
  at(k: number): number {
    return (this.head - this.len + k + TRAIL_POINTS * 2) % TRAIL_POINTS;
  }

  newestTime(): number {
    return this.len > 0 ? this.ts[this.at(this.len - 1)] : -1e9;
  }
}

export class TrailLayer {
  private readonly slots: TrailSlot[] = [];

  constructor(private readonly host: EffectHost) {
    for (let i = 0; i < TRAIL_SLOTS; i++) this.slots.push(new TrailSlot());
  }

  /** Ribbon width for the current viewport. */
  private width(): number {
    return clamp(Math.min(this.host.env.width, this.host.env.height) * 0.024, 9, 26);
  }

  add(x: number, y: number, colorId: number, pointerId: number): void {
    const env = this.host.env;
    const t = env.time;
    let slot: TrailSlot | null = null;
    for (let i = 0; i < TRAIL_SLOTS; i++) {
      const s = this.slots[i];
      if (s.id === pointerId && !s.ended) {
        slot = s;
        break;
      }
    }
    if (!slot) {
      // Prefer a slot whose trail has fully faded, then the least recently used.
      let best = this.slots[0];
      let bestScore = Infinity;
      for (let i = 0; i < TRAIL_SLOTS; i++) {
        const s = this.slots[i];
        const faded = t - s.newestTime() > TRAIL_TTL;
        const score = (faded ? -1e12 : 0) + (s.ended ? -1e6 : 0) + s.lastUsed;
        if (score < bestScore) {
          bestScore = score;
          best = s;
        }
      }
      slot = best;
      let base = 0;
      for (let i = 0; i < env.paletteLen; i++) {
        if (env.palette[i] === colorId) {
          base = i;
          break;
        }
      }
      slot.reset(pointerId, base);
    }
    slot.lastUsed = t;
    if (slot.len > 0) {
      const last = slot.at(slot.len - 1);
      const dx = x - slot.xs[last];
      const dy = y - slot.ys[last];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < TRAIL_MIN_STEP) return;
      slot.travelled += d;
      slot.shed += d;
      while (slot.shed >= TRAIL_SHED_EVERY) {
        slot.shed -= TRAIL_SHED_EVERY;
        if (Math.random() < 0.6) this.host.emitter.one(env.particleStyle, x, y, this.stripeColor(slot, slot.travelled), 0.3);
      }
    }
    const i = slot.head;
    slot.xs[i] = x;
    slot.ys[i] = y;
    slot.ts[i] = t;
    slot.ds[i] = slot.travelled;
    slot.head = (i + 1) % TRAIL_POINTS;
    if (slot.len < TRAIL_POINTS) slot.len++;
  }

  end(pointerId: number): void {
    for (let i = 0; i < TRAIL_SLOTS; i++) {
      const s = this.slots[i];
      if (s.id === pointerId) s.ended = true;
    }
  }

  /** Palette colour of the stripe at a travelled distance (hue cycles along the ribbon). */
  private stripeColor(slot: TrailSlot, dist: number): number {
    const env = this.host.env;
    if (env.paletteLen === 0) return env.white;
    return env.palette[(slot.colorBase + Math.floor(dist / (this.width() * TRAIL_STRIPE))) % env.paletteLen];
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const env = this.host.env;
    const sprites = this.host.sprites;
    const colors = sprites.colors;
    const t = env.time;
    const maxW = this.width();
    const glowGap2 = maxW * maxW * 0.8;
    ctx.lineCap = 'round';
    for (let si = 0; si < TRAIL_SLOTS; si++) {
      const s = this.slots[si];
      if (s.len < 2 || t - s.newestTime() > TRAIL_TTL) continue;
      // Skip expired points at the old end.
      let k0 = 0;
      while (k0 < s.len && t - s.ts[s.at(k0)] > TRAIL_TTL) k0++;
      if (s.len - k0 < 2) continue;

      // Glow pass: soft stamps, spaced about a ribbon width apart so a slow
      // finger doesn't pile them up into a white blob (additive on dark worlds).
      ctx.globalCompositeOperation = env.dark ? 'lighter' : 'source-over';
      let lx = -1e9;
      let ly = -1e9;
      for (let k = s.len - 1; k >= k0; k--) {
        const i = s.at(k);
        const dx = s.xs[i] - lx;
        const dy = s.ys[i] - ly;
        if (dx * dx + dy * dy < glowGap2) continue;
        lx = s.xs[i];
        ly = s.ys[i];
        const f = 1 - (t - s.ts[i]) / TRAIL_TTL;
        if (f <= 0) continue;
        const g = maxW * 2.6 * Math.sqrt(f);
        ctx.globalAlpha = (env.dark ? 0.32 : 0.22) * f;
        ctx.drawImage(sprites.particle(SPR_GLOW, this.stripeColor(s, s.ds[i])), lx - g / 2, ly - g / 2, g, g);
      }
      ctx.globalCompositeOperation = 'source-over';

      // Core ribbon: quadratic curves through midpoints, width tapering with age.
      ctx.globalAlpha = 1;
      for (let k = k0; k < s.len - 1; k++) {
        const i0 = s.at(k);
        const i1 = s.at(k + 1);
        const f = 1 - (t - s.ts[i1]) / TRAIL_TTL;
        if (f <= 0) continue;
        const mx0 = k === k0 ? s.xs[i0] : (s.xs[s.at(k - 1)] + s.xs[i0]) / 2;
        const my0 = k === k0 ? s.ys[i0] : (s.ys[s.at(k - 1)] + s.ys[i0]) / 2;
        const mx1 = (s.xs[i0] + s.xs[i1]) / 2;
        const my1 = (s.ys[i0] + s.ys[i1]) / 2;
        ctx.lineWidth = maxW * Math.pow(f, 0.8);
        ctx.strokeStyle = colors.hex(this.stripeColor(s, s.ds[i0]));
        ctx.beginPath();
        ctx.moveTo(mx0, my0);
        ctx.quadraticCurveTo(s.xs[i0], s.ys[i0], mx1, my1);
        if (k === s.len - 2) ctx.lineTo(s.xs[i1], s.ys[i1]);
        ctx.stroke();
      }

      // Sparkly head while the pointer is moving.
      const hi = s.at(s.len - 1);
      const hf = 1 - (t - s.ts[hi]) / TRAIL_TTL;
      if (hf > 0) {
        const g = maxW * 1.8;
        if (env.dark) ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.8 * hf;
        ctx.drawImage(sprites.particle(SPR_GLOW, env.white), s.xs[hi] - g / 2, s.ys[hi] - g / 2, g, g);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 1;
  }

  clear(): void {
    for (let i = 0; i < TRAIL_SLOTS; i++) {
      this.slots[i].len = 0;
      this.slots[i].ended = true;
    }
  }
}
