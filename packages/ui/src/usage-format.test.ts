import { describe, expect, it } from 'vitest';
import { formatCost, formatTurns, formatWorkTime } from './usage-format.ts';

const usage = (changes: object) => ({
  turns: 4,
  failedTurns: 0,
  durationMs: 0,
  costUsd: null,
  pricedTurns: 0,
  ...changes,
});

describe('usage formatting', () => {
  it('shows work time in the largest fitting unit', () => {
    expect(formatWorkTime(0)).toBe('0 s');
    expect(formatWorkTime(45_400)).toBe('45 s');
    expect(formatWorkTime(12 * 60_000)).toBe('12 min');
    expect(formatWorkTime(185 * 60_000)).toBe('3 h 5 min');
  });

  it('shows an unknown cost as unknown, not as free', () => {
    expect(formatCost(usage({}))).toBe('–');
    expect(formatCost(usage({ costUsd: 0, pricedTurns: 4 }))).toBe('$0.000');
  });

  it('marks a sum that leaves out turns without a price', () => {
    expect(formatCost(usage({ costUsd: 0.0421, pricedTurns: 4 }))).toBe('$0.042');
    expect(formatCost(usage({ costUsd: 0.0421, pricedTurns: 3 }))).toBe('$0.042+');
    expect(formatCost(usage({ costUsd: 12.345, pricedTurns: 4 }))).toBe('$12.35');
  });

  it('counts turns, with the failed ones named', () => {
    expect(formatTurns(usage({ turns: 1 }))).toBe('1');
    expect(formatTurns(usage({ failedTurns: 1 }))).toBe('4 (1 failed)');
  });
});
