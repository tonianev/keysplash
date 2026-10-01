/**
 * Big on-screen objects: glyphs (letters/numbers, optionally with a picture,
 * a caption or a counting ring), shapes with faces, and emoji stickers.
 *
 * Objects are pooled (fixed maximum), kept in spawn order (oldest drawn
 * first), and animated entirely from the scene's simulation clock:
 * spring pop → gentle drift/bob → exit (fade, fast fade, pop or swept away).
 * The per-frame transform is computed in update() so poke() hit-tests what
 * the child actually sees.
 */

import type { EmojiSpec, GlyphSpec, Intensity, PokeResult, ShapeKind, ShapeSpec, SizeLevel, NamedColor } from '../types';
import type { Sprite, SpriteFactory } from './sprites';
import type { Emitter, RenderEnv } from './particles';
import { drawFace } from './shapes';
import { TAU, clamp, clamp01, easeOutBack, easeOutCubic } from './easing';

export const OBJECT_CAP: Record<Intensity, number> = { calm: 10, normal: 22, wild: 36 };
export const LIFE_MUL: Record<Intensity, number> = { calm: 1.4, normal: 1, wild: 0.75 };
export const SIZE_FACTOR: Record<SizeLevel, number> = { normal: 0.24, big: 0.32, huge: 0.42 };

/** Hard limit on pooled objects, including ones that are exiting. */
const MAX_OBJECTS = 96;

const SPAWN_DUR = 0.42;
/** easeOutBack overshoot giving a ~1.15 peak. */
const SPAWN_OVERSHOOT = 2.16;
const BASE_LIFE = 3.6;
const JIGGLE_DUR = 0.6;
const POKE_EXTEND = 2;
const MAX_REMAINING_LIFE = 8;
const BLINK_DUR = 0.14;
const COUNT_FIRST_DELAY = 0.32;
const COUNT_STEP = 0.17;
const COUNT_POP_DUR = 0.3;
const PIC_DELAY = 0.12;

const EXIT_FADE = 0;
const EXIT_FAST = 1;
const EXIT_POP = 2;
const EXIT_SWEPT = 3;
const EXIT_DUR = [0.4, 0.25, 0.18, 1.2];

export type ObjectKind = 'glyph' | 'shape' | 'emoji';

export class SceneObject {
  kind: ObjectKind = 'glyph';
  value = '';
  color: NamedColor | null = null;
  colorId = 0;
  shape: ShapeKind | null = null;

  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  tilt = 0;
  phase = 0;
  bobAmp = 0;

  born = 0;
  lifeEnd = 0;
  exiting = false;
  exitKind = EXIT_FADE;
  exitStart = 0;
  exitDur = 0.4;
  popAt = -1;
  jiggleAt = -1;

  sprite: Sprite | null = null;
  /** Sprite (bucket) → on-screen size factor. */
  scale = 1;
  /** Hit radius and half extents in screen px at rest (scale included). */
  radius = 0;
  halfW = 0;
  halfH = 0;

  /** Caption word under a glyph; capY is its centre below the anchor (screen px at rest). */
  cap: Sprite | null = null;
  capScale = 1;
  capY = 0;
  /** Picture: companion emoji beside the glyph, or the counting emoji. */
  pic: Sprite | null = null;
  picScale = 1;
  picX = 0;
  picY = 0;
  /** Count mode: -1 off, else number of emoji in the ring. */
  count = -1;
  countShown = 0;
  ringR = 0;

  nextBlink = 0;
  blinkAt = -1;
  ohUntil = 0;

  // Computed each update for drawing and hit-testing.
  cx = 0;
  cy = 0;
  sx = 1;
  sy = 1;
  anim = 1;
  rot = 0;
  alpha = 0;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Spec `scale` with a sane default and range. */
function userScale(scale: number | undefined): number {
  return typeof scale === 'number' && Number.isFinite(scale) ? clamp(scale, 0.2, 3) : 1;
}

export class ObjectLayer {
  /** Live objects, oldest first (draw order). */
  readonly list: SceneObject[] = [];
  private readonly free: SceneObject[] = [];
  private readonly sortScratch: SceneObject[] = [];

  cap = OBJECT_CAP.normal;
  lifeMul = 1;
  sizeFactor = SIZE_FACTOR.normal;

  constructor(
    private readonly env: RenderEnv,
    private readonly sprites: SpriteFactory,
    private readonly emitter: Emitter,
  ) {}

  /** Objects that are not on their way out. */
  get liveCount(): number {
    let n = 0;
    for (let i = 0; i < this.list.length; i++) if (!this.list[i].exiting) n++;
    return n;
  }

  private baseSize(): number {
    return Math.max(40, Math.min(this.env.width, this.env.height) * this.sizeFactor);
  }

  // -- spawning ---------------------------------------------------------------

  spawnGlyph(spec: GlyphSpec): void {
    const env = this.env;
    const counting = typeof spec.count === 'number' && Number.isFinite(spec.count) && !!spec.emoji;
    const multi = spec.text.length > 1 ? 0.8 : 1;
    const px = this.baseSize() * userScale(spec.scale) * multi * (counting ? 0.78 : 1);
    const sprite = this.sprites.glyph(spec.text, spec.color, px, env.dark);
    const o = this.begin('glyph', spec.text, spec.color);
    this.attachSprite(o, sprite, px / sprite.size);

    if (spec.caption && !counting) {
      const cpx = px * 0.28;
      const cap = this.sprites.caption(spec.caption, spec.color, cpx);
      o.cap = cap;
      o.capScale = cpx / cap.size;
      const capHalfH = cap.halfH * o.capScale;
      o.capY = sprite.halfH * o.scale + px * 0.05 + capHalfH;
      o.halfW = Math.max(o.halfW, cap.halfW * o.capScale);
      o.halfH = Math.max(o.halfH, o.capY + capHalfH);
    }

    if (counting && spec.emoji) {
      const n = clamp(Math.round(spec.count ?? 0), 0, 12);
      o.count = n;
      if (n > 0) {
        const epx = px * (n <= 3 ? 0.5 : n <= 6 ? 0.42 : 0.34);
        const pic = this.sprites.emoji(spec.emoji, epx);
        o.pic = pic;
        o.picScale = epx / pic.size;
        o.ringR = sprite.radius * o.scale + epx * 0.62;
        const reach = o.ringR + epx * 0.55;
        o.halfW = Math.max(o.halfW, reach);
        o.halfH = Math.max(o.halfH, reach);
        o.radius = o.ringR + epx * 0.5;
        // Everyone must have time to appear and be counted.
        o.lifeEnd = Math.max(o.lifeEnd, o.born + COUNT_FIRST_DELAY + n * COUNT_STEP + 2.6);
      }
    } else if (spec.emoji) {
      const epx = px * 0.6;
      const pic = this.sprites.emoji(spec.emoji, epx);
      o.pic = pic;
      o.picScale = epx / pic.size;
      const picHalf = pic.radius * o.picScale;
      const side = spec.x > env.width * 0.62 ? -1 : 1;
      o.picX = side * (sprite.halfW * o.scale * 0.8 + picHalf * 0.55);
      o.picY = -sprite.radius * o.scale * 0.62;
      o.halfW = Math.max(o.halfW, Math.abs(o.picX) + picHalf);
      o.halfH = Math.max(o.halfH, Math.abs(o.picY) + picHalf);
    }
    this.finish(o, spec.x, spec.y);
  }

  spawnShape(spec: ShapeSpec): void {
    const env = this.env;
    const r = this.baseSize() * 0.5 * userScale(spec.scale);
    const sprite = this.sprites.shape(spec.shape, spec.color, r, env.dark);
    const o = this.begin('shape', spec.shape, spec.color);
    o.shape = spec.shape;
    this.attachSprite(o, sprite, r / sprite.size);
    o.nextBlink = o.born + rand(1, 4);
    this.finish(o, spec.x, spec.y);
  }

  spawnEmoji(spec: EmojiSpec): void {
    const px = this.baseSize() * 0.95 * userScale(spec.scale);
    const sprite = this.sprites.emoji(spec.emoji, px);
    const o = this.begin('emoji', spec.emoji, null);
    this.attachSprite(o, sprite, px / sprite.size);
    this.finish(o, spec.x, spec.y);
  }

  private begin(kind: ObjectKind, value: string, color: NamedColor | null): SceneObject {
    const env = this.env;
    if (this.list.length >= MAX_OBJECTS) this.dropOldest();
    const o = this.free.pop() ?? new SceneObject();
    const reduce = env.reduceMotion;
    o.kind = kind;
    o.value = value;
    o.color = color;
    o.colorId = color ? this.sprites.colors.id(color.hex) : env.randomPalette();
    o.shape = null;
    o.born = env.time;
    o.lifeEnd = env.time + BASE_LIFE * this.lifeMul;
    o.exiting = false;
    o.exitKind = EXIT_FADE;
    o.popAt = -1;
    o.jiggleAt = -1;
    o.phase = Math.random() * TAU;
    o.tilt = reduce ? 0 : rand(-0.1745, 0.1745); // ±10°
    o.bobAmp = 4 + 4 * env.energy;
    const sp = rand(14, 42) * env.energy * (reduce ? 0.4 : 1);
    const ang = Math.random() * TAU;
    o.vx = Math.cos(ang) * sp;
    o.vy = Math.sin(ang) * sp - 10 * env.energy;
    o.cap = null;
    o.pic = null;
    o.count = -1;
    o.countShown = 0;
    o.picX = 0;
    o.picY = 0;
    o.blinkAt = -1;
    o.ohUntil = 0;
    o.alpha = 0;
    o.anim = 0;
    return o;
  }

  private attachSprite(o: SceneObject, sprite: Sprite, scale: number): void {
    o.sprite = sprite;
    o.scale = scale;
    o.radius = sprite.radius * scale;
    o.halfW = sprite.halfW * scale;
    o.halfH = sprite.halfH * scale;
  }

  private finish(o: SceneObject, x: number, y: number): void {
    o.x = Number.isFinite(x) ? x : this.env.width / 2;
    o.y = Number.isFinite(y) ? y : this.env.height / 2;
    this.keepInside(o);
    o.cx = o.x;
    o.cy = o.y;
    this.list.push(o);
    this.enforceCap();
  }

  /** Over the cap, the oldest objects leave quickly. */
  enforceCap(): void {
    let live = this.liveCount;
    for (let i = 0; i < this.list.length && live > this.cap; i++) {
      const o = this.list[i];
      if (o.exiting) continue;
      this.startExit(o, EXIT_FAST);
      live--;
    }
  }

  /** Pool exhausted (extreme mashing): recycle the oldest object right away. */
  private dropOldest(): void {
    const list = this.list;
    let idx = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].exiting) {
        idx = i;
        break;
      }
    }
    const o = list[idx];
    for (let i = idx; i < list.length - 1; i++) list[i] = list[i + 1];
    list.length--;
    this.release(o);
  }

  private release(o: SceneObject): void {
    o.sprite = null;
    o.cap = null;
    o.pic = null;
    o.color = null;
    this.free.push(o);
  }

  private startExit(o: SceneObject, kind: number): void {
    if (o.exiting) return;
    const env = this.env;
    o.exiting = true;
    o.exitKind = kind;
    o.exitStart = env.time;
    o.exitDur = EXIT_DUR[kind];
    if (kind === EXIT_POP) {
      if (env.reduceMotion) {
        o.exitKind = EXIT_FADE;
        o.exitDur = 0.3;
        this.emitter.burst(o.cx, o.cy, o.colorId, 0.4);
      } else {
        this.emitter.burst(o.cx, o.cy, o.colorId, 0.9);
      }
    }
  }

  // -- group actions (effects) ------------------------------------------------

  /** Pop every object with a burst, staggered 40 ms from left to right. */
  popAll(): void {
    const s = this.sortScratch;
    s.length = 0;
    for (let i = 0; i < this.list.length; i++) if (!this.list[i].exiting) s.push(this.list[i]);
    s.sort((a, b) => a.x - b.x);
    const t = this.env.time;
    for (let i = 0; i < s.length; i++) s[i].popAt = t + i * 0.04;
    s.length = 0;
  }

  /** Every object fades away (reduced-motion sweep). */
  fadeAll(): void {
    for (let i = 0; i < this.list.length; i++) {
      const o = this.list[i];
      if (o.exiting) continue;
      this.startExit(o, EXIT_FADE);
      o.exitDur = 0.6;
    }
  }

  /** Objects whose body the wave front has reached get flung off to the right. */
  sweep(frontX: number): void {
    for (let i = 0; i < this.list.length; i++) {
      const o = this.list[i];
      if (o.exiting || o.x - o.halfW * 0.4 > frontX) continue;
      this.startExit(o, EXIT_SWEPT);
      o.vx = rand(720, 1100);
      o.vy = rand(-150, 50);
    }
  }

  /** Re-clamp everything into the viewport (after a resize). */
  clampAll(): void {
    for (let i = 0; i < this.list.length; i++) {
      const o = this.list[i];
      if (o.exiting && o.exitKind === EXIT_SWEPT) continue;
      this.keepInside(o);
      o.cx = o.x;
      o.cy = o.y;
    }
  }

  clear(): void {
    for (let i = 0; i < this.list.length; i++) this.release(this.list[i]);
    this.list.length = 0;
  }

  // -- poke ---------------------------------------------------------------------

  poke(x: number, y: number): PokeResult | null {
    const t = this.env.time;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const o = this.list[i];
      if (o.exiting) continue;
      const s = o.anim > 0.35 ? o.anim : 0.35;
      const dx = x - o.cx;
      const dy = y - o.cy;
      const r = o.radius * s * 1.08 + 6; // a little generous for small fingers
      let hit = dx * dx + dy * dy <= r * r;
      if (!hit && o.pic && o.count < 0) {
        const cs = Math.cos(o.rot);
        const sn = Math.sin(o.rot);
        const px = o.cx + (cs * o.picX - sn * o.picY) * s;
        const py = o.cy + (sn * o.picX + cs * o.picY) * s;
        const pr = o.pic.radius * o.picScale * s + 6;
        const ex = x - px;
        const ey = y - py;
        hit = ex * ex + ey * ey <= pr * pr;
      }
      if (!hit) continue;
      o.jiggleAt = t;
      o.ohUntil = t + 0.7;
      o.lifeEnd = Math.min(Math.max(o.lifeEnd, t) + POKE_EXTEND, t + MAX_REMAINING_LIFE);
      this.emitter.burst(o.cx, o.cy, o.colorId, 0.5);
      return { kind: o.kind, value: o.value, color: o.color };
    }
    return null;
  }

  // -- update ---------------------------------------------------------------------

  update(dt: number): void {
    const list = this.list;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (this.step(o, dt)) list[w++] = o;
      else this.release(o);
    }
    list.length = w;
  }

  private step(o: SceneObject, dt: number): boolean {
    const env = this.env;
    const t = env.time;
    const age = t - o.born;
    const reduce = env.reduceMotion;

    if (!o.exiting) {
      if (o.popAt >= 0 && t >= o.popAt) this.startExit(o, EXIT_POP);
      else if (t >= o.lifeEnd) this.startExit(o, EXIT_FADE);
    }
    const swept = o.exiting && o.exitKind === EXIT_SWEPT;

    // Motion.
    if (swept) {
      o.x += o.vx * dt;
      o.y += o.vy * dt;
    } else {
      const damp = 1 / (1 + 0.35 * dt);
      o.vx *= damp;
      o.vy *= damp;
      // Big objects feel a fraction of the world's gravity: they sink or float gently.
      o.vy += env.gravity * 0.35 * env.energy * dt;
      o.x += o.vx * dt;
      o.y += o.vy * dt;
      this.keepInside(o);
    }

    // Spawn pop (spring with squash-and-stretch), or a soft fade when reduced.
    let s: number;
    let alpha: number;
    let squash = 0;
    let rot = 0;
    const p = age / SPAWN_DUR;
    if (reduce) {
      s = 0.92 + 0.08 * easeOutCubic(p);
      alpha = easeOutCubic(age / 0.3);
    } else {
      s = p >= 1 ? 1 : easeOutBack(p, SPAWN_OVERSHOOT);
      alpha = age < 0.08 ? age / 0.08 : 1;
      if (p < 1) squash = -Math.sin(p * TAU) * (1 - p) * (o.kind === 'shape' ? 0.2 : 0.09);
      rot = o.tilt * (p < 1 ? easeOutCubic(p) : 1) + Math.sin(t * 1.5 + o.phase) * 0.05 * env.energy;
      // Count 0: a little "none!" head-shake.
      if (o.count === 0) {
        const q = age - 0.45;
        if (q > 0 && q < 1) rot += Math.sin(q * TAU * 3) * 0.2 * (1 - q);
      }
    }

    // Poke jiggle.
    if (o.jiggleAt >= 0) {
      const j = (t - o.jiggleAt) / JIGGLE_DUR;
      if (j >= 1) o.jiggleAt = -1;
      else if (reduce) s *= 1 + 0.07 * Math.sin(j * Math.PI);
      else {
        const d = (1 - j) * (1 - j);
        s *= 1 + 0.16 * Math.sin(j * Math.PI * 5) * d;
        rot += 0.24 * Math.sin(j * TAU * 3.5) * d;
        squash += 0.1 * Math.sin(j * Math.PI * 6) * d;
      }
    }

    // Exit.
    if (o.exiting) {
      const e = (t - o.exitStart) / o.exitDur;
      if (e >= 1) return false;
      if (o.exitKind === EXIT_POP) {
        s *= 1 + 0.32 * easeOutCubic(e);
        alpha *= 1 - e;
      } else if (o.exitKind === EXIT_SWEPT) {
        alpha *= 1 - clamp01((e - 0.45) / 0.55);
        rot += 0.25 * clamp01(e * 3);
        if (o.x - o.halfW > env.width + 20 || o.y + o.halfH < -20 || o.y - o.halfH > env.height + 20) return false;
      } else {
        if (!reduce) s *= 1 - 0.35 * e;
        alpha *= 1 - e * e;
      }
    }

    const bob = reduce ? 0 : Math.sin(t * 2.2 + o.phase) * o.bobAmp;
    o.anim = s;
    o.sx = o.scale * s * (1 + squash);
    o.sy = o.scale * s * (1 - squash);
    o.rot = rot;
    o.alpha = alpha > 1 ? 1 : alpha < 0 ? 0 : alpha;
    o.cx = o.x;
    o.cy = o.y + bob;

    // Counting: reveal the ring emoji one by one, each with a tiny burst.
    if (o.count > 0 && o.countShown < o.count && !o.exiting) {
      const due = Math.min(o.count, Math.floor((age - COUNT_FIRST_DELAY) / COUNT_STEP) + 1);
      while (o.countShown < due) {
        const i = o.countShown++;
        const th = -Math.PI / 2 + (i * TAU) / o.count;
        const lx = Math.cos(th) * o.ringR;
        const ly = Math.sin(th) * o.ringR;
        const cs = Math.cos(o.rot);
        const sn = Math.sin(o.rot);
        this.emitter.burst(o.cx + (cs * lx - sn * ly) * s, o.cy + (sn * lx + cs * ly) * s, o.colorId, 0.28);
      }
    }

    if (o.kind === 'shape' && t >= o.nextBlink) {
      o.blinkAt = t;
      o.nextBlink = t + rand(2, 5);
    }
    return true;
  }

  /** Soft bounce off the viewport edges (with damping). */
  private keepInside(o: SceneObject): void {
    const w = this.env.width;
    const h = this.env.height;
    const hw = o.halfW;
    const hh = o.halfH;
    if (hw * 2 >= w) {
      o.x = w / 2;
      o.vx = 0;
    } else if (o.x < hw) {
      o.x = hw;
      if (o.vx < 0) o.vx = -o.vx * 0.55;
    } else if (o.x > w - hw) {
      o.x = w - hw;
      if (o.vx > 0) o.vx = -o.vx * 0.55;
    }
    if (hh * 2 >= h) {
      o.y = h / 2;
      o.vy = 0;
    } else if (o.y < hh) {
      o.y = hh;
      if (o.vy < 0) o.vy = -o.vy * 0.55;
    } else if (o.y > h - hh) {
      o.y = h - hh;
      if (o.vy > 0) o.vy = -o.vy * 0.55;
    }
  }

  // -- draw -----------------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D): void {
    const env = this.env;
    const dpr = env.dpr;
    const t = env.time;
    const reduce = env.reduceMotion;
    const list = this.list;
    for (let n = 0; n < list.length; n++) {
      const o = list[n];
      const sp = o.sprite;
      if (!sp || o.alpha <= 0.004) continue;
      ctx.globalAlpha = o.alpha;
      const cs = Math.cos(o.rot);
      const sn = Math.sin(o.rot);
      ctx.setTransform(dpr * o.sx * cs, dpr * o.sx * sn, -dpr * o.sy * sn, dpr * o.sy * cs, dpr * o.cx, dpr * o.cy);
      ctx.drawImage(sp.canvas, -sp.ax, -sp.ay, sp.w, sp.h);

      const cap = o.cap;
      if (cap) {
        // Same transform as the glyph (local units are glyph-sprite px).
        const k = o.capScale / o.scale;
        ctx.drawImage(cap.canvas, -cap.ax * k, o.capY / o.scale - cap.ay * k, cap.w * k, cap.h * k);
      }

      if (o.shape && env.faces) {
        let blink = 0;
        if (o.blinkAt >= 0) {
          const b = (t - o.blinkAt) / BLINK_DUR;
          if (b < 1) blink = Math.sin(b * Math.PI);
        }
        // drawFace saves/restores its own state, so our transform survives.
        drawFace(ctx, o.shape, sp.size, blink, t < o.ohUntil ? 'oh' : 'smile');
      }

      const pic = o.pic;
      if (!pic) continue;
      const s = o.anim;
      const age = t - o.born;
      if (o.count > 0) {
        for (let i = 0; i < o.countShown; i++) {
          const q = (age - COUNT_FIRST_DELAY - i * COUNT_STEP) / COUNT_POP_DUR;
          const es = q >= 1 ? 1 : reduce ? easeOutCubic(q) : easeOutBack(q, 2.6);
          if (es <= 0.01) continue;
          const th = -Math.PI / 2 + (i * TAU) / o.count;
          const lx = Math.cos(th) * o.ringR;
          const ly = Math.sin(th) * o.ringR + (reduce ? 0 : Math.sin(t * 3 + i * 0.8) * 3);
          const r2 = o.rot + (reduce ? 0 : Math.sin(t * 2.4 + i) * 0.1);
          this.drawPic(ctx, pic, o.cx + (cs * lx - sn * ly) * s, o.cy + (sn * lx + cs * ly) * s, o.picScale * s * es, r2);
        }
      } else if (o.count < 0) {
        const q = (age - PIC_DELAY) / 0.36;
        if (q <= 0) continue;
        const es = reduce ? easeOutCubic(q) : easeOutBack(q, 2.6);
        const ly = o.picY + (reduce ? 0 : Math.sin(t * 2.8 + o.phase * 1.3) * 5);
        const r2 = o.rot + (reduce ? 0 : Math.sin(t * 2.1 + o.phase) * 0.12);
        this.drawPic(ctx, pic, o.cx + (cs * o.picX - sn * ly) * s, o.cy + (sn * o.picX + cs * ly) * s, o.picScale * s * es, r2);
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
  }

  private drawPic(ctx: CanvasRenderingContext2D, pic: Sprite, x: number, y: number, k: number, rot: number): void {
    const dpr = this.env.dpr;
    const c = Math.cos(rot) * k * dpr;
    const s = Math.sin(rot) * k * dpr;
    ctx.setTransform(c, s, -s, c, x * dpr, y * dpr);
    ctx.drawImage(pic.canvas, -pic.ax, -pic.ay, pic.w, pic.h);
  }
}
