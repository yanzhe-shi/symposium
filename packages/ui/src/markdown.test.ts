import { describe, expect, it } from 'vitest';
import { parseDiffStat, parseInline, parseMarkdown } from './markdown.ts';

const text = (value: string) => ({ kind: 'text', text: value });
const paragraph = (...content: unknown[]) => ({ kind: 'paragraph', content });

describe('parseInline', () => {
  it('finds mentions of known names only', () => {
    expect(parseInline('Hi @Ada and @nobody, mail a@b.c', ['Ada'])).toEqual([
      text('Hi '),
      { kind: 'mention', name: 'Ada' },
      text(' and @nobody, mail a@b.c'),
    ]);
  });

  it('reads bold, italic, strike and code, and leaves code alone', () => {
    expect(parseInline('**Cart** is *done*, ~~not~~ `a * b * c`', [])).toEqual([
      { kind: 'bold', children: [text('Cart')] },
      text(' is '),
      { kind: 'italic', children: [text('done')] },
      text(', '),
      { kind: 'strike', children: [text('not')] },
      text(' '),
      { kind: 'code', text: 'a * b * c' },
    ]);
  });

  it('reads formatting inside bold', () => {
    expect(parseInline('**ask @Ada about `x`**', ['ada'])).toEqual([
      {
        kind: 'bold',
        children: [
          text('ask '),
          { kind: 'mention', name: 'Ada' },
          text(' about '),
          { kind: 'code', text: 'x' },
        ],
      },
    ]);
  });

  it('does not take arithmetic or snake_case for emphasis', () => {
    expect(parseInline('2 * 3 * 4 and my_var_name', [])).toEqual([
      text('2 * 3 * 4 and my_var_name'),
    ]);
  });

  it('links web addresses only', () => {
    expect(parseInline('See [docs](https://example.com/a) or https://example.com/b.', [])).toEqual([
      text('See '),
      { kind: 'link', href: 'https://example.com/a', text: 'docs' },
      text(' or '),
      { kind: 'link', href: 'https://example.com/b', text: 'https://example.com/b' },
      text('.'),
    ]);
    // A file path or a script is shown by its label and never becomes a link.
    expect(parseInline('[cart.ts](file:///work/src/cart.ts) [x](javascript:alert(1))', [])).toEqual(
      [text('cart.ts'), text(' '), text('x'), text(')')],
    );
  });
});

describe('parseMarkdown', () => {
  it('keeps plain text with its line breaks as one paragraph', () => {
    expect(parseMarkdown('one\ntwo\n\nthree', [])).toEqual([
      paragraph(text('one\ntwo')),
      paragraph(text('three')),
    ]);
  });

  it('reads headings, rules and quotes', () => {
    expect(parseMarkdown('## Plan\n---\n> Not blocking\n> at all', [])).toEqual([
      { kind: 'heading', level: 2, content: [text('Plan')] },
      { kind: 'rule' },
      { kind: 'quote', blocks: [paragraph(text('Not blocking\nat all'))] },
    ]);
  });

  it('separates code blocks and does not format inside them', () => {
    expect(parseMarkdown('Run `npm test`:\n```ts\nconst a = "@Ada";\n```\nDone', ['Ada'])).toEqual([
      paragraph(text('Run '), { kind: 'code', text: 'npm test' }, text(':')),
      { kind: 'codeBlock', language: 'ts', text: 'const a = "@Ada";' },
      paragraph(text('Done')),
    ]);
  });

  it('keeps an unclosed code block', () => {
    expect(parseMarkdown('```\nhalf', [])).toEqual([
      { kind: 'codeBlock', language: '', text: 'half' },
    ]);
  });

  it('reads ordered and bulleted lists that follow a paragraph', () => {
    expect(parseMarkdown('Steps:\n1. one\n2. two\n\n- a\n- b', [])).toEqual([
      paragraph(text('Steps:')),
      {
        kind: 'list',
        ordered: true,
        start: 1,
        items: [{ blocks: [paragraph(text('one'))] }, { blocks: [paragraph(text('two'))] }],
      },
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [{ blocks: [paragraph(text('a'))] }, { blocks: [paragraph(text('b'))] }],
      },
    ]);
  });

  it('nests lists and code under the item they are indented below', () => {
    const [list] = parseMarkdown(
      '- outer\n  - inner\n- run:\n  ```sh\n  pnpm test\n  ```\nAfter',
      [],
    );
    expect(list).toEqual({
      kind: 'list',
      ordered: false,
      start: 1,
      items: [
        {
          blocks: [
            paragraph(text('outer')),
            {
              kind: 'list',
              ordered: false,
              start: 1,
              items: [{ blocks: [paragraph(text('inner'))] }],
            },
          ],
        },
        {
          blocks: [
            paragraph(text('run:')),
            { kind: 'codeBlock', language: 'sh', text: 'pnpm test' },
          ],
        },
      ],
    });
  });

  it('reads task lists and keeps a list going across one blank line', () => {
    expect(parseMarkdown('- [x] done\n\n- [ ] todo', [])).toEqual([
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [
          { blocks: [paragraph(text('done'))], checked: true },
          { blocks: [paragraph(text('todo'))], checked: false },
        ],
      },
    ]);
  });

  it('reads tables', () => {
    expect(parseMarkdown('| File | Lines |\n| --- | ---: |\n| `a.ts` | 3 |', [])).toEqual([
      {
        kind: 'table',
        header: [[text('File')], [text('Lines')]],
        rows: [[[{ kind: 'code', text: 'a.ts' }], [text('3')]]],
      },
    ]);
  });
});

describe('parseDiffStat', () => {
  it('reads the files and the summary of git diff --stat', () => {
    const stat =
      ' src/cart.test.ts | 48 ++++++++\n src/cart.ts      | 31 +++--\n logo.png         | Bin 0 -> 120 bytes\n 3 files changed, 74 insertions(+), 5 deletions(-)';
    expect(parseDiffStat(stat)).toEqual({
      files: [
        { path: 'src/cart.test.ts', changes: '48', added: 8, removed: 0 },
        { path: 'src/cart.ts', changes: '31', added: 3, removed: 2 },
        { path: 'logo.png', changes: 'Bin 0 -> 120 bytes', added: 0, removed: 0 },
      ],
      summary: '3 files changed, 74 insertions(+), 5 deletions(-)',
    });
  });
});
