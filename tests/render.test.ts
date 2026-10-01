import { describe, expect, it } from 'vitest';
import {
  approach,
  clamp,
  easeInCubic,
  easeInOutSine,
  easeOutBack,
  easeOutCubic,
  easeOutElastic,
  easeOutQuad,
  lerp,
} from '../src/render/easing';
import { contrastRatio, darken, lighten, mix, parseHex, relativeLuminance, toHex, toRgba } from '../src/render/color';
import { ColorTable, LruCache, sizeBucketIndex, sizeBucketPx } from '../src/render/sprites';
import { Emitter, ParticlePool, PS_SPARK, RenderEnv } from '../src/render/particles';
import { chooseDpr } from '../src/render/stage';

describe('easing', () => {
  const easings: Array<[string, (t: number) => number]> = [
    ['easeOutBack', (t) => easeOutBack(t)],
    ['easeOutBack(2.16)', (t) => easeOutBack(t, 2.16)],
    ['easeOutElastic', easeOutElastic],
    ['easeInOutSine', easeInOutSine],
    ['easeOutCubic', easeOutCubic],
    ['easeInCubic', easeInCubic],
    ['easeOutQuad', easeOutQuad],
  ];

  for (const [name, f] of easings) {
    it(`${name}: f(0) = 0 and f(1) = 1, clamped outside [0, 1]`, () => {
      expect(f(0)).toBeCloseTo(0, 10);
      expect(f(1)).toBeCloseTo(1, 10);
      expect(f(-3)).toBeCloseTo(0, 10);
      expect(f(7)).toBeCloseTo(1, 10);
    });
  }

  it('the spawn spring overshoots to ~1.15 and settles', () => {
    let peak = 0;
    for (let i = 0; i <= 1000; i++) peak = Math.max(peak, easeOutBack(i / 1000, 2.16));
    expect(peak).toBeGreaterThan(1.13);
    expect(peak).toBeLessThan(1.17);
  });

  it('easeInOutSine is symmetric around the midpoint', () => {
    expect(easeInOutSine(0.5)).toBeCloseTo(0.5, 10);
    expect(easeInOutSine(0.25) + easeInOutSine(0.75)).toBeCloseTo(1, 10);
  });

  it('clamp, lerp and approach', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.3, 0, 1)).toBe(0.3);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    expect(approach(0, 1, 0.3)).toBeCloseTo(0.3);
    expect(approach(0.9, 1, 0.3)).toBe(1);
    expect(approach(1, 0, 0.4)).toBeCloseTo(0.6);
  });
});

describe('color', () => {
  it('parses #rgb and #rrggbb (case-insensitive) and rejects junk', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('#FF8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(parseHex('0a0b0c')).toEqual({ r: 10, g: 11, b: 12 });
    expect(parseHex('#12')).toBeNull();
    expect(parseHex('red')).toBeNull();
    expect(parseHex('#ggg')).toBeNull();
  });

  it('formats hex and rgba', () => {
    expect(toHex({ r: 255, g: 128, b: 0 })).toBe('#ff8000');
    expect(toHex({ r: -4, g: 300, b: 15.6 })).toBe('#00ff10');
    expect(toRgba('#ff8000', 0.5)).toBe('rgba(255, 128, 0, 0.5)');
    expect(toRgba('#000', 2)).toBe('rgba(0, 0, 0, 1)');
  });

  it('mixes, lightens and darkens', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#ff0000', '#0000ff', 0)).toBe('#ff0000');
    expect(mix('#ff0000', '#0000ff', 1)).toBe('#0000ff');
    expect(lighten('#000000', 1)).toBe('#ffffff');
    expect(lighten('#336699', 0)).toBe('#336699');
    expect(darken('#ffffff', 1)).toBe('#000000');
    expect(darken('#ff8800', 0.5)).toBe('#804400');
  });

  it('computes WCAG luminance and contrast', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 6);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 6);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 6);
    expect(contrastRatio('#3366cc', '#3366cc')).toBeCloseTo(1, 6);
    // Known value: #777 on white is ~4.48:1.
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });
});

describe('ParticlePool', () => {
  it('never exceeds capacity and overwrites the oldest particles first', () => {
    const pool = new ParticlePool(100);
    for (let i = 0; i < 350; i++) {
      // Store the spawn serial in x so we can tell particles apart.
      pool.spawn(i, 0, 0, 0, 10, 4, PS_SPARK, 0);
      expect(pool.count).toBeLessThanOrEqual(100);
    }
    expect(pool.count).toBe(100);
    const alive: number[] = [];
    for (let i = 0; i < pool.capacity; i++) if (pool.isAlive(i)) alive.push(pool.x[i]);
    alive.sort((a, b) => a - b);
    // Only the 100 most recent survive: serials 250..349.
    expect(alive.length).toBe(100);
    expect(alive[0]).toBe(250);
    expect(alive[99]).toBe(349);
  });

  it('expires particles by age and reuses their slots', () => {
    const pool = new ParticlePool(8);
    pool.spawn(0, 0, 10, 0, 0.5, 4, PS_SPARK, 0);
    pool.spawn(0, 0, 10, 0, 2, 4, PS_SPARK, 0);
    expect(pool.count).toBe(2);
    pool.update(0.6);
    expect(pool.count).toBe(1);
    pool.update(2);
    expect(pool.count).toBe(0);
    for (let i = 0; i < 20; i++) pool.spawn(0, 0, 0, 0, 1, 4, PS_SPARK, 0);
    expect(pool.count).toBe(8);
    pool.clear();
    expect(pool.count).toBe(0);
  });

  it('integrates velocity, drag and gravity', () => {
    const pool = new ParticlePool(4);
    const i = pool.spawn(0, 0, 100, 0, 5, 4, PS_SPARK, 0);
    pool.ay[i] = 50;
    pool.update(0.1);
    expect(pool.x[i]).toBeCloseTo(10, 4);
    expect(pool.vy[i]).toBeCloseTo(5, 4);
    pool.drag[i] = 1;
    const before = pool.vx[i];
    pool.update(0.1);
    expect(pool.vx[i]).toBeLessThan(before);
  });

  it('burst counts follow intensity, calm and reduced motion', () => {
    const pool = new ParticlePool(16);
    const env = new RenderEnv();
    const emitter = new Emitter(pool, env, new ColorTable(8));
    expect(emitter.burstCount(1)).toBe(18);
    env.intensityMul = 1.6;
    expect(emitter.burstCount(1)).toBe(29);
    env.intensityMul = 1;
    env.calm = 1;
    expect(emitter.burstCount(1)).toBe(7);
    env.calm = 0;
    env.reduceMotion = true;
    expect(emitter.burstCount(1)).toBe(5);
    // A huge burst into a tiny pool stays bounded.
    env.reduceMotion = false;
    emitter.burst(0, 0, 0, 2);
    expect(pool.count).toBeLessThanOrEqual(16);
  });
});

describe('LruCache', () => {
  it('never exceeds its entry limit and evicts the least recently used', () => {
    const lru = new LruCache<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    expect(lru.get('a')).toBe(1); // a is now most recent
    lru.set('d', 4); // evicts b
    expect(lru.size).toBe(3);
    expect(lru.has('b')).toBe(false);
    expect(lru.keys()).toEqual(['c', 'a', 'd']);
    for (let i = 0; i < 500; i++) {
      lru.set(`k${i}`, i);
      expect(lru.size).toBeLessThanOrEqual(3);
    }
    expect(lru.keys()).toEqual(['k497', 'k498', 'k499']);
  });

  it('respects a cost budget but always keeps the newest entry', () => {
    const lru = new LruCache<string, string>(64, 100);
    lru.set('a', 'x', 40);
    lru.set('b', 'x', 40);
    expect(lru.cost).toBe(80);
    lru.set('c', 'x', 40); // 120 > 100: evict a
    expect(lru.has('a')).toBe(false);
    expect(lru.cost).toBe(80);
    lru.set('huge', 'x', 500);
    expect(lru.keys()).toEqual(['huge']);
    expect(lru.cost).toBe(500);
  });

  it('replacing and deleting keep the cost consistent', () => {
    const lru = new LruCache<string, number>(4, 1000);
    lru.set('a', 1, 10);
    lru.set('a', 2, 30);
    expect(lru.size).toBe(1);
    expect(lru.cost).toBe(30);
    expect(lru.delete('a')).toBe(true);
    expect(lru.cost).toBe(0);
    lru.set('b', 1, 5);
    lru.clear();
    expect(lru.size).toBe(0);
    expect(lru.cost).toBe(0);
  });
});

describe('ColorTable and size buckets', () => {
  it('gives stable ids and recycles slots when full', () => {
    const recycled: number[] = [];
    const table = new ColorTable(3);
    table.onRecycle = (id) => recycled.push(id);
    const a = table.id('#ff0000');
    expect(table.id('#ff0000')).toBe(a);
    table.id('#00ff00');
    table.id('#0000ff');
    expect(table.size).toBe(3);
    const d = table.id('#123456');
    expect(table.size).toBe(3);
    expect(recycled).toEqual([d]);
    expect(table.hex(d)).toBe('#123456');
  });

  it('never recycles pinned colours', () => {
    const table = new ColorTable(3);
    const white = table.id('#ffffff');
    table.pin(white);
    table.id('#000001');
    table.id('#000002');
    for (let i = 3; i < 40; i++) table.id(`#0000${i.toString(16).padStart(2, '0')}`);
    expect(table.size).toBe(3);
    expect(table.hex(white)).toBe('#ffffff');
    expect(table.id('#ffffff')).toBe(white);
  });

  it('size buckets stay within ±4% of the requested size', () => {
    for (let px = 12; px < 1200; px *= 1.013) {
      const b = sizeBucketPx(sizeBucketIndex(px));
      expect(Math.abs(b / px - 1)).toBeLessThan(0.04);
    }
  });
});

describe('stage dpr', () => {
  it('caps at 2 and drops for very large viewports', () => {
    expect(chooseDpr(1440, 900, 2)).toBe(2);
    expect(chooseDpr(1440, 900, 3)).toBe(2);
    expect(chooseDpr(1280, 800, 1.25)).toBe(1.25);
    expect(chooseDpr(2560, 1440, 2)).toBe(1.5);
    expect(chooseDpr(3440, 1440, 2)).toBe(1);
    expect(chooseDpr(800, 600, 0)).toBe(1);
  });
});
