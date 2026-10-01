/**
 * CanvasScene: the play surface a toddler sees.
 *
 * Draw order: backdrop (cross-faded over 1.2 s on world change) → rainbow/sweep →
 * ripples + trails → objects (oldest first) → particles → fireworks/comets →
 * calm dimming overlay.
 *
 * Everything animates on a simulation clock (`env.time`) that runs slower as
 * calm rises, so the wind-down gently slows the whole world. All subsystems
 * are bounded: object cap by intensity, ≤ 8 effects, 16 ripples, 10 trails,
 * a fixed particle pool, and LRU sprite caches.
 */

import type { EmojiSpec, GlyphSpec, Intensity, NamedColor, PokeResult, Scene, SceneOptions, ShapeSpec, SpecialEffect, World } from '../types';
import { createBackdrop, type Backdrop } from './backgrounds';
import { drawShape } from './shapes';
import { SpriteFactory } from './sprites';
import { DEFAULT_PARTICLE_CAPACITY, Emitter, PARTICLE_STYLE_ID, PS_SPARK, ParticlePool, RenderEnv, drawParticles } from './particles';
import { LIFE_MUL, OBJECT_CAP, ObjectLayer, SIZE_FACTOR } from './entities';
import { Rainbow, RippleLayer, Sweep, TrailLayer, createEffect, type Effect, type EffectHost } from './effects';
import { approach, clamp, clamp01, easeInOutSine } from './easing';
import { relativeLuminance } from './color';

const PARTICLE_INTENSITY: Record<Intensity, number> = { calm: 0.5, normal: 1, wild: 1.6 };
const MAX_EFFECTS = 8;
const CROSSFADE_SECONDS = 1.2;
/** Calm eases toward its target at this rate (full range in ~1 s). */
const CALM_RATE = 1;
const MAX_CALM_DIM = 0.45;

export class CanvasScene implements Scene {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly env = new RenderEnv();
  private readonly sprites: SpriteFactory;
  private readonly pool = new ParticlePool(DEFAULT_PARTICLE_CAPACITY);
  private readonly emitter: Emitter;
  private readonly objects: ObjectLayer;
  private readonly ripples: RippleLayer;
  private readonly trails: TrailLayer;
  private readonly effects: Effect[] = [];
  private readonly host: EffectHost;

  private world: World;
  private options: SceneOptions;
  private backdrop: Backdrop;
  /** Previous backdrop while cross-fading (drawn underneath the new one). */
  private outgoing: Backdrop | null = null;
  private fade = 1;

  private calmTarget = 0;
  private dimColor = '#000000';

  constructor(ctx: CanvasRenderingContext2D, world: World, options: SceneOptions) {
    this.ctx = ctx;
    this.world = world;
    this.options = { ...options };
    this.sprites = new SpriteFactory(options.fontFamily, drawShape);
    this.emitter = new Emitter(this.pool, this.env, this.sprites.colors);
    this.objects = new ObjectLayer(this.env, this.sprites, this.emitter);
    this.host = { env: this.env, emitter: this.emitter, sprites: this.sprites, objects: this.objects };
    this.ripples = new RippleLayer(this.host);
    this.trails = new TrailLayer(this.host);
    this.env.white = this.sprites.colors.id('#ffffff');

    // Best guess until the integrator calls resize() with the stage's numbers.
    const canvas = ctx.canvas;
    const cssW = canvas.clientWidth || canvas.width || 1;
    const cssH = canvas.clientHeight || canvas.height || 1;
    this.env.width = cssW;
    this.env.height = cssH;
    this.env.dpr = clamp(canvas.width / cssW, 1, 3);
    this.sprites.setDpr(this.env.dpr);

    this.applyOptions(this.options);
    this.applyWorld(world);
    this.backdrop = createBackdrop(world, { reduceMotion: this.options.reduceMotion });
    this.backdrop.resize(this.env.width, this.env.height, this.env.dpr);
  }

  get objectCount(): number {
    return this.objects.liveCount;
  }

  // -- configuration ------------------------------------------------------------

  setWorld(world: World): void {
    if (world === this.world) return;
    this.world = world;
    this.applyWorld(world);
    this.crossfadeTo(createBackdrop(world, { reduceMotion: this.options.reduceMotion }));
  }

  setOptions(options: SceneOptions): void {
    const prev = this.options;
    this.options = { ...options };
    this.applyOptions(this.options);
    if (prev.fontFamily !== options.fontFamily) this.sprites.setFontFamily(options.fontFamily);
    if (prev.reduceMotion !== options.reduceMotion) {
      this.crossfadeTo(createBackdrop(this.world, { reduceMotion: options.reduceMotion }));
    }
  }

  setCalm(level: number): void {
    this.calmTarget = Number.isFinite(level) ? clamp01(level) : 0;
  }

  private applyOptions(o: SceneOptions): void {
    const env = this.env;
    env.reduceMotion = !!o.reduceMotion;
    env.faces = !!o.faces;
    env.intensityMul = PARTICLE_INTENSITY[o.intensity] ?? 1;
    this.objects.cap = OBJECT_CAP[o.intensity] ?? OBJECT_CAP.normal;
    this.objects.lifeMul = LIFE_MUL[o.intensity] ?? 1;
    this.objects.sizeFactor = SIZE_FACTOR[o.size] ?? SIZE_FACTOR.normal;
    this.objects.enforceCap();
  }

  private applyWorld(world: World): void {
    const env = this.env;
    env.dark = world.dark;
    env.gravity = Number.isFinite(world.gravity) ? world.gravity : 0;
    env.energy = Number.isFinite(world.energy) ? clamp(world.energy, 0.3, 2) : 1;
    env.particleStyle = PARTICLE_STYLE_ID[world.particle] ?? PS_SPARK;
    const colors = this.sprites.colors;
    for (let i = 0; i < env.paletteLen; i++) colors.pin(env.palette[i], false);
    const n = Math.min(world.palette.length, env.palette.length);
    for (let i = 0; i < n; i++) {
      env.palette[i] = colors.id(world.palette[i].hex);
      colors.pin(env.palette[i]);
    }
    env.paletteLen = n;
    colors.pin(env.white);
    const [a, b] = world.sky;
    this.dimColor = relativeLuminance(a) <= relativeLuminance(b) ? a : b;
  }

  private crossfadeTo(next: Backdrop): void {
    const env = this.env;
    next.resize(env.width, env.height, env.dpr);
    if (this.outgoing && this.fade < 0.5) {
      // The current incoming backdrop is still mostly hidden: just replace it.
      this.backdrop = next;
    } else {
      this.outgoing = this.backdrop;
      this.backdrop = next;
      this.fade = 0;
    }
  }

  // -- spawning -------------------------------------------------------------------

  spawnGlyph(spec: GlyphSpec): void {
    this.objects.spawnGlyph(spec);
  }

  spawnShape(spec: ShapeSpec): void {
    this.objects.spawnShape(spec);
  }

  spawnEmoji(spec: EmojiSpec): void {
    this.objects.spawnEmoji(spec);
  }

  burst(x: number, y: number, color: NamedColor, power = 1): void {
    const p = Number.isFinite(power) ? clamp(power, 0, 2) : 1;
    this.emitter.burst(x, y, this.sprites.colors.id(color.hex), p);
  }

  ripple(x: number, y: number, color: NamedColor): void {
    this.ripples.add(x, y, this.sprites.colors.id(color.hex));
  }

  trail(x: number, y: number, color: NamedColor, pointerId: number): void {
    this.trails.add(x, y, this.sprites.colors.id(color.hex), pointerId);
  }

  endTrail(pointerId: number): void {
    this.trails.end(pointerId);
  }

  special(effect: SpecialEffect, at?: { x: number; y: number }): void {
    // Only one rainbow / sweep at a time: big translucent areas must not
    // restart faster than they fade (photosensitivity), and it reads better.
    if (effect === 'rainbow') {
      for (let i = 0; i < this.effects.length; i++) {
        const e = this.effects[i];
        if (e instanceof Rainbow) {
          e.sparkle();
          return;
        }
      }
    } else if (effect === 'sweep') {
      for (let i = 0; i < this.effects.length; i++) if (this.effects[i] instanceof Sweep) return;
    }
    const e = createEffect(effect, this.host, at);
    if (!e) return;
    if (this.effects.length >= MAX_EFFECTS) this.evictEffect();
    this.effects.push(e);
  }

  /** Drops the oldest small effect (never a rainbow/sweep mid-way, which would pop). */
  private evictEffect(): void {
    const list = this.effects;
    let idx = 0;
    for (let i = 0; i < list.length; i++) {
      const k = list[i].kind;
      if (k !== 'rainbow' && k !== 'sweep') {
        idx = i;
        break;
      }
    }
    for (let i = idx; i < list.length - 1; i++) list[i] = list[i + 1];
    list.length--;
  }

  poke(x: number, y: number): PokeResult | null {
    return this.objects.poke(x, y);
  }

  // -- frame ------------------------------------------------------------------------

  update(dt: number, now: number): void {
    const env = this.env;
    const realDt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    env.calm = approach(env.calm, this.calmTarget, realDt * CALM_RATE);
    const simDt = realDt * (1 - 0.7 * env.calm);
    env.time += simDt;

    this.backdrop.update(realDt, now, env.calm);
    if (this.outgoing) {
      this.fade += realDt / CROSSFADE_SECONDS;
      if (this.fade >= 1) {
        this.fade = 1;
        this.outgoing = null;
      } else {
        this.outgoing.update(realDt, now, env.calm);
      }
    }

    this.objects.update(simDt);

    const fx = this.effects;
    let w = 0;
    for (let i = 0; i < fx.length; i++) {
      const e = fx[i];
      if (e.update(simDt)) fx[w++] = e;
    }
    fx.length = w;

    this.pool.update(simDt);
  }

  draw(): void {
    const ctx = this.ctx;
    const env = this.env;
    this.resetState();

    // Cross-fade: old backdrop underneath, new one on top at rising alpha
    // (Backdrop.draw multiplies the caller's globalAlpha into everything).
    if (this.outgoing) {
      this.outgoing.draw(ctx);
      this.resetState();
      ctx.globalAlpha = easeInOutSine(this.fade);
    }
    this.backdrop.draw(ctx);
    this.resetState();

    const fx = this.effects;
    for (let i = 0; i < fx.length; i++) if (!fx[i].front) fx[i].draw(ctx);

    this.ripples.draw(ctx);
    this.trails.draw(ctx);
    this.objects.draw(ctx);
    drawParticles(ctx, this.pool, this.sprites, env, false);
    drawParticles(ctx, this.pool, this.sprites, env, true);

    for (let i = 0; i < fx.length; i++) if (fx[i].front) fx[i].draw(ctx);

    if (env.calm > 0.001) {
      ctx.globalAlpha = MAX_CALM_DIM * env.calm;
      ctx.fillStyle = this.dimColor;
      ctx.fillRect(0, 0, env.width, env.height);
    }
    this.resetState();
  }

  private resetState(): void {
    const ctx = this.ctx;
    const dpr = this.env.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  resize(width: number, height: number, dpr: number): void {
    const env = this.env;
    env.width = Math.max(1, width || 1);
    env.height = Math.max(1, height || 1);
    env.dpr = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
    this.sprites.setDpr(env.dpr);
    this.backdrop.resize(env.width, env.height, env.dpr);
    this.outgoing?.resize(env.width, env.height, env.dpr);
    this.objects.clampAll();
  }
}
