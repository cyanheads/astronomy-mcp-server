/**
 * @fileoverview Cost of `findShower()`, which normalizes caller-sized `shower` text before
 *   its table lookup. Thread CPU per call must grow linearly with the input on every
 *   shape timed here: each doubling of the input is checked against a linear bound before
 *   the next runs, so a super-linear normalizer fails within seconds rather than hanging
 *   the suite on the largest input.
 * @module tests/services/meteor-showers.test
 */

import { describe, expect, it } from 'vitest';
import { findShower } from '@/services/ephemeris/meteor-showers.js';

/** Thread CPU milliseconds `work` takes; time a loaded machine deschedules the thread adds none. */
const cpuMs = (work: () => void): number => {
  const start = process.threadCpuUsage();
  work();
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / 1000;
};

/**
 * Thread CPU per call on `text`, the least of three batches of `calls` calls. A pause for
 * garbage collection only ever adds time, so the least is the cleanest sample.
 */
const perCallMs = (text: string, calls: number): number =>
  Math.min(
    ...Array.from({ length: 3 }, () =>
      cpuMs(() => {
        for (let i = 0; i < calls; i++) findShower(text);
      }),
    ),
  ) / calls;

/** Thread CPU a batch on the smallest input is sized to, well above the clock's resolution. */
const BATCH_MS = 2;

/**
 * Growth of per-call CPU from `smallest` characters through 64× that, doubling. Every
 * batch normalizes the same number of characters, sized so the smallest input's batch
 * takes about `BATCH_MS`. The baseline is timed again beside each larger size and the
 * least growth over three such pairs is kept, so a baseline that ran on a faster core than
 * a later size cannot read as super-linear. Linear growth at factor f is f; the bound is
 * 4f (256 across the full 64× span), which a quadratic (f²) passes only through factor 4.
 * Each size also holds an absolute bound of a microsecond of CPU per character, far above
 * the linear cost.
 */
const expectLinearGrowth = (make: (length: number) => string, smallest: number) => {
  const base = make(smallest);
  const probeMs = cpuMs(() => {
    for (let i = 0; i < 20; i++) findShower(base);
  });
  const baseCalls = Math.max(1, Math.ceil((20 * BATCH_MS) / Math.max(probeMs, 0.001)));
  const charsPerBatch = baseCalls * base.length;
  for (let factor = 2; factor <= 64; factor *= 2) {
    const text = make(smallest * factor);
    const calls = Math.max(1, Math.round(charsPerBatch / text.length));
    findShower(text);
    let growth = Number.POSITIVE_INFINITY;
    let sizeMs = Number.POSITIVE_INFINITY;
    for (let pair = 0; pair < 3; pair++) {
      const baseMs = perCallMs(base, baseCalls);
      const ms = perCallMs(text, calls);
      sizeMs = Math.min(sizeMs, ms);
      growth = Math.min(growth, ms / baseMs);
    }
    expect(sizeMs, `${text.length} characters, ms per call`).toBeLessThan(text.length / 1000);
    expect(growth, `${factor}× the input (${text.length} characters)`).toBeLessThan(4 * factor);
  }
};

/** `unit` repeated to exactly `length` characters. */
const repeatTo = (unit: string, length: number) =>
  unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

describe('findShower — normalization time', () => {
  /**
   * The two line-break shapes, which regex engines can treat differently from text with no
   * break, and a separator after every Greek letter symbol span 1.25k → 80k characters; a
   * long digit run, one word with no separator, carries the 5k → 320k span.
   */
  it.each([
    ['one long line ending in a break', (n: number) => `${repeatTo('§1 x', n - 2)}\ny`, 1250],
    ['line breaks throughout', (n: number) => repeatTo('  \r\n', n), 1250],
    ['a Greek letter symbol before every separator', (n: number) => repeatTo('η-', n), 1250],
    ['a long digit run', (n: number) => '7'.repeat(n), 5000],
  ])('grows linearly on %s', (_shape, make, smallest) => expectLinearGrowth(make, smallest), 0);
});
