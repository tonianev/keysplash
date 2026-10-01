/**
 * Pooled particles (struct-of-arrays in typed arrays, fixed capacity) plus the
 * shared render environment and the emitter that turns "burst here" into
 * styled particles. Spawning when the pool is full overwrites the oldest
 * particle, so memory and per-frame work are bounded no matter how hard a
 * toddler mashes.
 */

import type { ParticleStyle } from '../types';
import type { ColorTable, SpriteFactory } from './sprites';
import { SPR_BUBBLE, SPR_CONFETTI, SPR_GLOW, SPR_LEAF, SPR_PETAL, SPR_STAR, GLOW_SPAN } from './sprites';

// Particle styles (simulation + look).
export const PS_SPARK = 0;
export const PS_BUBBLE = 1;
export const PS_PETAL = 2;
export const PS_CONFETTI = 3;
export const PS_STAR = 4;
export const PS_LEAF = 5;
export const PS_FIREFLY = 6;
/** Firework spark: bright glow that twinkles as it fades. */
export const PS_EMBER = 7;

export const PARTICLE_STYLE_ID: Record<ParticleStyle, number> = {
  spark: PS_SPARK,
  bubble: PS_BUBBLE,
  petal: PS_PETAL,
  confetti: PS_CONFETTI,
  star: PS_STAR,
  leaf: PS_LEAF,
  firefly: PS_FIREFLY,
};

/** Styles drawn with the glow sprite (additive on dark worlds). */
function isGlow(style: number): boolean {
  return style === PS_SPARK || style === PS_FIREFLY || style === PS_EMBER;
}

export const DEFAULT_PARTICLE_CAPACITY = 2400;

export class ParticlePool {
  readonly capacity: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly age: Float32Array;
  /** Lifetime in seconds; 0 marks a free slot. */
  readonly life: Float32Array;
  readonly size: Float32Array;
  readonly rot: Float32Array;
  readonly vrot: Float32Array;
  readonly phase: Float32Array;
  /** Vertical acceleration in px/s² (world gravity, or a style's own). */
  readonly ay: Float32Array;
  /** Linear drag coefficient (1/s). */
  readonly drag: Float32Array;
  readonly style: Uint8Array;
  readonly color: Uint8Array;

  /** Next slot to write; always the least recently spawned slot. */
  private cursor = 0;
  private live = 0;

  constructor(capacity = DEFAULT_PARTICLE_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity));
    const n = this.capacity;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.vrot = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.ay = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.style = new Uint8Array(n);
    this.color = new Uint8Array(n);
  }

  /** Live particle count (never exceeds capacity). */
  get count(): number {
    return this.live;
  }

  isAlive(i: number): boolean {
    return this.life[i] > 0;
  }

  /**
   * Writes a particle into the next ring slot (overwriting the oldest one when
   * the pool is full) and returns its index so callers can tweak extra fields.
   * Defaults: no rotation, no gravity, no drag, random phase.
   */
  spawn(x: number, y: number, vx: number, vy: number, life: number, size: number, style: number, color: number): number {
    const i = this.cursor;
    this.cursor = i + 1 === this.capacity ? 0 : i + 1;
    if (!(this.life[i] > 0)) this.live++;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.age[i] = 0;
    this.life[i] = life > 0.001 ? life : 0.001;
    this.size[i] = size;
    this.rot[i] = 0;
    this.vrot[i] = 0;
    this.phase[i] = Math.random() * 6.2832;
    this.ay[i] = 0;
    this.drag[i] = 0;
    this.style[i] = style;
    this.color[i] = color;
    return i;
  }

  /** Advances every live particle by `dt` seconds. */
  update(dt: number): void {
    const { x, y, vx, vy, age, life, rot, vrot, phase, ay, drag, style } = this;
    for (let i = 0, n = this.capacity; i < n; i++) {
      const l = life[i];
      if (l <= 0) continue;
      const a = age[i] + dt;
      if (a >= l) {
        life[i] = 0;
        this.live--;
        continue;
      }
      age[i] = a;
      const d = drag[i];
      if (d > 0) {
        const k = 1 / (1 + d * dt);
        vx[i] *= k;
        vy[i] *= k;
      }
      vy[i] += ay[i] * dt;
      const s = style[i];
      let wx = 0;
      if (s === PS_BUBBLE) wx = Math.sin(a * 3.4 + phase[i]) * 22;
      else if (s === PS_PETAL || s === PS_LEAF) wx = Math.sin(a * 2.7 + phase[i]) * 46;
      else if (s === PS_FIREFLY) {
        vx[i] += Math.sin(a * 1.9 + phase[i]) * 36 * dt;
        vy[i] += Math.cos(a * 1.4 + phase[i] * 1.7) * 36 * dt;
      }
      x[i] += (vx[i] + wx) * dt;
      y[i] += vy[i] * dt;
      rot[i] += vrot[i] * dt;
    }
  }

  clear(): void {
    this.life.fill(0);
    this.live = 0;
    this.cursor = 0;
  }
}

// ---------------------------------------------------------------------------
// Shared render environment
// ---------------------------------------------------------------------------

/** Mutable per-scene state read by every render subsystem (owned by CanvasScene). */
export class RenderEnv {
  width = 1;
  height = 1;
  dpr = 1;
  /** Simulation clock in seconds (slowed down by calm). */
  time = 0;
  /** Eased calm level 0..1. */
  calm = 0;
  reduceMotion = false;
  faces = true;
  dark = true;
  gravity = 0;
  energy = 1;
  /** Particle count multiplier from intensity (calm 0.5, normal 1, wild 1.6). */
  intensityMul = 1;
  particleStyle = PS_SPARK;
  /** Colour-table ids of the world palette. */
  readonly palette = new Uint8Array(16);
  paletteLen = 0;
  /** Colour-table id of white. */
  white = 0;

  /** Random palette colour id. */
  randomPalette(): number {
    return this.paletteLen > 0 ? this.palette[(Math.random() * this.paletteLen) | 0] : this.white;
  }

  /** Multiplier for any particle count: intensity, calm and reduced motion. */
  get emitScale(): number {
    return this.intensityMul * (1 - 0.6 * this.calm) * (this.reduceMotion ? 0.3 : 1);
  }
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export class Emitter {
  constructor(
    readonly pool: ParticlePool,
    readonly env: RenderEnv,
    readonly colors: ColorTable,
  ) {}

  /** Particle count for a burst of `power` (1 = a normal key press). */
  burstCount(power: number): number {
    return Math.round(18 * power * this.env.emitScale);
  }

  /** A burst in the world's particle style, mostly in `colorId`. */
  burst(x: number, y: number, colorId: number, power = 1): void {
    const n = this.burstCount(power);
    if (n <= 0) return;
    const light = this.colors.light(colorId);
    const style = this.env.particleStyle;
    const speed = 0.7 + 0.3 * Math.min(power, 2);
    for (let k = 0; k < n; k++) {
      const r = Math.random();
      const c = r < 0.62 ? colorId : r < 0.84 ? light : this.env.randomPalette();
      this.one(style, x, y, c, speed);
    }
  }

  /** A few particles of a given style (effects), scaled like bursts. */
  spray(style: number, x: number, y: number, colorId: number, count: number, speedMul = 1): void {
    const n = Math.round(count * this.env.emitScale);
    for (let k = 0; k < n; k++) this.one(style, x, y, colorId, speedMul);
  }

  /**
   * Spawns one particle with style-appropriate random motion. Returns the
   * slot index so effects can adjust it (e.g. direction).
   */
  one(style: number, x: number, y: number, colorId: number, speedMul = 1): number {
    const env = this.env;
    const pool = this.pool;
    const reduce = env.reduceMotion;
    const sm = speedMul * (0.65 + 0.35 * env.energy) * (reduce ? 0.35 : 1);
    const ang = Math.random() * 6.2832;
    // Particles feel the world's full gravity (gentle by design: −25…70 px/s²).
    let ay = env.gravity;
    let sp = 0;
    let life = 1;
    let size = 8;
    let drag = 2;
    let vrot = 0;
    let upBias = 0;
    switch (style) {
      case PS_SPARK:
        sp = rand(140, 380);
        life = rand(0.55, 1.05);
        size = rand(5, 10);
        drag = 2.4;
        break;
      case PS_EMBER:
        // Firework sparks droop the same way in every world.
        sp = rand(150, 300);
        life = rand(0.8, 1.35);
        size = rand(5, 9);
        drag = 1.8;
        ay = 60;
        break;
      case PS_BUBBLE:
        sp = rand(60, 210);
        life = rand(1.1, 2.1);
        size = rand(10, 26);
        drag = 1.3;
        break;
      case PS_PETAL:
        sp = rand(110, 280);
        life = rand(1.4, 2.4);
        size = rand(11, 19);
        drag = 1.5;
        vrot = rand(-4, 4);
        upBias = 90;
        break;
      case PS_LEAF:
        sp = rand(110, 270);
        life = rand(1.4, 2.4);
        size = rand(12, 21);
        drag = 1.5;
        vrot = rand(-3.5, 3.5);
        upBias = 80;
        break;
      case PS_CONFETTI:
        sp = rand(200, 460);
        life = rand(1.4, 2.4);
        size = rand(8, 14);
        drag = 1.6;
        vrot = rand(-7, 7);
        upBias = 180;
        break;
      case PS_STAR:
        sp = rand(110, 320);
        life = rand(0.8, 1.5);
        size = rand(8, 16);
        drag = 2.5;
        vrot = rand(-3, 3);
        break;
      case PS_FIREFLY:
        sp = rand(25, 90);
        life = rand(2.0, 3.4);
        size = rand(6, 10);
        drag = 0.9;
        break;
      default:
        sp = rand(100, 300);
        break;
    }
    if (reduce) {
      life *= 1.2;
      vrot *= 0.2;
      upBias *= 0.35;
      ay *= 0.5;
    }
    const i = pool.spawn(x, y, Math.cos(ang) * sp * sm, Math.sin(ang) * sp * sm - upBias * sm, life, size, style, colorId);
    pool.drag[i] = drag;
    pool.ay[i] = ay;
    pool.vrot[i] = vrot;
    pool.rot[i] = Math.random() * 6.2832;
    return i;
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function spriteKind(style: number): number {
  switch (style) {
    case PS_BUBBLE:
      return SPR_BUBBLE;
    case PS_PETAL:
      return SPR_PETAL;
    case PS_CONFETTI:
      return SPR_CONFETTI;
    case PS_STAR:
      return SPR_STAR;
    case PS_LEAF:
      return SPR_LEAF;
    default:
      return SPR_GLOW;
  }
}

/**
 * Draws one blend pass of the pool. Glow styles are additive ('lighter') on
 * dark worlds and drawn in the normal pass on light worlds (where additive
 * light would wash out to white). Leaves the context in the base transform
 * with globalAlpha 1 and 'source-over'.
 */
export function drawParticles(
  ctx: CanvasRenderingContext2D,
  pool: ParticlePool,
  sprites: SpriteFactory,
  env: RenderEnv,
  additivePass: boolean,
): void {
  const { x, y, age, life, size, rot, phase, style, color } = pool;
  const dpr = env.dpr;
  const dark = env.dark;
  if (additivePass && !dark) return;
  ctx.globalCompositeOperation = additivePass ? 'lighter' : 'source-over';
  let transformed = false;
  for (let i = 0, n = pool.capacity; i < n; i++) {
    const l = life[i];
    if (l <= 0) continue;
    const s = style[i];
    const glow = isGlow(s);
    if ((glow && dark) !== additivePass) continue;
    const a = age[i];
    const f = a / l;
    let alpha = (a < 0.06 ? a / 0.06 : 1) * (f > 0.55 ? 1 - (f - 0.55) / 0.45 : 1);
    let sz = size[i];
    if (glow) {
      if (s === PS_FIREFLY) alpha *= 0.55 + 0.45 * Math.sin(a * 4 + phase[i]);
      else if (s === PS_EMBER && f > 0.45) alpha *= 0.55 + 0.45 * Math.sin(a * 26 + phase[i]);
      sz *= (1 - 0.55 * f) * GLOW_SPAN;
    } else if (s === PS_BUBBLE) {
      if (f > 0.86) {
        const p = (f - 0.86) / 0.14; // pop: swell and vanish
        sz *= 1 + 0.5 * p;
        alpha *= 1 - p;
      } else {
        sz *= 0.85 + 0.25 * f;
      }
    }
    if (alpha <= 0.01) continue;
    ctx.globalAlpha = alpha > 1 ? 1 : alpha;
    const img = sprites.particle(spriteKind(s), color[i]);

    if (glow || s === PS_BUBBLE) {
      if (transformed) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        transformed = false;
      }
      ctx.drawImage(img, x[i] - sz / 2, y[i] - sz / 2, sz, sz);
      continue;
    }

    // Rotated styles: one setTransform per particle, sprite drawn at unit size.
    let sx = sz;
    let sy = sz;
    if (s === PS_CONFETTI) sx = sz * Math.cos(a * 9 + phase[i]); // 3D flip
    else if (s === PS_PETAL || s === PS_LEAF) sy = sz * (0.55 + 0.45 * Math.sin(a * 5 + phase[i]));
    else if (s === PS_STAR) {
      const tw = 0.72 + 0.28 * Math.sin(a * 9 + phase[i]);
      sx = sz * tw;
      sy = sx;
    }
    const r = rot[i];
    const c = Math.cos(r) * dpr;
    const sn = Math.sin(r) * dpr;
    ctx.setTransform(c * sx, sn * sx, -sn * sy, c * sy, x[i] * dpr, y[i] * dpr);
    ctx.drawImage(img, -0.5, -0.5, 1, 1);
    transformed = true;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}
