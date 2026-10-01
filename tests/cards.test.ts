/**
 * Flashcard layout (src/render/cards.ts) — pure geometry, DESIGN.md §3.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KEYBOARD_CAP,
  SHELF_MAX,
  cardAspect,
  cardKey,
  centreBand,
  focusCardBox,
  renderCard,
  spriteCost,
  keyboardCardSize,
  shelfHeight,
  shelfSlots,
  tenFrame,
} from '../src/render/cards';
import type { Box, CardStyle } from '../src/render/cards';
import type { CardKind, CardSpec, NamedColor, SizeLevel, World } from '../src/types';

const VIEWPORTS: Array<[number, number]> = [
  [375, 667], // phone portrait
  [667, 375], // phone landscape
  [768, 1024], // tablet portrait
  [1024, 768],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
  [2560, 1440],
];
const SIZES: SizeLevel[] = ['normal', 'big', 'huge'];
const KINDS: CardKind[] = ['letter', 'digit', 'shape', 'picture', 'direction'];

const EPS = 1e-6;
const left = (b: Box) => b.x - b.w / 2;
const right = (b: Box) => b.x + b.w / 2;
const top = (b: Box) => b.y - b.h / 2;
const bottom = (b: Box) => b.y + b.h / 2;

describe('focusCardBox', () => {
  for (const [w, h] of VIEWPORTS) {
    it(`fits inside the centre band and the viewport at ${w}×${h}`, () => {
      const band = centreBand(h);
      for (const kind of KINDS) {
        for (const size of SIZES) {
          const box = focusCardBox(kind, w, h, size);
          expect(top(box)).toBeGreaterThanOrEqual(band.top - EPS);
          expect(bottom(box)).toBeLessThanOrEqual(band.bottom + EPS);
          expect(left(box)).toBeGreaterThanOrEqual(-EPS);
          expect(right(box)).toBeLessThanOrEqual(w + EPS);
          expect(box.x).toBeCloseTo(w / 2, 6);
          expect(box.w / box.h).toBeCloseTo(cardAspect(kind), 6);
        }
      }
    });
  }

  it('the band sits below the prompt bar and above the shelf', () => {
    for (const [, h] of VIEWPORTS) {
      const band = centreBand(h);
      expect(band.top).toBeGreaterThan(0);
      expect(band.bottom).toBeLessThan(h);
      // The shelf row lives entirely below the band.
      const [slot] = shelfSlots([4 / 3], 1000, h);
      expect(top(slot)).toBeGreaterThanOrEqual(band.bottom - EPS);
    }
  });

  it('size factor orders normal < big < huge', () => {
    for (const [w, h] of VIEWPORTS) {
      const [n, b, u] = SIZES.map((s) => focusCardBox('letter', w, h, s).w);
      expect(n).toBeLessThan(b);
      expect(b).toBeLessThan(u);
    }
  });

  it('digit cards are wider (16:9) than letter cards (4:3)', () => {
    expect(cardAspect('digit')).toBeCloseTo(16 / 9);
    for (const k of ['letter', 'shape', 'picture', 'direction'] as CardKind[]) expect(cardAspect(k)).toBeCloseTo(4 / 3);
    for (const [w, h] of VIEWPORTS) {
      const d = focusCardBox('digit', w, h, 'normal');
      const l = focusCardBox('letter', w, h, 'normal');
      expect(d.w).toBeGreaterThan(l.w);
      expect(d.w / d.h).toBeGreaterThan(l.w / l.h);
    }
  });

  it('cards are big on a phone (legible) and never exceed ~2/3 of a wide screen', () => {
    const phone = focusCardBox('letter', 375, 667, 'normal');
    expect(phone.w).toBeGreaterThan(375 * 0.45);
    const wide = focusCardBox('letter', 2560, 1440, 'huge');
    expect(wide.w).toBeLessThanOrEqual(2560 * 0.66 + EPS);
  });

  it('keyboard-layout cards are ~45% of the focus card', () => {
    for (const kind of KINDS) {
      const f = focusCardBox(kind, 1280, 800, 'big');
      const k = keyboardCardSize(kind, 1280, 800, 'big');
      expect(k.w).toBeCloseTo(f.w * 0.45, 6);
      expect(k.h).toBeCloseTo(f.h * 0.45, 6);
    }
  });

  it('caps match DESIGN.md (calm 6 / normal 10 / lively 16, shelf 6)', () => {
    expect(KEYBOARD_CAP).toEqual({ calm: 6, normal: 10, lively: 16 });
    expect(SHELF_MAX).toBe(6);
  });
});

describe('shelfSlots', () => {
  const mixed = (n: number) => Array.from({ length: n }, (_, i) => (i % 3 === 1 ? 16 / 9 : 4 / 3));

  it('is empty for no cards', () => {
    expect(shelfSlots([], 1280, 800)).toEqual([]);
  });

  for (const [w, h] of VIEWPORTS) {
    it(`slots never overlap and stay inside the viewport at ${w}×${h}`, () => {
      for (let n = 1; n <= 12; n++) {
        const slots = shelfSlots(mixed(n), w, h);
        expect(slots).toHaveLength(n);
        for (let i = 0; i < n; i++) {
          const s = slots[i];
          expect(left(s)).toBeGreaterThanOrEqual(-EPS);
          expect(right(s)).toBeLessThanOrEqual(w + EPS);
          expect(top(s)).toBeGreaterThanOrEqual(-EPS);
          expect(bottom(s)).toBeLessThanOrEqual(h + EPS);
          if (i > 0) expect(left(s)).toBeGreaterThan(right(slots[i - 1]) - EPS); // oldest left → newest right
        }
        // Centred row.
        expect(left(slots[0]) + right(slots[n - 1])).toBeCloseTo(w, 4);
      }
    });
  }

  it('keeps each thumbnail’s aspect and a shared baseline', () => {
    const aspects = [4 / 3, 16 / 9, 4 / 3];
    const slots = shelfSlots(aspects, 1280, 800);
    slots.forEach((s, i) => {
      expect(s.w / s.h).toBeCloseTo(aspects[i], 6);
      expect(s.y).toBeCloseTo(slots[0].y, 6);
    });
    expect(slots[0].h).toBeCloseTo(shelfHeight(800), 6);
  });

  it('shrinks thumbnails when many cards would not fit', () => {
    const few = shelfSlots(mixed(3), 375, 667);
    const many = shelfSlots(mixed(12), 375, 667);
    expect(many[0].h).toBeLessThan(few[0].h);
    expect(right(many[11]) - left(many[0])).toBeLessThanOrEqual(375 * 0.92 + EPS);
  });

  it('thumbnail height is bounded (44–130 px) and scales with the viewport', () => {
    expect(shelfHeight(100)).toBe(44);
    expect(shelfHeight(5000)).toBe(130);
    expect(shelfHeight(900)).toBeCloseTo(99, 6);
  });
});

describe('tenFrame', () => {
  for (const [w, h] of [[400, 225], [800, 450], [1200, 675], [300, 300]] as Array<[number, number]>) {
    it(`gives 10 cells in 2 rows × 5 inside the card's right area (${w}×${h})`, () => {
      const { cells, cell } = tenFrame(w, h);
      expect(cells).toHaveLength(20);
      expect(cell).toBeGreaterThan(0);
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < 10; i++) {
        const x = cells[i * 2];
        const y = cells[i * 2 + 1];
        xs.push(x);
        ys.push(y);
        // Right area: clear of the numeral on the left (left 40 % of the card).
        expect(x - cell / 2).toBeGreaterThanOrEqual(-w / 2 + w * 0.4 - 1e-3);
        expect(x + cell / 2).toBeLessThanOrEqual(w / 2 + 1e-3);
        // Above the word line at the bottom.
        expect(y - cell / 2).toBeGreaterThanOrEqual(-h / 2 - 1e-3);
        expect(y + cell / 2).toBeLessThanOrEqual(-h / 2 + h * 0.7 + 1e-3);
      }
      // Rows of 5: the first 5 share a row above the next 5; columns step by one cell.
      expect(new Set(ys.slice(0, 5).map((v) => v.toFixed(3))).size).toBe(1);
      expect(new Set(ys.slice(5).map((v) => v.toFixed(3))).size).toBe(1);
      expect(ys[5] - ys[0]).toBeCloseTo(cell, 3);
      for (let i = 1; i < 5; i++) expect(xs[i] - xs[i - 1]).toBeCloseTo(cell, 3);
      expect(xs[5]).toBeCloseTo(xs[0], 3);
    });
  }
});

describe('cardKey', () => {
  const BLUE: NamedColor = { name: 'blue', hex: '#4A86D8', container: '#DFEAFB', ink: '#1D4F99' };
  const world = { id: 'paper', dark: false, surface: '#FFFFFF', onSurface: '#1F2328' } as unknown as World;
  const style: CardStyle = { world, fontFamily: 'Andika', dpr: 2 };
  const base: CardSpec = {
    kind: 'letter', text: 'Bb', picture: '⚽', word: 'ball', highlight: [0, 1],
    shape: null, direction: null, color: BLUE,
  };
  const key = (spec: Partial<CardSpec>, w = 400, h = 300, s: Partial<CardStyle> = {}) =>
    cardKey({ ...base, ...spec }, w, h, { ...style, ...s });

  it('is stable for identical inputs (sprites are reused)', () => {
    expect(key({})).toBe(key({}));
    expect(key({}, 400.2, 299.8)).toBe(key({}, 400, 300)); // sub-pixel jitter rounds away
  });

  it('changes with every visual input', () => {
    const k0 = key({});
    const variants: Array<[string, string]> = [
      ['kind', key({ kind: 'picture' })],
      ['text', key({ text: 'B' })],
      ['picture', key({ picture: '🍌' })],
      ['word', key({ word: 'bus' })],
      ['highlight', key({ highlight: [1, 2] })],
      ['no highlight', key({ highlight: null })],
      ['shape', key({ kind: 'shape', shape: 'star' })],
      ['direction', key({ kind: 'direction', direction: 'up' })],
      ['container', key({ color: { ...BLUE, container: '#EEEEEE' } })],
      ['ink', key({ color: { ...BLUE, ink: '#000000' } })],
      ['no colour', key({ color: null })],
      ['width', key({}, 420, 300)],
      ['height', key({}, 400, 320)],
      ['dpr', key({}, 400, 300, { dpr: 3 })],
      ['font', key({}, 400, 300, { fontFamily: 'serif' })],
      ['world', key({}, 400, 300, { world: { ...world, id: 'space' } as World })],
    ];
    for (const [what, k] of variants) expect(k, what).not.toBe(k0);
    expect(new Set(variants.map(([, k]) => k)).size).toBe(variants.length);
  });

  it('distinguishes shapes and directions from each other', () => {
    const shapes = ['circle', 'square', 'oval', 'rectangle'] as const;
    expect(new Set(shapes.map((s) => key({ kind: 'shape', shape: s }))).size).toBe(shapes.length);
    const dirs = ['up', 'down', 'left', 'right'] as const;
    expect(new Set(dirs.map((d) => key({ kind: 'direction', direction: d }))).size).toBe(dirs.length);
  });

  it('changes when only the colour hex changes (shape cards paint in hex)', () => {
    const shape: Partial<CardSpec> = { kind: 'shape', shape: 'circle', text: null, picture: null, word: 'blue circle' };
    expect(key({ ...shape, color: { ...BLUE, hex: '#123456' } })).not.toBe(key({ ...shape, color: BLUE }));
  });
});

describe('renderCard (smoke, recording fake ctx)', () => {
  const BLUE: NamedColor = { name: 'blue', hex: '#4A86D8', container: '#DFEAFB', ink: '#1D4F99' };
  afterEach(() => vi.restoreAllMocks());

  function fakeCtx() {
    const log = { calls: [] as string[], composites: [] as string[], fills: [] as unknown[], problems: [] as string[] };
    const props: Record<string, unknown> = { globalAlpha: 1, fillStyle: '#000', globalCompositeOperation: 'source-over' };
    const ctx = new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop in props) return props[prop];
        if (prop === 'roundRect') return undefined; // exercise the arcTo fallback
        return (...args: unknown[]) => {
          for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) log.problems.push(`${prop}(${a})`);
          log.calls.push(prop);
          if (prop === 'fill' || prop === 'fillText') log.fills.push(props.fillStyle);
          if (prop === 'measureText') return { width: 50, actualBoundingBoxAscent: 30, actualBoundingBoxDescent: 2 };
          return undefined;
        };
      },
      set(_t, prop, value) {
        if (prop === 'globalCompositeOperation') log.composites.push(String(value));
        props[prop as string] = value;
        return true;
      },
    });
    return { ctx, log };
  }

  it('returns null when no 2D context is available', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const world = { id: 'paper', dark: false, surface: '#FFFFFF', onSurface: '#1F2328' } as unknown as World;
    expect(renderCard({ kind: 'letter', text: 'A' }, 300, 225, { world, fontFamily: 'Andika', dpr: 1 })).toBeNull();
  });

  for (const dark of [false, true]) {
    it(`renders every kind matte and padded (${dark ? 'dark' : 'light'} world)`, () => {
      const world = { id: dark ? 'space' : 'paper', dark, surface: dark ? '#1E2740' : '#FFFFFF', onSurface: '#1F2328' } as unknown as World;
      const specs: CardSpec[] = [
        { kind: 'letter', text: 'Bb', picture: '⚽', word: 'ball', highlight: [0, 1], color: BLUE },
        { kind: 'digit', text: '3', picture: '⭐', word: '3 stars', count: 3, color: BLUE },
        { kind: 'shape', shape: 'oval', word: 'blue oval', highlight: [0, 4], color: BLUE },
        { kind: 'picture', picture: '🐄', word: 'cow' },
        { kind: 'direction', direction: 'left', word: 'left', color: BLUE },
      ];
      for (const spec of specs) {
        const { ctx, log } = fakeCtx();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
        const w = spec.kind === 'digit' ? 480 : 400;
        const sprite = renderCard(spec, w, 300, { world, fontFamily: 'Andika', dpr: 2 })!;
        expect(sprite).not.toBeNull();
        expect(sprite.pad).toBeGreaterThan(w * 0.06); // room for the baked shadow
        expect(sprite.canvas.width).toBe(Math.ceil((w + sprite.pad * 2) * 2));
        expect(spriteCost(sprite)).toBe(sprite.canvas.width * sprite.canvas.height * 4);
        expect(log.problems).toEqual([]);
        expect(log.calls).not.toContain('createRadialGradient');
        expect(log.calls).not.toContain('createLinearGradient');
        expect(log.composites).not.toContain('lighter');
        expect(log.calls.filter((c) => c === 'save').length).toBe(log.calls.filter((c) => c === 'restore').length);
        // Surface: the colour's container, or the world's neutral surface for pictures.
        expect(log.fills[0]).toBe(spec.kind === 'picture' ? world.surface : BLUE.container);
        if (spec.highlight) expect(log.fills).toContain(BLUE.ink);
        vi.restoreAllMocks();
      }
    });
  }
});
