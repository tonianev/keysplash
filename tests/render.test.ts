import { describe, expect, it } from 'vitest';
import { MatteParticles, Paint, Rainbow, Ripples } from '../src/render/matte';
import { TIMING } from '../src/types';
import type { NamedColor } from '../src/types';
import {
  approach,
  clamp01,
  smoothstep,
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
import { LruCache } from '../src/render/lru';
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

describe('easing extras', () => {
  it('clamp01 and smoothstep', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.4)).toBe(0.4);
    expect(smoothstep(0, 10, -5)).toBe(0);
    expect(smoothstep(0, 10, 15)).toBe(1);
    expect(smoothstep(0, 10, 5)).toBeCloseTo(0.5, 10);
    expect(smoothstep(0, 10, 2)).toBeLessThan(0.2);
  });

  it('approach never overshoots for any step size', () => {
    for (const step of [0.01, 0.5, 3, 100]) {
      expect(approach(0, 1, step)).toBeLessThanOrEqual(1);
      expect(approach(1, 0, step)).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Recording fake 2D context (happy-dom has no canvas)
// ---------------------------------------------------------------------------

interface Rec {
  ctx: CanvasRenderingContext2D;
  calls: Array<{ name: string; args: unknown[]; alpha: number; stroke: unknown; fill: unknown }>;
  composites: string[];
  problems: string[];
}

function recorder(): Rec {
  const rec: Rec = { ctx: null as unknown as CanvasRenderingContext2D, calls: [], composites: [], problems: [] };
  const props: Record<string, unknown> = { globalAlpha: 1, lineWidth: 1, fillStyle: '#000', strokeStyle: '#000', globalCompositeOperation: 'source-over' };
  rec.ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in props) return props[prop];
      return (...args: unknown[]) => {
        for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) rec.problems.push(`${prop}(${a})`);
        rec.calls.push({ name: prop, args, alpha: props.globalAlpha as number, stroke: props.strokeStyle, fill: props.fillStyle });
        if (prop === 'createRadialGradient') rec.problems.push('createRadialGradient');
        return undefined;
      };
    },
    set(_t, prop, value) {
      if (typeof prop !== 'string') return false;
      if (prop === 'globalCompositeOperation') rec.composites.push(String(value));
      if (prop === 'globalAlpha' && !(typeof value === 'number' && Number.isFinite(value))) rec.problems.push(`globalAlpha=${value}`);
      props[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return rec;
}

const count = (rec: Rec, name: string) => rec.calls.filter((c) => c.name === name).length;

const RED: NamedColor = { name: 'red', hex: '#E0604F', container: '#FCE4E0', ink: '#A3291C' };
const BLUE: NamedColor = { name: 'blue', hex: '#4A86D8', container: '#DFEAFB', ink: '#1D4F99' };
const GREEN: NamedColor = { name: 'green', hex: '#4FA66A', container: '#DDF1E2', ink: '#1F6B37' };

describe('MatteParticles', () => {
  it('never exceeds capacity and overwrites the oldest first', () => {
    const p = new MatteParticles(8);
    for (let i = 0; i < 8; i++) p.spawn('dots', i, 0, 0, 0, 10, 4, 0);
    expect(p.count).toBe(8);
    for (let i = 0; i < 50; i++) {
      p.spawn('confetti', 100 + i, 0, 0, 0, 10, 4, 0);
      expect(p.count).toBeLessThanOrEqual(8);
    }
    expect(p.count).toBe(8);
    // The 8 newest survive: x = 142…149.
    const xs = Array.from(p.x).sort((a, b) => a - b);
    expect(xs).toEqual([142, 143, 144, 145, 146, 147, 148, 149]);
  });

  it('expires by age, frees slots and clears', () => {
    const p = new MatteParticles(4);
    p.spawn('dots', 0, 0, 0, 0, 0.5, 4, 0);
    p.spawn('dots', 0, 0, 0, 0, 2, 4, 0);
    p.update(0.6, 0);
    expect(p.count).toBe(1);
    p.update(2, 0);
    expect(p.count).toBe(0);
    p.spawn('snow', 0, 0, 0, 0, 2, 4, 0);
    p.clear();
    expect(p.count).toBe(0);
    const rec = recorder();
    p.draw(rec.ctx, false);
    expect(rec.calls).toHaveLength(0);
  });

  it('gravity pulls down, negative gravity floats up, drag slows', () => {
    const p = new MatteParticles(2);
    p.spawn('dots', 0, 0, 100, 0, 10, 4, 0);
    p.spawn('bubbles', 0, 0, 0, 0, 10, 4, 0);
    for (let i = 0; i < 30; i++) p.update(1 / 30, 50);
    expect(p.y[0]).toBeGreaterThan(0);
    expect(p.vx[0]).toBeLessThan(100);
    expect(p.vx[0]).toBeGreaterThan(0);
    const q = new MatteParticles(1);
    q.spawn('bubbles', 0, 0, 0, 0, 10, 4, 0);
    q.update(0.5, -40);
    expect(q.y[0]).toBeLessThan(0);
  });

  it('draws every style flat, fading out, without additive blending', () => {
    const p = new MatteParticles(16);
    p.colors = [RED.hex, BLUE.hex];
    const styles = ['confetti', 'dots', 'petals', 'bubbles', 'leaves', 'snow', 'stars'] as const;
    styles.forEach((s, i) => p.spawn(s, i * 10, 0, 5, 5, 1, 6, i));
    p.update(0.9, 10); // 90 % through: fading
    const rec = recorder();
    rec.ctx.globalAlpha = 0.5;
    p.draw(rec.ctx, true);
    expect(rec.problems).toEqual([]);
    expect(rec.composites).not.toContain('lighter');
    expect(count(rec, 'save')).toBe(count(rec, 'restore'));
    const paints = rec.calls.filter((c) => c.name === 'fill' || c.name === 'stroke' || c.name === 'fillRect');
    expect(paints.length).toBe(styles.length);
    for (const c of paints) expect(c.alpha).toBeLessThan(0.5 * 0.5);
    expect(rec.ctx.globalAlpha).toBe(0.5);
    // Colour indices wrap into the palette.
    for (const c of paints) expect([RED.hex, BLUE.hex, '#E6ECF5']).toContain(c.name === 'stroke' ? c.stroke : c.fill);
  });
});

describe('Ripples', () => {
  it('keeps at most 10 rings, fades them out and restores alpha', () => {
    const r = new Ripples();
    for (let i = 0; i < 50; i++) r.add(i, i, RED);
    const rec = recorder();
    r.draw(rec.ctx, 1);
    expect(count(rec, 'stroke')).toBe(10);
    for (const c of rec.calls.filter((k) => k.name === 'stroke')) expect(c.alpha).toBeLessThanOrEqual(0.4);
    expect(rec.ctx.globalAlpha).toBe(1);
    r.update(0.6);
    const after = recorder();
    r.draw(after.ctx, 1);
    expect(count(after, 'stroke')).toBe(0);
  });

  it('rings expand over their life', () => {
    const r = new Ripples();
    r.add(0, 0, BLUE);
    const radius = () => {
      const rec = recorder();
      r.draw(rec.ctx, 1);
      return rec.calls.find((c) => c.name === 'arc')?.args[2] as number;
    };
    const a = radius();
    r.update(0.2);
    expect(radius()).toBeGreaterThan(a);
  });
});

describe('Paint', () => {
  const strokes = (paint: Paint): Rec['calls'] => {
    const rec = recorder();
    paint.draw(rec.ctx, 20);
    expect(rec.problems).toEqual([]);
    return rec.calls.filter((c) => c.name === 'stroke' || c.name === 'fill');
  };

  it('one pointer drawing in one colour is one stroke', () => {
    const paint = new Paint();
    for (let i = 0; i < 20; i++) paint.add(i * 5, 0, RED, 1);
    const s = strokes(paint);
    expect(s).toHaveLength(1);
    expect(s[0].stroke).toBe(RED.hex);
  });

  it('a single point paints a dot', () => {
    const paint = new Paint();
    paint.add(10, 10, BLUE, 3);
    const s = strokes(paint);
    expect(s.map((c) => c.name)).toEqual(['fill']);
  });

  it('a new colour on the same pointer starts a new stroke', () => {
    const paint = new Paint();
    paint.add(0, 0, RED, 1);
    paint.add(5, 0, RED, 1);
    paint.add(10, 0, BLUE, 1);
    paint.add(15, 0, BLUE, 1);
    const s = strokes(paint);
    expect(s).toHaveLength(2);
    expect(s.map((c) => c.stroke)).toEqual([RED.hex, BLUE.hex]);
  });

  it('different pointers draw separate strokes', () => {
    const paint = new Paint();
    for (let i = 0; i < 3; i++) {
      paint.add(i, 0, RED, 1);
      paint.add(i, 50, RED, 2);
    }
    expect(strokes(paint)).toHaveLength(2);
  });

  it('a stroke ends after ~0.5 s idle, then fades out and disappears', () => {
    const paint = new Paint();
    paint.add(0, 0, RED, 1);
    paint.add(5, 0, RED, 1);
    paint.update(0.6); // idle: the stroke has ended
    paint.add(10, 0, RED, 1); // same pointer, same colour → new stroke
    paint.add(15, 0, RED, 1);
    paint.update(0.3);
    const s = strokes(paint);
    expect(s).toHaveLength(2);
    expect(s[0].alpha).toBeLessThan(s[1].alpha); // the ended one is fading
    paint.update(0.6); // the second stroke goes idle too
    paint.update(3.2);
    expect(strokes(paint)).toHaveLength(0);
  });

  it('end() finishes only that pointer and the stroke fades', () => {
    const paint = new Paint();
    paint.add(0, 0, RED, 1);
    paint.add(0, 0, BLUE, 2);
    paint.end(1);
    paint.update(0.3);
    const s = strokes(paint);
    const red = s.find((c) => c.fill === RED.hex);
    const blue = s.find((c) => c.fill === BLUE.hex);
    expect(red!.alpha).toBeLessThan(blue!.alpha);
  });

  it('never holds more than 10 strokes, and points per stroke are bounded', () => {
    const paint = new Paint();
    const colors = [RED, BLUE, GREEN];
    for (let i = 0; i < 200; i++) {
      for (let k = 0; k < 5; k++) paint.add(i, k, colors[i % 3], i % 17);
      expect(strokes(paint).length).toBeLessThanOrEqual(10);
    }
    const long = new Paint();
    for (let i = 0; i < 5000; i++) long.add(i, i, RED, 1);
    const rec = recorder();
    long.draw(rec.ctx, 10);
    expect(count(rec, 'quadraticCurveTo')).toBeLessThan(200);
    // The ring keeps the newest points: the stroke ends at the last one.
    const last = rec.calls.filter((c) => c.name === 'lineTo').pop()!;
    expect(last.args).toEqual([4999, 4999]);
  });

  it('clear() removes every stroke and draw restores alpha', () => {
    const paint = new Paint();
    paint.add(0, 0, RED, 1);
    paint.add(1, 1, RED, 1);
    const rec = recorder();
    rec.ctx.globalAlpha = 0.7;
    paint.draw(rec.ctx, 10);
    expect(rec.ctx.globalAlpha).toBe(0.7);
    expect(rec.composites).not.toContain('lighter');
    paint.clear();
    expect(strokes(paint)).toHaveLength(0);
  });
});

describe('Rainbow', () => {
  const SIX: NamedColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'].map((name, i) => ({
    name: name as NamedColor['name'],
    hex: `#${(i + 1).toString(16).repeat(6)}`,
    container: '#ffffff',
    ink: '#000000',
  }));
  const bands = (r: Rainbow): string[] => {
    const rec = recorder();
    r.draw(rec.ctx, 1280, 800);
    expect(rec.problems).toEqual([]);
    expect(rec.composites).not.toContain('lighter');
    return rec.calls.filter((c) => c.name === 'stroke').map((c) => c.stroke as string);
  };

  it('duration covers one band per TIMING.rainbowBandMs plus sweep, hold and fade', () => {
    const r = new Rainbow();
    r.start(SIX, false);
    const step = TIMING.rainbowBandMs / 1000;
    expect(r.duration()).toBeGreaterThan(5 * step);
    expect(r.duration()).toBeLessThan(5 * step + 4);
    const six = r.duration();
    r.start(SIX.slice(0, 2), false);
    expect(r.duration()).toBeCloseTo(six - 4 * step, 6); // fewer colours → shorter by whole steps
  });

  it('paints bands in order, one per step, then finishes', () => {
    const r = new Rainbow();
    expect(r.painting).toBe(false);
    r.start(SIX, false);
    expect(r.painting).toBe(true);
    expect(bands(r)).toEqual([]);
    const step = TIMING.rainbowBandMs / 1000;
    r.update(0.01);
    expect(bands(r)).toEqual([SIX[0].hex]);
    r.update(step);
    expect(bands(r)).toEqual([SIX[0].hex, SIX[1].hex]);
    r.update(step * 4);
    expect(bands(r)).toEqual(SIX.map((c) => c.hex));
    r.update(r.duration());
    expect(r.painting).toBe(false);
    expect(bands(r)).toEqual([]);
  });

  it('follows the real clock when nowMs is given (low frame rates stay in step)', () => {
    const r = new Rainbow();
    r.start(SIX, false);
    r.update(0.016, 10_000);
    expect(bands(r)).toEqual([]);
    r.update(0.016, 10_000 + TIMING.rainbowBandMs * 2 + 10); // one long frame
    expect(bands(r)).toHaveLength(3);
    r.update(0.016, 10_000 + r.duration() * 1000 + 1);
    expect(r.painting).toBe(false);
  });

  it('is inert with no colours and caps the band count', () => {
    const r = new Rainbow();
    r.start([], false);
    expect(r.painting).toBe(false);
    const many = Array.from({ length: 20 }, (_, i) => SIX[i % 6]);
    r.start(many, true);
    r.update(r.duration() - 1); // every band painted, before the fade ends
    expect(bands(r)).toHaveLength(8);
  });

  it('reduced motion fades bands in instead of sweeping', () => {
    const r = new Rainbow();
    r.start(SIX, true);
    r.update(0.1);
    const rec = recorder();
    r.draw(rec.ctx, 1280, 800);
    const arc = rec.calls.find((c) => c.name === 'arc')!;
    expect(arc.args[4]).toBeCloseTo(2 * Math.PI); // full half-circle immediately
    const stroke = rec.calls.find((c) => c.name === 'stroke')!;
    expect(stroke.alpha).toBeLessThan(0.85);
  });
});

describe('chooseDpr bounds', () => {
  it('stays within [1, 2] for any viewport and junk ratios', () => {
    for (const [w, h] of [[320, 480], [375, 667], [1920, 1080], [2560, 1440], [5120, 2880], [7680, 4320]]) {
      for (const r of [0, -1, Number.NaN, Infinity, 1, 1.5, 2, 3, 4]) {
        const d = chooseDpr(w, h, r);
        expect(d).toBeGreaterThanOrEqual(1);
        expect(d).toBeLessThanOrEqual(2);
      }
    }
    expect(chooseDpr(375, 667, 3)).toBe(2); // phones get the 2× cap
    expect(chooseDpr(5120, 2880, 2)).toBe(1); // 5K falls back to 1×
  });
});
