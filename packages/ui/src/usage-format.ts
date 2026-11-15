import type { UsageTotals } from '@symposium/engine/protocol';

/** "45 s", "12 min", "3 h 5 min". */
export function formatWorkTime(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * What the providers reported, in dollars. "–" when none reported anything: that is unknown,
 * not free. A "+" says some of the turns came without a price.
 */
export function formatCost(usage: UsageTotals): string {
  if (usage.costUsd === null) return '–';
  const amount = usage.costUsd < 0.995 ? usage.costUsd.toFixed(3) : usage.costUsd.toFixed(2);
  return `$${amount}${usage.pricedTurns < usage.turns ? '+' : ''}`;
}

/** For a column headed "Turns": "4", or "4 (1 failed)". */
export function formatTurns(usage: UsageTotals): string {
  return usage.failedTurns > 0 ? `${usage.turns} (${usage.failedTurns} failed)` : `${usage.turns}`;
}
