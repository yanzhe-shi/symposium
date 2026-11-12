import { isAbsolute, relative, sep } from 'node:path';
import type { AgentEvent, AgentEventKind } from './types.js';

const MAX_TARGET = 300;
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

/** One tool call, described for the activity timeline: "read src/cart.ts". */
export function toolEvent(
  kind: Exclude<AgentEventKind, 'text' | 'denied'>,
  tool: string,
  target?: string,
): AgentEvent {
  const shown = target === undefined ? undefined : oneLine(target, MAX_TARGET);
  const summary =
    kind === 'tool'
      ? `used ${tool}${shown ? ` on ${shown}` : ''}`
      : `${VERBS[kind]} ${shown || (kind === 'command' ? 'a command' : 'something')}`;
  return { kind, tool, ...(shown ? { target: shown } : {}), summary };
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
    const parsed: unknown = JSON.parse(line.slice(start));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
