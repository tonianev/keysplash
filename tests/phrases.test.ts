import { describe, expect, it } from 'vitest';
import { praise } from '../src/content';
import { PRAISE, greetingFor, helloFor, lines, pickPraise, withPraise } from '../src/phrases';

const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe('phrases: lines', () => {
  it('builds letter lines with any namer', () => {
    expect(lines.letter('bee')).toBe('bee');
    expect(lines.letterWord('bee', 'ball', true)).toBe('bee… bee is for ball');
    expect(lines.letterWord('ex', 'fox', false)).toBe('ex… fox');
    expect(lines.letterWord('B', 'ball', true)).toBe('B… B is for ball');
  });

  it('builds number, shape, direction and clear lines', () => {
    expect(lines.number('three')).toBe('three');
    expect(lines.countSummary('three', 'stars')).toBe('three stars!');
    expect(lines.zero()).toBe('zero — none!');
    expect(lines.shape('blue', 'circle')).toBe('blue circle');
    expect(lines.picture('cow')).toBe('cow');
    expect(lines.color('red')).toBe('red');
    expect(lines.direction('up')).toBe('up!');
    expect(lines.clean()).toBe('all clean!');
  });

  it('builds game lines', () => {
    expect(lines.findPrompt('bee')).toBe('Can you find bee?');
    expect(lines.yes('bee')).toBe("Yes! That's bee!");
    expect(lines.thatsFind('em', 'bee')).toBe("That's em. Can you find bee?");
    expect(lines.thats('em')).toBe("That's em.");
    expect(lines.find('tee')).toBe('Find tee.');
    expect(lines.spellPrompt('cat', 'see')).toBe("Let's spell cat. Find see.");
    expect(lines.spellNext('see', 'ay')).toBe('see! Now find ay.');
    expect(lines.spellDone(['see', 'ay', 'tee'], 'cat')).toBe('see, ay, tee… cat! You spelled cat!');
  });

  it('has nameless and named greetings and cheers', () => {
    expect(lines.greeting()).toBe("Let's play!");
    expect(lines.hello()).toBe('Hello!');
    expect(lines.yay()).toBe('Yay!');
    expect(lines.hi('Emma')).toBe('Hi, Emma!');
    expect(lines.yayName('Emma')).toBe('Yay, Emma!');
    expect(lines.greatJobName('Emma')).toBe('Great job, Emma!');
    expect(greetingFor('')).toBe("Let's play!");
    expect(greetingFor('  Emma ')).toBe('Hi, Emma!');
    expect(helloFor()).toBe('Hello!');
    expect(helloFor('Emma')).toBe('Hi, Emma!');
  });

  it('appends praise only when there is some', () => {
    expect(withPraise("Yes! That's bee!", null)).toBe("Yes! That's bee!");
    expect(withPraise("Yes! That's bee!", 'Super!')).toBe("Yes! That's bee! Super!");
  });
});

describe('phrases: praise', () => {
  it('picks stock praise without a name, in bounds', () => {
    expect(pickPraise(() => 0)).toBe(PRAISE[0]);
    expect(pickPraise(() => 0.9999)).toBe(PRAISE[PRAISE.length - 1]);
    expect(pickPraise(() => 1)).toBe(PRAISE[PRAISE.length - 1]);
    for (let i = 0; i < 20; i++) expect(PRAISE).toContain(pickPraise(Math.random, ''));
  });

  it('sometimes uses the name', () => {
    expect(pickPraise(() => 0.1, 'Mia')).toBe('Great job, Mia!');
    expect(pickPraise(seq(0.9, 0), 'Mia')).toBe('Great job!');
  });

  it('content.praise delegates to phrases', () => {
    expect(praise(() => 0.1, 'Mia')).toBe(pickPraise(() => 0.1, 'Mia'));
    expect(praise(() => 0.5)).toBe(pickPraise(() => 0.5));
  });

  it('every praise line is a single sentence', () => {
    for (const p of PRAISE) expect(p).toMatch(/^[^.!?…]+[!.?]$/);
  });
});
