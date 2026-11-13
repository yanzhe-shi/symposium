import { isAbsolute, relative, sep } from 'node:path';
import type { AgentEvent, AgentEventKind } from './types.js';

const MAX_TARGET = 300;
const MAX_SUMMARY_TARGET = 80;
const MAX_TEXT = 300;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A path as the chat should show it: relative to the agent's working folder when inside it. */
export function displayPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const inside = relative(cwd, path);
  if (inside === '') return '.';
  return inside.startsWith('..') || isAbsolute(inside) ? path : inside.split(sep).join('/');
}

const VERBS: Record<Exclude<AgentEventKind, 'text' | 'denied'>, string> = {
  read: 'read',
  edit: 'edited',
  search: 'searched for',
  command: 'ran',
  tool: 'used',
};

const UNTARGETED: Record<Exclude<AgentEventKind, 'text' | 'denied' | 'tool'>, string> = {
  read: 'read a file',
  edit: 'edited a file',
  search: 'searched the files',
  command: 'ran a command',
};

/** Shortens a long target for a summary by cutting out its middle, which says the least. */
function abridge(target: string): string {
  if (target.length <= MAX_SUMMARY_TARGET) return target;
  const half = Math.floor((MAX_SUMMARY_TARGET - 1) / 2);
  return `${target.slice(0, half)}…${target.slice(-half)}`;
}

/**
 * One tool call, described for the activity timeline: "read src/cart.ts". The summary shortens
 * a very long target; `target` keeps it.
 */
export function toolEvent(
  kind: Exclude<AgentEventKind, 'text' | 'denied'>,
  tool: string,
  target?: string,
): AgentEvent {
  const full = target === undefined ? undefined : oneLine(target, MAX_TARGET);
  const shown = full && abridge(full);
  const summary =
    kind === 'tool'
      ? `used ${tool}${shown ? ` on ${shown}` : ''}`
      : shown
        ? `${VERBS[kind]} ${shown}`
        : UNTARGETED[kind];
  return { kind, tool, ...(full ? { target: full } : {}), summary };
}

/** Something the agent said part-way through its turn. */
export function textEvent(text: string): AgentEvent | undefined {
  const summary = oneLine(text, MAX_TEXT);
  return summary ? { kind: 'text', summary } : undefined;
}

export function deniedEvent(tool: string, reason: string): AgentEvent {
  return { kind: 'denied', tool, summary: oneLine(`was refused ${tool}: ${reason}`, MAX_TEXT) };
}

/** Parses one line of a JSON-lines stream. Lines that are not a JSON object give undefined. */
export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const start = line.indexOf('{');
  if (start === -1) return undefined;
  try {
    return asRecord(JSON.parse(line.slice(start)));
  } catch {
    return undefined;
  }
}

/** The first of `keys` that holds a non-empty string in `record`. */
export function firstString(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
