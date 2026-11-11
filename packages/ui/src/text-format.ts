/** A piece of a message body. Rendered as React elements, never as HTML. */
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'mention'; name: string }
  | { kind: 'codeBlock'; language: string; text: string };

const FENCE = /```([\w+-]*)[^\S\n]*\n([\s\S]*?)(?:\n```|$)/g;
const INLINE = /`([^`\n]+)`|(^|[^A-Za-z0-9_@./-])@([A-Za-z][A-Za-z0-9_-]{0,31})(?![A-Za-z0-9_])/g;

function splitInline(text: string, names: Set<string>): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const [whole, code, before = '', name] = match;
    const start = match.index;
    if (code !== undefined) {
      if (start > last) segments.push({ kind: 'text', text: text.slice(last, start) });
      segments.push({ kind: 'code', text: code });
      last = start + whole.length;
    } else if (name !== undefined && names.has(name.toLowerCase())) {
      const at = start + before.length;
      if (at > last) segments.push({ kind: 'text', text: text.slice(last, at) });
      segments.push({ kind: 'mention', name });
      last = start + whole.length;
    }
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
  return segments;
}

/** Splits a message into code blocks, inline code, @mentions of known names, and plain text. */
export function formatText(body: string, mentionable: readonly string[]): Segment[] {
  const names = new Set(mentionable.map((name) => name.toLowerCase()));
  const segments: Segment[] = [];
  let last = 0;
  for (const match of body.matchAll(FENCE)) {
    if (match.index > last) segments.push(...splitInline(body.slice(last, match.index), names));
    segments.push({ kind: 'codeBlock', language: match[1] ?? '', text: match[2] ?? '' });
    last = match.index + match[0].length;
  }
  if (last < body.length) segments.push(...splitInline(body.slice(last), names));
  return segments;
}

export type DiffLineKind = 'add' | 'remove' | 'hunk' | 'file' | 'context';

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
    return 'file';
  }
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}
