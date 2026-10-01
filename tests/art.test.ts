/**
 * Smoke tests for the render art (backdrops + shapes).
 *
 * happy-dom has no canvas, so these run against a recording fake 2D context:
 * every method is a spy that logs its name and numeric arguments. The tests
 * check that every shape and backdrop draws without throwing, never feeds
 * NaN/Infinity to the canvas, keeps save/restore balanced, stays matte (no
 * radial gradients, no additive 'lighter' blending), honours globalAlpha,
 * lays out deterministically, freezes under reduced motion, honours `calm`,
 * and does bounded work per frame. They do not judge how anything looks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackdrop } from '../src/render/backgrounds';
import { drawArrow, drawFace, drawShape, traceArrow, traceShape } from '../src/render/shapes';
import type { BackgroundKind, DirectionName, NamedColor, ShapeKind, World } from '../src/types';

interface Recorder {
  ctx: CanvasRenderingContext2D;
  /** Method calls in order, with their numeric arguments (other arguments are skipped). */
  calls: Array<{ name: string; nums: number[]; alpha: number }>;
  /** Every composite operation that was set. */
  composites: string[];
  radialGradients: number;
  depth: number;
  minDepth: number;
  gradients: number;
  problems: string[];
}

function makeRecorder(): Recorder {
  const rec: Recorder = { ctx: null as unknown as CanvasRenderingContext2D, calls: [], composites: [], radialGradients: 0, depth: 0, minDepth: 0, gradients: 0, problems: [] };
  const props: Record<string, unknown> = {
    globalAlpha: 1,
    lineWidth: 1,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalCompositeOperation: 'source-over',
    lineCap: 'butt',
    lineJoin: 'miter',
    imageSmoothingEnabled: true,
  };
  const gradient = (): CanvasGradient => {
    rec.gradients++;
    return {
      addColorStop(offset: number, color: string) {
        if (!(offset >= 0 && offset <= 1)) rec.problems.push(`addColorStop offset ${offset}`);
        if (typeof color !== 'string' || color.includes('NaN')) rec.problems.push(`addColorStop color ${color}`);
      },
    };
  };
  const special: Record<string, (...args: unknown[]) => unknown> = {
    createLinearGradient: gradient,
    createRadialGradient: () => {
      rec.radialGradients++;
      return gradient();
    },
    createPattern: () => ({}),
    measureText: () => ({ width: 10 }),
    save: () => {
      rec.depth++;
    },
    restore: () => {
      rec.depth--;
      rec.minDepth = Math.min(rec.minDepth, rec.depth);
    },
  };
  rec.ctx = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in props) return props[prop];
      return (...args: unknown[]) => {
        const nums: number[] = [];
        for (const a of args) {
          if (typeof a !== 'number') continue;
          if (!Number.isFinite(a)) rec.problems.push(`${prop}(${String(a)})`);
          nums.push(a);
        }
        rec.calls.push({ name: prop, nums, alpha: props.globalAlpha as number });
        return special[prop]?.(...args);
      };
    },
    set(_target, prop, value) {
      if (typeof prop !== 'string') return false;
      if ((prop === 'globalAlpha' || prop === 'lineWidth') && !(typeof value === 'number' && Number.isFinite(value))) {
        rec.problems.push(`${prop} = ${String(value)}`);
      }
      if (prop === 'globalCompositeOperation') rec.composites.push(String(value));
      if (typeof value === 'string' && value.includes('NaN')) rec.problems.push(`${prop} = ${value}`);
      props[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return rec;
}

const names = (rec: Recorder) => rec.calls.map((c) => c.name);

// Offscreen canvases created by backdrops get their own recorders.
const offscreen: Recorder[] = [];
let originalGetContext: PropertyDescriptor | undefined;

beforeAll(() => {
  originalGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext');
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value() {
      const rec = makeRecorder();
      offscreen.push(rec);
      return rec.ctx;
    },
  });
});

afterAll(() => {
  if (originalGetContext) Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', originalGetContext);
  else Reflect.deleteProperty(HTMLCanvasElement.prototype, 'getContext');
});

const SHAPES: ShapeKind[] = ['circle', 'square', 'triangle', 'star', 'heart', 'diamond', 'moon', 'oval', 'hexagon', 'rectangle'];
const DIRECTIONS: DirectionName[] = ['up', 'down', 'left', 'right'];
const PALETTE: NamedColor[] = [
  { name: 'red', hex: '#E0604F', container: '#FCE4E0', ink: '#A3291C' },
  { name: 'yellow', hex: '#E9B730', container: '#FBF0CC', ink: '#7A5800' },
  { name: 'blue', hex: '#4A86D8', container: '#DFEAFB', ink: '#1D4F99' },
  { name: 'brown', hex: '#A07452', container: '#F1E6DC', ink: '#6A4527' },
];
const KINDS: Array<{ kind: BackgroundKind; sky: [string, string]; dark: boolean }> = [
  { kind: 'paper', sky: ['#F5F2EC', '#F0ECE4'], dark: false },
  { kind: 'meadow', sky: ['#DCEEF7', '#EEF6E8'], dark: false },
  { kind: 'ocean', sky: ['#D6E9F2', '#B9D6E6'], dark: false },
  { kind: 'space', sky: ['#141B2D', '#0F1424'], dark: true },
  { kind: 'jungle', sky: ['#E3EEDC', '#CFE2C6'], dark: false },
  { kind: 'snow', sky: ['#EAF2F8', '#F7FAFC'], dark: false },
  { kind: 'night', sky: ['#141B2D', '#0F1424'], dark: true },
];

function testWorld(background: BackgroundKind, sky: [string, string], dark: boolean): World {
  return {
    id: 'space',
    label: 'Test world',
    icon: '⭐',
    background,
    sky,
    dark,
    surface: dark ? '#1E2740' : '#FFFFFF',
    onSurface: dark ? '#EEF1F7' : '#1F2328',
    palette: PALETTE,
    particle: 'confetti',
    gravity: 0,
    energy: 1,
    timbre: 'felt',
    rootMidi: 60,
    friends: ['⭐'],
  };
}

function expectClean(rec: Recorder): void {
  expect(rec.problems).toEqual([]);
  expect(rec.depth).toBe(0);
  expect(rec.minDepth).toBe(0);
}

describe('shapes', () => {
  for (const shape of SHAPES) {
    for (const r of [20, 300]) {
      it(`traceShape(${shape}, ${r}) builds a path without painting`, () => {
        const rec = makeRecorder();
        traceShape(rec.ctx, shape, r);
        const called = names(rec);
        expect(called[0]).toBe('beginPath');
        expect(called.length).toBeGreaterThan(1);
        expect(called).not.toContain('fill');
        expect(called).not.toContain('stroke');
        expect(called).not.toContain('clip');
        expectClean(rec);
      });

      it(`drawShape + drawFace(${shape}, ${r}) paint cleanly`, () => {
        for (const dark of [false, true]) {
          for (const color of PALETTE) {
            const rec = makeRecorder();
            drawShape(rec.ctx, shape, r, color, dark);
            expect(names(rec)).toContain('fill');
            expect(names(rec)).toContain('stroke');
            expectClean(rec);
          }
        }
        for (const blink of [0, 0.5, 1, -2, 7]) {
          for (const mood of ['smile', 'oh'] as const) {
            const rec = makeRecorder();
            drawFace(rec.ctx, shape, r, blink, mood);
            // cheeks + eyes + mouth, each a fill or a stroke
            expect(names(rec).filter((n) => n === 'fill' || n === 'stroke').length).toBeGreaterThanOrEqual(3);
            expectClean(rec);
          }
        }
      });
    }
  }

  it('closed eyes are drawn as strokes, open eyes as fills', () => {
    const open = makeRecorder();
    drawFace(open.ctx, 'circle', 100, 0, 'oh');
    expect(names(open)).not.toContain('stroke');
    const closed = makeRecorder();
    drawFace(closed.ctx, 'circle', 100, 1, 'oh');
    expect(names(closed)).toContain('stroke');
  });

  it('ignores degenerate radii', () => {
    for (const r of [0, -5, Number.NaN]) {
      const rec = makeRecorder();
      traceShape(rec.ctx, 'star', r);
      drawShape(rec.ctx, 'star', r, PALETTE[0], true);
      drawFace(rec.ctx, 'star', r, 0, 'smile');
      expect(names(rec)).toEqual(['beginPath']);
    }
  });

  it('shapes are flat matte fills: no gradients, no additive blending', () => {
    const rec = makeRecorder();
    for (const shape of SHAPES) for (const dark of [false, true]) drawShape(rec.ctx, shape, 50, PALETTE[2], dark);
    expect(rec.gradients).toBe(0);
    expect(rec.radialGradients).toBe(0);
    expect(rec.composites).not.toContain('lighter');
    expect(names(rec)).not.toContain('createPattern');
  });

  it('the rim is a tonal variant of the fill (darker on light, lighter on dark)', () => {
    const fills: string[] = [];
    const strokes: string[] = [];
    for (const dark of [false, true]) {
      const rec = makeRecorder();
      drawShape(rec.ctx, 'circle', 50, PALETTE[2], dark);
      fills.push(String(rec.ctx.fillStyle));
      strokes.push(String(rec.ctx.strokeStyle));
    }
    expect(fills).toEqual([PALETTE[2].hex, PALETTE[2].hex]);
    expect(strokes[0]).not.toBe(PALETTE[2].hex);
    expect(strokes[1]).not.toBe(PALETTE[2].hex);
    expect(strokes[0]).not.toBe(strokes[1]);
  });
});

describe('arrows', () => {
  for (const direction of DIRECTIONS) {
    it(`drawArrow(${direction}) paints a clean, flat arrow`, () => {
      for (const r of [10, 120]) {
        for (const dark of [false, true]) {
          const rec = makeRecorder();
          drawArrow(rec.ctx, direction, r, PALETTE[0], dark);
          expect(names(rec)).toContain('fill');
          expect(names(rec)).toContain('stroke');
          expect(rec.gradients).toBe(0);
          expectClean(rec);
        }
      }
    });
  }

  it('points the tip in the requested direction', () => {
    // The tip is the extreme vertex along the direction: check the path extent.
    const extent = (direction: DirectionName) => {
      const rec = makeRecorder();
      traceArrow(rec.ctx, direction, 100);
      const xs: number[] = [];
      const ys: number[] = [];
      for (const c of rec.calls) {
        for (let i = 0; i + 1 < c.nums.length; i += 2) {
          if (c.name === 'arc' || c.name === 'arcTo' || c.name === 'moveTo' || c.name === 'lineTo' || c.name === 'quadraticCurveTo') {
            xs.push(c.nums[i]);
            ys.push(c.nums[i + 1]);
          }
        }
      }
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    };
    const r = extent('right');
    expect(r.maxX).toBeGreaterThan(-r.minX);
    const l = extent('left');
    expect(-l.minX).toBeGreaterThan(l.maxX);
    const u = extent('up');
    expect(-u.minY).toBeGreaterThan(u.maxY);
    const d = extent('down');
    expect(d.maxY).toBeGreaterThan(-d.minY);
  });

  it('ignores degenerate radii', () => {
    for (const r of [0, -1, Number.NaN]) {
      const rec = makeRecorder();
      drawArrow(rec.ctx, 'up', r, PALETTE[0], false);
      expect(names(rec)).toEqual([]);
    }
  });
});

describe('backdrops', () => {
  const frame = (backdrop: ReturnType<typeof createBackdrop>): Recorder => {
    const rec = makeRecorder();
    backdrop.draw(rec.ctx);
    return rec;
  };
  const drawImages = (rec: Recorder) => rec.calls.filter((c) => c.name === 'drawImage').map((c) => c.nums);

  for (const { kind, sky, dark } of KINDS) {
    const world = testWorld(kind, sky, dark);

    for (const reduceMotion of [false, true]) {
      it(`${kind}${reduceMotion ? ' (reduced motion)' : ''} creates, resizes, updates and draws`, () => {
        offscreen.length = 0;
        const backdrop = createBackdrop(world, { reduceMotion });
        expect(() => backdrop.draw(makeRecorder().ctx)).not.toThrow(); // before any resize
        backdrop.resize(1280, 800, 2);
        for (let i = 0; i < 120; i++) backdrop.update(1 / 60, i * 16, i < 60 ? 0 : 1);
        backdrop.update(0, 0, 5); // zero dt and out-of-range calm (the scene clamps calm; the stage never sends NaN)
        const rec = frame(backdrop);
        expect(names(rec)).toContain('drawImage'); // the pre-rendered static layer
        expectClean(rec);

        backdrop.resize(390, 844, 3);
        backdrop.update(0.5, 0, 0.5);
        expectClean(frame(backdrop));

        expect(offscreen.length).toBeGreaterThan(0);
        for (const layer of offscreen) expectClean(layer);
      });
    }

    it(`${kind} lays out deterministically and survives a resize round trip`, () => {
      const a = createBackdrop(world, { reduceMotion: false });
      const b = createBackdrop(world, { reduceMotion: false });
      a.resize(1280, 800, 1);
      b.resize(1280, 800, 1);
      a.update(2, 0, 0);
      b.update(2, 0, 0);
      const first = drawImages(frame(a));
      expect(drawImages(frame(b))).toEqual(first);
      a.resize(900, 700, 1);
      a.resize(1280, 800, 1);
      expect(drawImages(frame(a))).toEqual(first);
    });

    it(`${kind} freezes under reduced motion`, () => {
      const backdrop = createBackdrop(world, { reduceMotion: true });
      backdrop.resize(1024, 768, 1);
      const before = frame(backdrop).calls;
      for (let i = 0; i < 100; i++) backdrop.update(0.05, 0, 0);
      expect(frame(backdrop).calls).toEqual(before);
    });

    it(`${kind} slows motion with calm`, () => {
      const calm = createBackdrop(world, { reduceMotion: false });
      const normal = createBackdrop(world, { reduceMotion: false });
      calm.resize(1024, 768, 1);
      normal.resize(1024, 768, 1);
      for (let i = 0; i < 10; i++) calm.update(0.1, 0, 1); // 1 s at 30 % speed
      for (let i = 0; i < 3; i++) normal.update(0.1, 0, 0); // 0.3 s at full speed
      const x = drawImages(frame(calm)).flat();
      const y = drawImages(frame(normal)).flat();
      expect(x.length).toBe(y.length);
      x.forEach((v, i) => expect(v).toBeCloseTo(y[i], 3));
    });

    it(`${kind} does bounded work per frame over a long session`, () => {
      const backdrop = createBackdrop(world, { reduceMotion: false });
      backdrop.resize(2560, 1440, 1);
      const early = frame(backdrop).calls.length;
      for (let i = 0; i < 6000; i++) backdrop.update(0.1, 0, 0); // 10 minutes
      const late = frame(backdrop);
      expectClean(late);
      expect(late.calls.length).toBeLessThanOrEqual(early + 12); // e.g. a shooting star in flight
    });
  }

  it('falls back to a default backdrop for an unknown kind', () => {
    const world = testWorld('meadow', ['#fff', '#000'], false);
    const odd = { ...world, background: 'disco' as unknown as BackgroundKind };
    const backdrop = createBackdrop(odd, { reduceMotion: false });
    backdrop.resize(800, 600, 1);
    expectClean(frame(backdrop));
  });
});

describe('backdrops are matte and honour globalAlpha', () => {
  for (const { kind, sky, dark } of KINDS) {
    it(`${kind}: no radial gradients, no 'lighter', paints within the caller's alpha`, () => {
      offscreen.length = 0;
      const backdrop = createBackdrop(testWorld(kind, sky, dark), { reduceMotion: false });
      backdrop.resize(1280, 800, 1);
      for (let i = 0; i < 30; i++) backdrop.update(0.1, i * 100, 0);
      const rec = makeRecorder();
      rec.ctx.globalAlpha = 0.4;
      backdrop.draw(rec.ctx);
      expectClean(rec);
      const painting = rec.calls.filter((c) => ['fill', 'stroke', 'fillRect', 'drawImage', 'fillText'].includes(c.name));
      expect(painting.length).toBeGreaterThan(0);
      for (const c of painting) expect(c.alpha).toBeLessThanOrEqual(0.4 + 1e-9);
      // draw() leaves globalAlpha as it found it (cross-fades rely on this).
      expect(rec.ctx.globalAlpha).toBeCloseTo(0.4, 9);

      for (const r of [rec, ...offscreen]) {
        expect(r.radialGradients).toBe(0);
        expect(r.composites).not.toContain('lighter');
      }
    });

    it(`${kind}: alpha 0 paints nothing visible`, () => {
      const backdrop = createBackdrop(testWorld(kind, sky, dark), { reduceMotion: false });
      backdrop.resize(800, 600, 1);
      backdrop.update(1, 0, 0);
      const rec = makeRecorder();
      rec.ctx.globalAlpha = 0;
      backdrop.draw(rec.ctx);
      for (const c of rec.calls) expect(c.alpha).toBe(0);
    });
  }

  it('every BackgroundKind has its own backdrop (different static layers)', () => {
    offscreen.length = 0;
    const signatures = new Set<string>();
    for (const { kind, sky, dark } of KINDS) {
      const before = offscreen.length;
      const backdrop = createBackdrop(testWorld(kind, sky, dark), { reduceMotion: true });
      backdrop.resize(640, 480, 1);
      const layerCalls = offscreen.slice(before).flatMap((r) => r.calls.map((c) => c.name));
      signatures.add(layerCalls.join(','));
    }
    expect(signatures.size).toBe(KINDS.length);
  });
});
