import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomPointerInput } from '../src/input/pointer';
import type { PointerHandlers } from '../src/types';

type Handlers = {
  [K in keyof Required<PointerHandlers>]: ReturnType<typeof vi.fn<Required<PointerHandlers>[K]>>;
};

function makeHandlers(): Handlers {
  return {
    onTap: vi.fn(),
    onDrag: vi.fn(),
    onRelease: vi.fn(),
    onHover: vi.fn(),
    onCornerHold: vi.fn(),
    onCornerProgress: vi.fn(),
  };
}

describe('DomPointerInput', () => {
  let el: HTMLCanvasElement;
  let h: Handlers;
  let input: DomPointerInput;

  const fire = (type: string, init: PointerEventInit & { pointerType?: string } = {}) => {
    const e = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', ...init });
    el.dispatchEvent(e);
    return e;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement('canvas');
    document.body.append(el);
    h = makeHandlers();
    input = new DomPointerInput(el, h);
    input.attach();
  });

  afterEach(() => {
    input.detach();
    el.remove();
    vi.useRealTimers();
  });

  it('reports tap, drag and release with CSS-pixel coordinates', () => {
    fire('pointerdown', { clientX: 200, clientY: 300, pointerId: 7 });
    expect(h.onTap).toHaveBeenCalledWith(200, 300, 7);
    fire('pointermove', { clientX: 210, clientY: 295, pointerId: 7 });
    fire('pointermove', { clientX: 230, clientY: 290, pointerId: 7 });
    expect(h.onDrag.mock.calls).toEqual([
      [210, 295, 10, -5, 7],
      [230, 290, 20, -5, 7],
    ]);
    fire('pointerup', { clientX: 231, clientY: 289, pointerId: 7 });
    expect(h.onRelease).toHaveBeenCalledWith(231, 289, 7);
    // No longer pressed: further touch moves do nothing.
    fire('pointermove', { clientX: 240, clientY: 280, pointerId: 7 });
    expect(h.onDrag).toHaveBeenCalledTimes(2);
    expect(h.onHover).not.toHaveBeenCalled();
  });

  it('tracks several fingers independently', () => {
    fire('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
    fire('pointerdown', { clientX: 500, clientY: 500, pointerId: 2 });
    fire('pointermove', { clientX: 110, clientY: 100, pointerId: 1 });
    fire('pointermove', { clientX: 500, clientY: 520, pointerId: 2 });
    expect(h.onDrag.mock.calls).toEqual([
      [110, 100, 10, 0, 1],
      [500, 520, 0, 20, 2],
    ]);
    fire('pointerup', { clientX: 110, clientY: 100, pointerId: 1 });
    fire('pointermove', { clientX: 505, clientY: 525, pointerId: 2 });
    expect(h.onDrag).toHaveBeenLastCalledWith(505, 525, 5, 5, 2);
  });

  it('ends a pointer on cancel or lost capture, exactly once', () => {
    fire('pointerdown', { clientX: 300, clientY: 300, pointerId: 3 });
    fire('pointermove', { clientX: 320, clientY: 310, pointerId: 3 });
    fire('lostpointercapture', { clientX: 0, clientY: 0, pointerId: 3 });
    expect(h.onRelease).toHaveBeenCalledWith(320, 310, 3); // last known spot, not (0, 0)
    fire('pointerup', { clientX: 320, clientY: 310, pointerId: 3 });
    fire('pointercancel', { pointerId: 3 });
    expect(h.onRelease).toHaveBeenCalledTimes(1);

    fire('pointerdown', { clientX: 400, clientY: 400, pointerId: 4 });
    fire('pointercancel', { clientX: 401, clientY: 401, pointerId: 4 });
    expect(h.onRelease).toHaveBeenLastCalledWith(401, 401, 4);
  });

  it('hovers only for a mouse with no buttons pressed', () => {
    fire('pointermove', { clientX: 50, clientY: 60, pointerType: 'mouse', buttons: 0 });
    fire('pointermove', { clientX: 55, clientY: 70, pointerType: 'mouse', buttons: 0 });
    expect(h.onHover.mock.calls).toEqual([
      [50, 60, 0, 0],
      [55, 70, 5, 10],
    ]);
    fire('pointermove', { clientX: 60, clientY: 70, pointerType: 'touch' });
    fire('pointermove', { clientX: 60, clientY: 70, pointerType: 'pen', buttons: 0 });
    fire('pointermove', { clientX: 60, clientY: 70, pointerType: 'mouse', buttons: 1 }); // dragged in from outside
    expect(h.onHover).toHaveBeenCalledTimes(2);
    expect(h.onDrag).not.toHaveBeenCalled();
  });

  it('turns a mouse press into a drag, then back into hover', () => {
    fire('pointerdown', { clientX: 300, clientY: 300, pointerType: 'mouse', buttons: 1 });
    fire('pointermove', { clientX: 310, clientY: 300, pointerType: 'mouse', buttons: 1 });
    fire('pointerup', { clientX: 310, clientY: 300, pointerType: 'mouse', buttons: 0 });
    fire('pointermove', { clientX: 315, clientY: 302, pointerType: 'mouse', buttons: 0 });
    expect(h.onDrag).toHaveBeenCalledTimes(1);
    expect(h.onHover).toHaveBeenCalledWith(315, 302, 5, 2);
  });

  it('blocks browser touch gestures on the element while attached', () => {
    expect(el.style.touchAction).toBe('none');
    input.detach();
    expect(el.style.touchAction).toBe('');
  });

  describe('corner hold', () => {
    it('fires once after the hold time, with progress along the way', () => {
      fire('pointerdown', { clientX: 20, clientY: 30, pointerId: 9 });
      expect(h.onTap).toHaveBeenCalledWith(20, 30, 9); // corner presses still tap

      vi.advanceTimersByTime(1250);
      const mid = h.onCornerProgress.mock.lastCall?.[0] ?? 0;
      expect(mid).toBeGreaterThan(0.4);
      expect(mid).toBeLessThan(0.6);
      expect(h.onCornerHold).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1200);
      expect(h.onCornerHold).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(h.onCornerHold).toHaveBeenCalledTimes(1);
      expect(h.onCornerProgress).toHaveBeenCalledWith(1);
      expect(h.onCornerProgress).toHaveBeenLastCalledWith(0);

      // Progress values only grow until the hold completes.
      const values = h.onCornerProgress.mock.calls.map((c) => c[0]);
      const climb = values.slice(0, values.indexOf(1) + 1);
      for (let i = 1; i < climb.length; i++) expect(climb[i]).toBeGreaterThan(climb[i - 1]);

      // Keep holding: nothing more happens, and no timer is left running.
      vi.advanceTimersByTime(5000);
      expect(h.onCornerHold).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('allows small wobbles but cancels when the finger wanders', () => {
      fire('pointerdown', { clientX: 20, clientY: 20 });
      fire('pointermove', { clientX: 30, clientY: 35 }); // ~18 px: fine
      vi.advanceTimersByTime(1000);
      fire('pointermove', { clientX: 60, clientY: 20 }); // 40 px: cancelled
      expect(h.onCornerProgress).toHaveBeenLastCalledWith(0);
      vi.advanceTimersByTime(3000);
      expect(h.onCornerHold).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels on release and resets progress to 0', () => {
      fire('pointerdown', { clientX: 10, clientY: 10 });
      vi.advanceTimersByTime(2000);
      fire('pointerup', { clientX: 10, clientY: 10 });
      expect(h.onCornerProgress).toHaveBeenLastCalledWith(0);
      vi.advanceTimersByTime(3000);
      expect(h.onCornerHold).not.toHaveBeenCalled();
    });

    it('ignores presses outside the corner zone', () => {
      fire('pointerdown', { clientX: 81, clientY: 10 });
      fire('pointerdown', { clientX: 10, clientY: 200, pointerId: 2 });
      vi.advanceTimersByTime(3000);
      expect(h.onCornerProgress).not.toHaveBeenCalled();
      expect(h.onCornerHold).not.toHaveBeenCalled();
    });

    it('is not disturbed by other fingers', () => {
      fire('pointerdown', { clientX: 10, clientY: 10, pointerId: 1 });
      fire('pointerdown', { clientX: 400, clientY: 400, pointerId: 2 });
      fire('pointermove', { clientX: 600, clientY: 600, pointerId: 2 });
      fire('pointerup', { clientX: 600, clientY: 600, pointerId: 2 });
      vi.advanceTimersByTime(2600);
      expect(h.onCornerHold).toHaveBeenCalledTimes(1);
    });

    it('honours custom size and duration', () => {
      input.detach();
      input = new DomPointerInput(el, h, { cornerSize: 40, cornerHoldMs: 1000 });
      input.attach();
      fire('pointerdown', { clientX: 50, clientY: 10 });
      vi.advanceTimersByTime(1500);
      expect(h.onCornerHold).not.toHaveBeenCalled();
      fire('pointerup', { clientX: 50, clientY: 10 });
      fire('pointerdown', { clientX: 30, clientY: 30 });
      vi.advanceTimersByTime(1050);
      expect(h.onCornerHold).toHaveBeenCalledTimes(1);
    });
  });

  it('setEnabled(false) silences everything and cancels a corner hold', () => {
    fire('pointerdown', { clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(1000);
    input.setEnabled(false);
    expect(h.onCornerProgress).toHaveBeenLastCalledWith(0);
    vi.advanceTimersByTime(3000);
    expect(h.onCornerHold).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    fire('pointermove', { clientX: 20, clientY: 20 });
    fire('pointerup', { clientX: 20, clientY: 20 });
    fire('pointerdown', { clientX: 300, clientY: 300, pointerId: 5 });
    fire('pointermove', { clientX: 50, clientY: 50, pointerType: 'mouse', buttons: 0 });
    expect(h.onDrag).not.toHaveBeenCalled();
    expect(h.onRelease).not.toHaveBeenCalled();
    expect(h.onHover).not.toHaveBeenCalled();
    expect(h.onTap).toHaveBeenCalledTimes(1);

    input.setEnabled(true);
    fire('pointerdown', { clientX: 300, clientY: 300, pointerId: 6 });
    expect(h.onTap).toHaveBeenCalledTimes(2);
  });

  it('detach removes listeners and timers', () => {
    fire('pointerdown', { clientX: 10, clientY: 10 });
    input.detach();
    expect(vi.getTimerCount()).toBe(0);
    fire('pointerdown', { clientX: 300, clientY: 300, pointerId: 2 });
    expect(h.onTap).toHaveBeenCalledTimes(1);
  });

  it('stays bounded when pointer-up events go missing', () => {
    for (let id = 1; id <= 1000; id++) fire('pointerdown', { clientX: 300, clientY: 300, pointerId: id });
    // Old pointers were evicted; the newest still drags.
    fire('pointermove', { clientX: 310, clientY: 300, pointerId: 1000 });
    fire('pointermove', { clientX: 310, clientY: 300, pointerId: 1 });
    expect(h.onDrag).toHaveBeenCalledTimes(1);
  });

  it('works without the optional progress handler', () => {
    input.detach();
    const { onCornerProgress: _ignored, ...rest } = makeHandlers();
    void _ignored;
    input = new DomPointerInput(el, rest);
    input.attach();
    fire('pointerdown', { clientX: 10, clientY: 10 });
    expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
    expect(rest.onCornerHold).toHaveBeenCalledTimes(1);
  });
});
