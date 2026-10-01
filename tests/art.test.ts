/**
 * Smoke tests for the render art (backdrops + shapes).
 *
 * happy-dom has no canvas, so these run against a recording fake 2D context:
 * every method is a spy that logs its name and numeric arguments. The tests
 * check that every shape and backdrop draws without throwing, never feeds
 * NaN/Infinity to the canvas, keeps save/restore balanced, caches gradients,
 * lays out deterministically, freezes under reduced motion, honours `calm`,
 * and does bounded work per frame. They do not judge how anything looks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackdrop } from '../src/render/backgrounds';
import { drawFace, drawShape, traceShape } from '../src/render/shapes';
import type { BackgroundKind, NamedColor, ShapeKind, World } from '../src/types';

interface Recorder {
  ctx: CanvasRenderingContext2D;
  /** Method calls in order, with their numeric arguments (other arguments are skipped). */
  calls: Array<{ name: string; nums: number[] }>;
  depth: number;
  minDepth: number;
  gradients: number;
  problems: string[];
}

function makeRecorder(): Recorder {
  const rec: Recorder = { ctx: null as unknown as CanvasRenderingContext2D, calls: [], depth: 0, minDepth: 0, gradients: 0, problems: [] };
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
    createRadialGradient: gradient,
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
        rec.calls.push({ name: prop, nums });
        return special[prop]?.(...args);
      };
    },
    set(_target, prop, value) {
      if (typeof prop !== 'string') return false;
      if ((prop === 'globalAlpha' || prop === 'lineWidth') && !(typeof value === 'number' && Number.isFinite(value))) {
        rec.problems.push(`${prop} = ${String(value)}`);
      }
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

const SHAPES: ShapeKind[] = ['circle', 'square', 'triangle', 'star', 'heart', 'diamond', 'moon', 'flower', 'hexagon', 'cloud'];
const PALETTE: NamedColor[] = [
  { name: 'red', hex: '#ff5c6c' },
  { name: 'yellow', hex: '#ffe14d' },
  { name: 'blue', hex: '#5cc8ff' },
  { name: 'white', hex: '#fff' },
];
const KINDS: Array<{ kind: BackgroundKind; sky: [string, string]; dark: boolean }> = [
  { kind: 'starfield', sky: ['#0b1026', '#2b1d62'], dark: true },
  { kind: 'underwater', sky: ['#0a4d66', '#03263a'], dark: true },
  { kind: 'meadow', sky: ['#b9e3ff', '#e6f8d4'], dark: false },
  { kind: 'party', sky: ['#2a0b3d', '#5e1252'], dark: true },
  { kind: 'bubbles', sky: ['#e8dcff', '#cdeeff'], dark: false },
  { kind: 'jungle', sky: ['#17522e', '#082a17'], dark: true },
  { kind: 'night', sky: ['#0a0f2e', '#1d2557'], dark: true },
];

function testWorld(background: BackgroundKind, sky: [string, string], dark: boolean): World {
  return {
    id: 'space',
    label: 'Test world',
    icon: '⭐',
    background,
    sky,
    dark,
    palette: PALETTE,
    particle: 'spark',
    gravity: 0,
    energy: 1,
    timbre: 'bell',
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
        for (const blink of [0, 0.5, 1, Number.NaN]) {
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

  it('caches gradients per context and colour (no per-frame gradient allocation)', () => {
    const rec = makeRecorder();
    drawShape(rec.ctx, 'flower', 50, PALETTE[0], false);
    const first = rec.gradients;
    expect(first).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) drawShape(rec.ctx, 'flower', 20 + i, PALETTE[0], false);
    expect(rec.gradients).toBe(first);
    drawShape(rec.ctx, 'flower', 50, PALETTE[0], true); // dark variant is a separate paint
    expect(rec.gradients).toBeGreaterThan(first);
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
        backdrop.update(Number.NaN, 0, Number.NaN);
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
