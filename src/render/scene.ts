/**
 * CanvasScene (v2): the flashcard stage — DESIGN.md §2–3.
 *
 * Focus layout: one centre card plus a shelf of recent thumbnails that reads
 * left→right like what was typed. Keyboard layout: smaller cards where the key
 * sits, softly pushed apart. Motion is exponential smoothing toward targets
 * (critically damped — no overshoot, no wobble). Cards are pre-rendered
 * sprites (see cards.ts); counted pictures, tap shapes, faces and matte
 * particles are drawn live. All collections are bounded.
 */
import type {
  CardSpec,
  EmojiSpec,
  NamedColor,
  PokeResult,
  Scene,
  SceneOptions,
  ShapeKind,
  ShapeSpec,
  SpecialEffect,
  World,
} from '../types';
import { TIMING } from '../types';
import { createBackdrop, type Backdrop } from './backgrounds';
import {
  cardKey,
  focusCardBox,
  KEYBOARD_CAP,
  keyboardCardSize,
  renderCard,
  renderEmoji,
  SHELF_MAX,
  shelfSlots,
  spriteCost,
  tenFrame,
  type CardSprite,
  type CardStyle,
} from './cards';
import { toRgba } from './color';
import { LruCache } from './lru';
import { MatteParticles, Paint, Rainbow, Ripples } from './matte';
import { drawFace, drawShape } from './shapes';

/** Smoothing rate (1/s): ~95% of the way in ~230 ms. */
const SMOOTH = 13;
const ENTER_SCALE = 0.92;
const ENTER_DY = 12;
const LEAVE_DY = 24;
const SHELF_LIFE = 20;
const KEYBOARD_LIFE = 6;
const LEAVING_MAX = 16;
const THINGS_MAX = 14;
const PULSE_TIME = 0.3;
const HOP_TIME = 0.3;
const GLIDE_TIME = 1.2;
const COUNT_POP = 0.18;
const CROSSFADE = 1.2;
const INTENSITY_MUL = { calm: 0.6, normal: 1, lively: 1.3 } as const;

type Place = 'centre' | 'shelf' | 'free' | 'leaving';

interface CardEnt {
  id: number;
  spec: CardSpec;
  place: Place;
  /** Card size at scale 1 (CSS px). */
  w: number;
  h: number;
  x: number;
  y: number;
  s: number;
  a: number;
  tx: number;
  ty: number;
  ts: number;
  ta: number;
  /** Seconds in the current place (shelf ageing, keyboard life, count reveal). */
  age: number;
  /** Seconds since the card was shown (frame time). */
  shown: number;
  /** Real-clock ms when the card first got a frame (count reveal follows speech timers, not frame rate). */
  bornAt: number;
  pulse: number;
  hop: number;
  glide: number;
  sprite: CardSprite | null;
  spriteKey: string;
  /** Render size + style version the cached key was computed for (avoids per-frame key strings). */
  keyW: number;
  keyH: number;
  keyVersion: number;
  /** Ten-frame cells for digit cards, cached per card size. */
  cells: Float32Array | null;
  cell: number;
  cellsW: number;
}

interface Thing {
  kind: 'shape' | 'emoji';
  shape: ShapeKind;
  emoji: string;
  color: NamedColor | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  age: number;
  life: number;
  pulse: number;
  blinkIn: number;
  blink: number;
  drift: boolean;
}

export class CanvasScene implements Scene {
  private world: World;
  private options: SceneOptions;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private calm = 0;
  private calmTarget = 0;
  private backdrop: Backdrop;
  private oldBackdrop: Backdrop | null = null;
  private fade = 1;
  private nextId = 1;
  /** Latest frame time (ms, performance.now origin). */
  private clock = 0;
  /** Space kept free at the top for the game prompt (CSS px). */
  private topInset = 0;
  /** Bumped whenever world / dpr / font / size change, so cached sprite keys refresh. */
  private styleVersion = 0;
  private centre: CardEnt | null = null;
  private readonly shelf: CardEnt[] = [];
  private readonly free: CardEnt[] = [];
  private readonly leaving: CardEnt[] = [];
  private readonly things: Thing[] = [];
  private readonly particles = new MatteParticles();
  private readonly ripples = new Ripples();
  private readonly paint = new Paint();
  private readonly rainbow = new Rainbow();
  private readonly sprites = new LruCache<string, CardSprite>(24, 64 * 1024 * 1024);
  private readonly emojis = new LruCache<string, HTMLCanvasElement>(64, 16 * 1024 * 1024);

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    world: World,
    options: SceneOptions,
  ) {
    this.world = world;
    this.options = { ...options };
    this.backdrop = createBackdrop(world, { reduceMotion: options.reduceMotion });
    this.particles.colors = world.palette.map((c) => c.hex);
  }

  get objectCount(): number {
    return (this.centre ? 1 : 0) + this.shelf.length + this.free.length + this.things.length;
  }

  setWorld(world: World): void {
    if (world === this.world) return;
    this.world = world;
    this.oldBackdrop = this.backdrop;
    this.backdrop = createBackdrop(world, { reduceMotion: this.options.reduceMotion });
    this.backdrop.resize(this.width, this.height, this.dpr);
    this.fade = this.options.reduceMotion ? 1 : 0;
    if (this.fade >= 1) this.oldBackdrop = null;
    this.particles.colors = world.palette.map((c) => c.hex);
    // Cards and shapes keep their colour *name* but take the new world's tones
    // (light worlds: pale cards + deep ink; dark worlds: deep cards + light ink).
    const retone = (color: NamedColor | null | undefined): NamedColor | null | undefined =>
      color ? (world.palette.find((p) => p.name === color.name) ?? color) : color;
    for (const c of [this.centre, ...this.shelf, ...this.free, ...this.leaving]) {
      if (c?.spec.color) c.spec = { ...c.spec, color: retone(c.spec.color) };
    }
    for (const t of this.things) t.color = retone(t.color) ?? null;
    this.invalidateSprites();
  }

  setOptions(options: SceneOptions): void {
    const prev = this.options;
    this.options = { ...options };
    if (prev.reduceMotion !== options.reduceMotion) {
      this.backdrop = createBackdrop(this.world, { reduceMotion: options.reduceMotion });
      this.backdrop.resize(this.width, this.height, this.dpr);
      this.oldBackdrop = null;
      this.fade = 1;
      if (options.reduceMotion) this.particles.clear();
    }
    if (prev.layout !== options.layout) this.clearCards();
    if (prev.size !== options.size || prev.fontFamily !== options.fontFamily || prev.layout !== options.layout) {
      this.invalidateSprites();
      this.resizeCards();
    }
  }

  setCalm(level: number): void {
    this.calmTarget = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
  }

  resize(width: number, height: number, dpr: number): void {
    const dprChanged = dpr !== this.dpr;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = Math.max(1, dpr);
    this.backdrop.resize(this.width, this.height, this.dpr);
    this.oldBackdrop?.resize(this.width, this.height, this.dpr);
    if (dprChanged) {
      this.emojis.clear();
    }
    this.invalidateSprites();
    this.resizeCards();
  }

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  showCard(spec: CardSpec): number {
    const id = this.nextId++;
    const focus = this.options.layout === 'focus';
    const size = focus
      ? focusCardBox(spec.kind, this.width, this.height, this.options.size, this.topInset)
      : keyboardCardSize(spec.kind, this.width, this.height, this.options.size);
    const ent: CardEnt = {
      id, spec, place: 'centre', w: size.w, h: size.h,
      x: 0, y: 0, s: ENTER_SCALE, a: 0, tx: 0, ty: 0, ts: 1, ta: 1,
      age: 0, shown: 0, bornAt: Number.NaN, pulse: 0, hop: 0, glide: spec.direction ? GLIDE_TIME : 0,
      sprite: null, spriteKey: '', keyW: 0, keyH: 0, keyVersion: -1, cells: null, cell: 0, cellsW: 0,
    };

    if (!focus) {
      ent.place = 'free';
      const at = spec.at ?? { x: this.width / 2, y: this.height / 2 };
      ent.tx = clampTo(at.x, ent.w / 2 + 8, this.width - ent.w / 2 - 8);
      ent.ty = clampTo(at.y, ent.h / 2 + 8, this.height - ent.h / 2 - 8);
      if (spec.emphasis === 'small') ent.ts = 0.8;
      this.free.push(ent);
      const cap = KEYBOARD_CAP[this.options.intensity];
      while (this.free.length > cap) this.retire(this.free.shift() as CardEnt);
    } else if (spec.emphasis === 'small') {
      ent.place = 'shelf';
      this.shelf.push(ent);
      this.trimShelf();
      this.layoutShelf();
    } else {
      if (this.centre) this.toShelf(this.centre);
      const box = focusCardBox(spec.kind, this.width, this.height, this.options.size, this.topInset);
      ent.tx = box.x;
      ent.ty = box.y;
      this.centre = ent;
    }

    // Start just below and slightly small, then settle (or appear in place when reducing motion).
    ent.x = ent.tx;
    ent.y = ent.ty + (this.options.reduceMotion ? 0 : ENTER_DY);
    ent.s = this.options.reduceMotion ? ent.ts : ent.ts * ENTER_SCALE;
    return id;
  }

  setTopInset(px: number): void {
    const inset = Number.isFinite(px) ? Math.max(0, Math.round(px)) : 0;
    if (inset === this.topInset) return;
    this.topInset = inset;
    // Move/scale the centre card into the new band without re-rendering its sprite.
    const c = this.centre;
    if (c && this.options.layout === 'focus') {
      const box = focusCardBox(c.spec.kind, this.width, this.height, this.options.size, this.topInset);
      c.tx = box.x;
      c.ty = box.y;
      c.ts = box.w / c.w;
    }
  }

  pulseCard(id: number): void {
    const ent = this.findCard(id);
    if (ent) ent.pulse = PULSE_TIME;
  }

  private findCard(id: number): CardEnt | null {
    if (this.centre?.id === id) return this.centre;
    return this.shelf.find((c) => c.id === id) ?? this.free.find((c) => c.id === id) ?? null;
  }

  private toShelf(ent: CardEnt): void {
    ent.place = 'shelf';
    ent.age = 0;
    ent.glide = 0;
    this.shelf.push(ent);
    this.trimShelf();
    this.layoutShelf();
  }

  private trimShelf(): void {
    while (this.shelf.length > SHELF_MAX) this.retire(this.shelf.shift() as CardEnt);
  }

  /** Recompute every shelf thumbnail's target slot (oldest left → newest right). */
  private layoutShelf(): void {
    const slots = shelfSlots(this.shelf.map((c) => c.w / c.h), this.width, this.height);
    for (let i = 0; i < this.shelf.length; i++) {
      const c = this.shelf[i];
      const slot = slots[i];
      c.tx = slot.x;
      c.ty = slot.y;
      c.ts = slot.h / c.h;
      if (this.options.reduceMotion) {
        c.x = c.tx;
        c.y = c.ty;
        c.s = c.ts;
      }
    }
  }

  /** Send a card off: fade and slide down, then drop it. */
  private retire(ent: CardEnt): void {
    if (ent.place === 'leaving') return;
    ent.place = 'leaving';
    ent.ta = 0;
    ent.ty = ent.y + LEAVE_DY;
    this.leaving.push(ent);
    while (this.leaving.length > LEAVING_MAX) this.leaving.shift();
  }

  private clearCards(): void {
    if (this.centre) this.retire(this.centre);
    this.centre = null;
    for (const c of this.shelf) this.retire(c);
    for (const c of this.free) this.retire(c);
    this.shelf.length = 0;
    this.free.length = 0;
  }

  /** Re-derive card sizes and targets after a resize / size change. */
  private resizeCards(): void {
    const focus = this.options.layout === 'focus';
    const all = [this.centre, ...this.shelf, ...this.free].filter((c): c is CardEnt => !!c);
    for (const c of all) {
      const size = focus
        ? focusCardBox(c.spec.kind, this.width, this.height, this.options.size, this.topInset)
        : keyboardCardSize(c.spec.kind, this.width, this.height, this.options.size);
      c.w = size.w;
      c.h = size.h;
    }
    if (this.centre) {
      const box = focusCardBox(this.centre.spec.kind, this.width, this.height, this.options.size, this.topInset);
      this.centre.tx = box.x;
      this.centre.ty = box.y;
      this.centre.ts = 1; // w/h were just recomputed for this band
    }
    for (const c of this.free) {
      c.tx = clampTo(c.tx, c.w / 2 + 8, this.width - c.w / 2 - 8);
      c.ty = clampTo(c.ty, c.h / 2 + 8, this.height - c.h / 2 - 8);
    }
    this.layoutShelf();
  }

  private invalidateSprites(): void {
    this.styleVersion++;
    this.sprites.clear();
    for (const c of [this.centre, ...this.shelf, ...this.free, ...this.leaving]) {
      if (c) {
        c.sprite = null;
        c.spriteKey = '';
      }
    }
  }

  /**
   * The card's sprite, rendered at the size it is actually shown: full size in
   * the centre, thumbnail size once settled on the shelf (a mashed key costs a
   * small render, not a full-resolution one with two shadow passes).
   */
  private spriteFor(c: CardEnt): CardSprite | null {
    let rw = c.w;
    let rh = c.h;
    if (c.place === 'shelf' && Math.abs(c.s - c.ts) < Math.max(0.04, c.ts * 0.25)) {
      // Bucket thumbnail heights to 8 px so repeated keys hit the cache.
      rh = Math.max(16, Math.round((c.h * c.ts) / 8) * 8);
      rw = rh * (c.w / c.h);
    } else if (c.place === 'leaving' && c.sprite) {
      return c.sprite; // fading out: keep whatever it has
    }
    if (c.sprite && c.keyW === rw && c.keyH === rh && c.keyVersion === this.styleVersion) return c.sprite;
    const style: CardStyle = { world: this.world, fontFamily: this.options.fontFamily, dpr: this.dpr };
    const key = cardKey(c.spec, rw, rh, style);
    let sprite = this.sprites.get(key) ?? null;
    if (!sprite) {
      sprite = renderCard(c.spec, rw, rh, style);
      if (sprite) this.sprites.set(key, sprite, spriteCost(sprite));
    }
    c.sprite = sprite;
    c.spriteKey = key;
    c.keyW = rw;
    c.keyH = rh;
    c.keyVersion = this.styleVersion;
    return sprite;
  }

  private emojiSprite(emoji: string, px: number): HTMLCanvasElement | null {
    const size = Math.max(8, Math.round(px / 4) * 4); // bucket sizes so the cache hits
    const key = `${emoji}|${size}|${this.dpr}`;
    let sprite = this.emojis.get(key) ?? null;
    if (!sprite) {
      sprite = renderEmoji(emoji, size, this.dpr);
      if (sprite) this.emojis.set(key, sprite, sprite.width * sprite.height * 4);
    }
    return sprite;
  }

  // -------------------------------------------------------------------------
  // Shapes, pictures, particles, painting
  // -------------------------------------------------------------------------

  spawnShape(spec: ShapeSpec): void {
    const base = Math.min(this.width, this.height) * 0.07 * (spec.scale ?? 1);
    this.addThing({
      kind: 'shape', shape: spec.shape, emoji: '', color: spec.color,
      x: spec.x, y: spec.y, vx: (Math.random() - 0.5) * 20, vy: 0, size: base,
      age: 0, life: 5, pulse: 0, blinkIn: 2 + Math.random() * 3, blink: 0, drift: false,
    });
  }

  spawnEmoji(spec: EmojiSpec): void {
    const base = Math.min(this.width, this.height) * 0.06 * (spec.scale ?? 1);
    // Idle friends that start off-screen drift across; tap pictures settle in place.
    const offscreen = spec.x < 0 || spec.x > this.width;
    this.addThing({
      kind: 'emoji', shape: 'circle', emoji: spec.emoji, color: null,
      x: spec.x, y: spec.y, vx: offscreen ? (spec.x < 0 ? 1 : -1) * (30 + Math.random() * 20) : 0, vy: 0,
      size: base, age: 0, life: offscreen ? 14 : 5, pulse: 0, blinkIn: 0, blink: 0, drift: offscreen,
    });
  }

  private addThing(t: Thing): void {
    this.things.push(t);
    while (this.things.length > THINGS_MAX) this.things.shift();
  }

  burst(x: number, y: number, color: NamedColor, power = 1): void {
    if (this.options.reduceMotion) return;
    const mul = INTENSITY_MUL[this.options.intensity] * (1 - 0.6 * this.calm);
    const n = Math.round((4 + 3 * Math.min(2, Math.max(0, power))) * mul);
    const ci = Math.max(0, this.world.palette.findIndex((c) => c.name === color.name));
    const style = this.world.particle;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4;
      const sp = 50 + Math.random() * 90;
      this.particles.spawn(style, x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.9 + Math.random() * 0.5, 3 + Math.random() * 3,
        i % 3 === 0 ? Math.floor(Math.random() * this.world.palette.length) : ci);
    }
  }

  ripple(x: number, y: number, color: NamedColor): void {
    this.ripples.add(x, y, color);
  }

  trail(x: number, y: number, color: NamedColor, pointerId: number): void {
    this.paint.add(x, y, color, pointerId);
  }

  endTrail(pointerId: number): void {
    this.paint.end(pointerId);
  }

  special(effect: SpecialEffect, options?: { at?: { x: number; y: number }; colors?: NamedColor[] }): void {
    switch (effect) {
      case 'rainbow':
        this.rainbow.start(options?.colors ?? this.world.palette.slice(0, 6), this.options.reduceMotion);
        break;
      case 'clear':
        this.clearCards();
        for (const t of this.things) t.life = Math.min(t.life, t.age + 0.3);
        this.paint.clear();
        break;
      case 'celebrate':
        this.celebrate();
        break;
    }
  }

  private celebrate(): void {
    if (this.centre) this.centre.hop = HOP_TIME;
    if (this.options.reduceMotion) return;
    const n = Math.round((18 + Math.random() * 12) * INTENSITY_MUL[this.options.intensity]);
    const rising = this.world.gravity < 0;
    for (let i = 0; i < n; i++) {
      const x = Math.random() * this.width;
      const y = rising ? this.height + 10 : -10 - Math.random() * 60;
      this.particles.spawn(this.world.particle, x, y, (Math.random() - 0.5) * 60, (rising ? -1 : 1) * (40 + Math.random() * 60),
        1.8 + Math.random() * 0.6, 4 + Math.random() * 3, Math.floor(Math.random() * this.world.palette.length));
    }
  }

  poke(x: number, y: number): PokeResult | null {
    const cards: CardEnt[] = [];
    if (this.centre) cards.push(this.centre);
    for (let i = this.free.length - 1; i >= 0; i--) cards.push(this.free[i]);
    for (let i = this.shelf.length - 1; i >= 0; i--) cards.push(this.shelf[i]);
    for (const c of cards) {
      if (Math.abs(x - c.x) <= (c.w * c.s) / 2 && Math.abs(y - c.y) <= (c.h * c.s) / 2) {
        c.pulse = PULSE_TIME;
        const spec = c.spec;
        const value = spec.text ?? spec.picture ?? spec.shape ?? spec.direction ?? spec.word ?? '';
        return { kind: spec.kind, cardId: c.id, value, color: spec.color ?? null };
      }
    }
    for (let i = this.things.length - 1; i >= 0; i--) {
      const t = this.things[i];
      if (Math.hypot(x - t.x, y - t.y) <= t.size * 1.1) {
        t.pulse = PULSE_TIME;
        t.life = Math.max(t.life, t.age + 2);
        return t.kind === 'shape'
          ? { kind: 'shape', cardId: null, value: t.shape, color: t.color }
          : { kind: 'emoji', cardId: null, value: t.emoji, color: null };
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, now: number): void {
    this.clock = now;
    this.calm += (this.calmTarget - this.calm) * (1 - Math.exp(-dt * 2));
    const slow = dt * (1 - 0.7 * this.calm);
    this.backdrop.update(dt, now, this.calm);
    if (this.oldBackdrop) {
      this.oldBackdrop.update(dt, now, this.calm);
      this.fade = Math.min(1, this.fade + dt / CROSSFADE);
      if (this.fade >= 1) this.oldBackdrop = null;
    }

    const k = 1 - Math.exp(-dt * SMOOTH);
    const reduce = this.options.reduceMotion;
    const step = (c: CardEnt): void => {
      c.age += dt;
      c.shown += dt;
      if (Number.isNaN(c.bornAt)) c.bornAt = now;
      if (reduce) {
        c.x = c.tx;
        c.y = c.ty;
        c.s = c.ts;
      } else {
        c.x += (c.tx - c.x) * k;
        c.y += (c.ty - c.y) * k;
        c.s += (c.ts - c.s) * k;
      }
      c.a += (c.ta - c.a) * Math.min(1, k * 1.2);
      if (c.pulse > 0) c.pulse = Math.max(0, c.pulse - dt);
      if (c.hop > 0) c.hop = Math.max(0, c.hop - dt);
      if (c.glide > 0) c.glide = Math.max(0, c.glide - slow);
    };

    if (this.centre) step(this.centre);
    for (const c of this.shelf) step(c);
    for (const c of this.free) step(c);
    for (const c of this.leaving) step(c);

    // Age out shelf thumbnails and keyboard cards; drop faded leavers.
    for (let i = this.shelf.length - 1; i >= 0; i--) {
      if (this.shelf[i].age > SHELF_LIFE) {
        this.retire(this.shelf[i]);
        this.shelf.splice(i, 1);
        this.layoutShelf();
      }
    }
    for (let i = this.free.length - 1; i >= 0; i--) {
      if (this.free[i].age > KEYBOARD_LIFE) {
        this.retire(this.free[i]);
        this.free.splice(i, 1);
      }
    }
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      if (this.leaving[i].a < 0.02) {
        this.leaving[i].sprite = null; // let the canvas be collected now
        this.leaving.splice(i, 1);
      }
    }
    if (!reduce) this.separate(dt);

    for (let i = this.things.length - 1; i >= 0; i--) {
      const t = this.things[i];
      t.age += slow;
      if (t.age >= t.life) {
        this.things.splice(i, 1);
        continue;
      }
      if (!reduce) {
        t.vy += this.world.gravity * 0.2 * slow;
        t.vx -= t.vx * (t.drift ? 0 : 1.5) * slow;
        t.vy -= t.vy * 1.2 * slow;
        t.x += t.vx * slow;
        t.y += (t.drift ? Math.sin(t.age * 1.3) * 8 : t.vy) * slow;
      }
      if (t.pulse > 0) t.pulse = Math.max(0, t.pulse - dt);
      if (t.kind === 'shape') {
        t.blinkIn -= dt;
        if (t.blinkIn <= 0) {
          t.blink = 0.14;
          t.blinkIn = 2 + Math.random() * 3;
        }
        if (t.blink > 0) t.blink = Math.max(0, t.blink - dt);
      }
    }

    this.particles.update(slow, this.world.gravity >= 0 ? 60 : -30);
    this.ripples.update(dt);
    this.paint.update(dt);
    this.rainbow.update(dt, now);
  }

  /** Keyboard layout: overlapping cards push apart softly. */
  private separate(dt: number): void {
    const list = this.free;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const ox = (a.w * a.ts + b.w * b.ts) / 2 + 8 - Math.abs(a.tx - b.tx);
        const oy = (a.h * a.ts + b.h * b.ts) / 2 + 8 - Math.abs(a.ty - b.ty);
        if (ox <= 0 || oy <= 0) continue;
        const push = Math.min(ox, oy) * Math.min(1, dt * 6);
        if (ox < oy) {
          const dir = a.tx < b.tx ? -1 : 1;
          a.tx += dir * push * 0.5;
          b.tx -= dir * push * 0.5;
        } else {
          const dir = a.ty < b.ty ? -1 : 1;
          a.ty += dir * push * 0.5;
          b.ty -= dir * push * 0.5;
        }
        a.tx = clampTo(a.tx, a.w / 2 + 8, this.width - a.w / 2 - 8);
        a.ty = clampTo(a.ty, a.h / 2 + 8, this.height - a.h / 2 - 8);
        b.tx = clampTo(b.tx, b.w / 2 + 8, this.width - b.w / 2 - 8);
        b.ty = clampTo(b.ty, b.h / 2 + 8, this.height - b.h / 2 - 8);
      }
    }
  }

  draw(): void {
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    if (this.oldBackdrop) {
      this.oldBackdrop.draw(ctx);
      ctx.globalAlpha = this.fade;
      this.backdrop.draw(ctx);
      ctx.globalAlpha = 1;
    } else {
      this.backdrop.draw(ctx);
    }

    this.rainbow.draw(ctx, this.width, this.height);
    this.paint.draw(ctx, Math.max(12, Math.min(22, Math.min(this.width, this.height) * 0.022)));
    for (const t of this.things) this.drawThing(t);
    for (const c of this.leaving) this.drawCard(c);
    for (const c of this.shelf) this.drawCard(c);
    for (const c of this.free) this.drawCard(c);
    if (this.centre) this.drawCard(this.centre);
    this.particles.draw(ctx, this.world.dark);
    this.ripples.draw(ctx, 1);

    if (this.calm > 0.01) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = toRgba(this.world.sky[1], 0.35 * this.calm);
      ctx.fillRect(0, 0, this.width, this.height);
    }
    ctx.globalAlpha = 1;
  }

  private drawCard(c: CardEnt): void {
    if (c.a < 0.01) return;
    const sprite = this.spriteFor(c);
    const ctx = this.ctx;
    let s = c.s;
    let x = c.x;
    let y = c.y;
    if (!this.options.reduceMotion) {
      if (c.pulse > 0) s *= 1 - 0.04 * Math.sin((1 - c.pulse / PULSE_TIME) * Math.PI);
      if (c.hop > 0) y -= 8 * Math.sin((1 - c.hop / HOP_TIME) * Math.PI);
      if (c.glide > 0 && c.spec.direction && c.place !== 'shelf') {
        const p = Math.sin((1 - c.glide / GLIDE_TIME) * Math.PI);
        const d = Math.min(this.width, this.height) * 0.06 * p;
        if (c.spec.direction === 'up') y -= d;
        else if (c.spec.direction === 'down') y += d;
        else if (c.spec.direction === 'left') x -= d;
        else x += d;
      }
    }
    ctx.globalAlpha = Math.min(1, Math.max(0, c.a));
    if (sprite) {
      // The sprite may be a thumbnail: scale it to the card's on-screen size.
      const k = (s * c.w) / sprite.w;
      const fw = (sprite.w + sprite.pad * 2) * k;
      const fh = (sprite.h + sprite.pad * 2) * k;
      ctx.drawImage(sprite.canvas, x - fw / 2, y - fh / 2, fw, fh);
    }
    const count = c.spec.kind === 'digit' ? Math.min(10, Math.max(0, c.spec.count ?? 0)) : 0;
    if (count > 0 && c.spec.picture) this.drawCount(c, x, y, s, count);
    ctx.globalAlpha = 1;
  }

  /** Counted pictures appear one per TIMING.countStepMs in the ten-frame. */
  private drawCount(c: CardEnt, x: number, y: number, s: number, count: number): void {
    const stepS = TIMING.countStepMs / 1000;
    const elapsed = Number.isNaN(c.bornAt) ? 0 : Math.max(0, (this.clock - c.bornAt) / 1000);
    const shown = Math.min(count, Math.floor(elapsed / stepS) + 1);
    if (!c.cells || c.cellsW !== c.w) {
      const frame = tenFrame(c.w, c.h);
      c.cells = frame.cells;
      c.cell = frame.cell;
      c.cellsW = c.w;
    }
    const cells = c.cells;
    const cell = c.cell;
    const sprite = this.emojiSprite(c.spec.picture as string, cell * 0.66);
    if (!sprite) return;
    const ctx = this.ctx;
    const base = (sprite.width / this.dpr) * s;
    for (let i = 0; i < shown; i++) {
      const since = elapsed - i * stepS;
      const pop = this.options.reduceMotion ? 1 : Math.min(1, since / COUNT_POP);
      const k = base * (0.6 + 0.4 * (1 - (1 - pop) * (1 - pop)));
      ctx.drawImage(sprite, x + cells[i * 2] * s - k / 2, y + cells[i * 2 + 1] * s - k / 2, k, k);
    }
  }

  private drawThing(t: Thing): void {
    const ctx = this.ctx;
    const enter = this.options.reduceMotion ? 1 : Math.min(1, t.age / 0.25);
    const out = t.life - t.age < 0.6 ? Math.max(0, (t.life - t.age) / 0.6) : 1;
    let scale = 0.85 + 0.15 * enter;
    if (t.pulse > 0 && !this.options.reduceMotion) scale *= 1 - 0.06 * Math.sin((1 - t.pulse / PULSE_TIME) * Math.PI);
    ctx.globalAlpha = enter * out;
    if (t.kind === 'shape' && t.color) {
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.scale(scale, scale);
      drawShape(ctx, t.shape, t.size, t.color, this.world.dark);
      if (this.options.faces) drawFace(ctx, t.shape, t.size, t.blink > 0 ? 1 : 0, t.pulse > 0 ? 'oh' : 'smile');
      ctx.restore();
    } else if (t.kind === 'emoji') {
      const sprite = this.emojiSprite(t.emoji, t.size * 1.6);
      if (sprite) {
        const k = (sprite.width / this.dpr) * scale;
        ctx.drawImage(sprite, t.x - k / 2, t.y - k / 2, k, k);
      }
    }
    ctx.globalAlpha = 1;
  }
}

function clampTo(v: number, min: number, max: number): number {
  return max < min ? (min + max) / 2 : Math.min(max, Math.max(min, v));
}
