/**
 * A small Markdown reader for chat messages. It covers what agents write in practice:
 * headings, lists, quotes, tables, code and emphasis. The result is plain data that the UI
 * renders as React elements, never as HTML.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'mention'; name: string }
  | { kind: 'link'; href: string; text: string }
  | { kind: 'bold'; children: Inline[] }
  | { kind: 'italic'; children: Inline[] }
  | { kind: 'strike'; children: Inline[] };

export interface ListItem {
  /** Usually one paragraph. Nested lists and code under the item follow it. */
  blocks: Block[];
  /** For task lists: `- [x] done`. */
  checked?: boolean;
}

export type Block =
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'heading'; level: number; content: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][] }
  | { kind: 'codeBlock'; language: string; text: string }
  | { kind: 'rule' };

// One alternative per inline construct, tried left to right at each position.
const INLINE = new RegExp(
  [
    '`([^`\\n]+)`', // 1: code
    '\\*\\*(?=\\S)(.+?)(?<=\\S)\\*\\*', // 2: bold
    '(?<![\\w*])\\*(?=[^\\s*])([^*\\n]+?)(?<=\\S)\\*(?![\\w*])', // 3: italic with *
    '(?<![\\w_])_(?=[^\\s_])([^_\\n]+?)(?<=\\S)_(?![\\w_])', // 4: italic with _
    '~~(?=\\S)(.+?)(?<=\\S)~~', // 5: strike
    '\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)', // 6, 7: [text](target)
    '(https?://[^\\s<>]*[^\\s<>.,;:!?)\\]\'"])', // 8: a bare web address
    '(?<![A-Za-z0-9_@./-])@([A-Za-z][A-Za-z0-9_-]{0,31})(?![A-Za-z0-9_])', // 9: @name
  ].join('|'),
  'g',
);

/** Splits one run of text into emphasis, code, links, @mentions of known names and plain text. */
export function parseInline(text: string, mentionable: readonly string[]): Inline[] {
  return inline(text, new Set(mentionable.map((name) => name.toLowerCase())));
}

function inline(text: string, names: Set<string>): Inline[] {
  const parts: Inline[] = [];
  let last = 0;
  const push = (start: number, end: number, part: Inline): void => {
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    parts.push(part);
    last = end;
  };
  for (const match of text.matchAll(INLINE)) {
    const [whole, code, bold, star, underscore, strike, label, target, url, name] = match;
    const start = match.index;
    const end = start + whole.length;
    if (code !== undefined) push(start, end, { kind: 'code', text: code });
    else if (bold !== undefined) push(start, end, { kind: 'bold', children: inline(bold, names) });
    else if (star !== undefined)
      push(start, end, { kind: 'italic', children: inline(star, names) });
    else if (underscore !== undefined) {
      push(start, end, { kind: 'italic', children: inline(underscore, names) });
    } else if (strike !== undefined) {
      push(start, end, { kind: 'strike', children: inline(strike, names) });
    } else if (label !== undefined && target !== undefined) {
      // Only web addresses become links. Anything else, such as the file:// paths some agents
      // print, is shown by its label alone.
      if (/^https?:\/\//i.test(target))
        push(start, end, { kind: 'link', href: target, text: label });
      else push(start, end, { kind: 'text', text: label });
    } else if (url !== undefined) push(start, end, { kind: 'link', href: url, text: url });
    else if (name !== undefined && names.has(name.toLowerCase())) {
      push(start, end, { kind: 'mention', name });
    }
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

const FENCE_OPEN = /^\s*```\s*([\w+#.-]*)[^`]*$/;
const FENCE_CLOSE = /^\s*```\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Reads a whole message into blocks. `mentionable` lists the names that count as @mentions. */
export function parseMarkdown(body: string, mentionable: readonly string[]): Block[] {
  const names = new Set(mentionable.map((name) => name.toLowerCase()));
  return blocks(body.replace(/\r\n?/g, '\n').split('\n'), names);
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE_OPEN.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    (TABLE_ROW.test(line) && next !== undefined && TABLE_DIVIDER.test(next))
  );
}

function blocks(lines: string[], names: Set<string>): Block[] {
  const result: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i]!)) code.push(lines[i++]!);
      i += 1; // The closing fence. A block left open runs to the end.
      result.push({ kind: 'codeBlock', language: fence[1] ?? '', text: code.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      result.push({
        kind: 'heading',
        level: heading[1]!.length,
        content: inline(heading[2]!, names),
      });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      result.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) quoted.push(QUOTE.exec(lines[i++]!)![1]!);
      result.push({ kind: 'quote', blocks: blocks(quoted, names) });
      continue;
    }

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!)) {
      const header = tableCells(line, names);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i]!))
        rows.push(tableCells(lines[i++]!, names));
      result.push({ kind: 'table', header, rows });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const [block, next] = list(lines, i, names);
      result.push(block);
      i = next;
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !startsBlock(lines[i]!, lines[i + 1])) {
      paragraph.push(lines[i++]!);
    }
    if (paragraph.length === 0) paragraph.push(lines[i++]!);
    result.push({ kind: 'paragraph', content: inline(paragraph.join('\n'), names) });
  }
  return result;
}

function tableCells(line: string, names: Set<string>): Inline[][] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => inline(cell.trim().replace(/\\\|/g, '|'), names));
}

const indentOf = (line: string): number => /^\s*/.exec(line)![0].replace(/\t/g, '    ').length;

/**
 * Reads the list that starts at `lines[from]`. Lines indented under an item belong to it, so an
 * item can hold a nested list or a code block. Returns the list and the index of the line after.
 */
function list(lines: string[], from: number, names: Set<string>): [Block, number] {
  const first = LIST_ITEM.exec(lines[from]!)!;
  const indent = indentOf(lines[from]!);
  const ordered = first[3] !== undefined;
  const items: ListItem[] = [];
  const isNextItem = (line: string | undefined): boolean => {
    const item = line === undefined ? null : LIST_ITEM.exec(line);
    return item !== null && indentOf(line!) >= indent && (item[3] !== undefined) === ordered;
  };

  let i = from;
  while (isNextItem(lines[i])) {
    const body = [LIST_ITEM.exec(lines[i]!)![4]!];
    const under: string[] = [];
    i += 1;
    while (i < lines.length) {
      const line = lines[i]!;
      const blank = line.trim() === '';
      // A blank line stays in the item only when something indented follows it.
      const next = blank ? lines[i + 1] : line;
      if (next === undefined || next.trim() === '' || indentOf(next) <= indent) break;
      under.push(line);
      i += 1;
    }
    const shared = Math.min(...under.filter((line) => line.trim() !== '').map(indentOf));
    for (const line of under) body.push(line.replace(/\t/g, '    ').slice(shared));

    const task = TASK.exec(body[0]!);
    if (task) body[0] = task[2]!;
    const item: ListItem = { blocks: blocks(body, names) };
    if (task) item.checked = task[1] !== ' ';
    items.push(item);

    // One blank line between two items does not end the list.
    if (lines[i]?.trim() === '' && isNextItem(lines[i + 1])) i += 1;
  }
  return [{ kind: 'list', ordered, start: ordered ? Number(first[3]) : 1, items }, i];
}

/** One file's line of `git diff --stat`: "src/cart.ts | 31 ++++---". */
export interface DiffStatLine {
  path: string;
  /** The number of changed lines, or a word such as "Bin". */
  changes: string;
  added: number;
  removed: number;
}

export interface DiffStat {
  files: DiffStatLine[];
  /** The closing line: "2 files changed, 74 insertions(+), 5 deletions(-)". */
  summary: string;
}

/** Reads the text of `git diff --stat` into rows, so the UI can colour the bars. */
export function parseDiffStat(stat: string): DiffStat {
  const files: DiffStatLine[] = [];
  let summary = '';
  for (const line of stat.split('\n')) {
    const row = /^\s*(.+?)\s+\|\s+(\S+)\s*([+-]*)\s*(.*)$/.exec(line);
    if (row) {
      const bar = row[3]!;
      files.push({
        path: row[1]!,
        changes: row[4] ? `${row[2]} ${row[4]}` : row[2]!,
        added: bar.split('+').length - 1,
        removed: bar.split('-').length - 1,
      });
    } else if (line.trim() !== '') {
      summary = line.trim();
    }
  }
  return { files, summary };
}
