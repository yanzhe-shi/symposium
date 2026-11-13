import { describe, expect, it } from 'vitest';
import { diffLineKind, formatText, projectFolderFor } from './text-format.ts';

describe('formatText', () => {
  it('finds mentions of known names only', () => {
    expect(formatText('Hi @Ada and @nobody, mail a@b.c', ['Ada'])).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'mention', name: 'Ada' },
      { kind: 'text', text: ' and @nobody, mail a@b.c' },
    ]);
  });

  it('separates inline code and code blocks', () => {
    expect(formatText('Run `npm test`:\n```ts\nconst a = "@Ada";\n```\nDone', ['Ada'])).toEqual([
      { kind: 'text', text: 'Run ' },
      { kind: 'code', text: 'npm test' },
      { kind: 'text', text: ':\n' },
      { kind: 'codeBlock', language: 'ts', text: 'const a = "@Ada";' },
      { kind: 'text', text: '\nDone' },
    ]);
  });

  it('keeps an unclosed code block', () => {
    expect(formatText('```\nhalf', [])).toEqual([
      { kind: 'codeBlock', language: '', text: 'half' },
    ]);
  });
});

describe('diffLineKind', () => {
  it('classifies diff lines', () => {
    expect(diffLineKind('diff --git a/x b/x')).toBe('file');
    expect(diffLineKind('+++ b/x')).toBe('file');
    expect(diffLineKind('@@ -1 +1 @@')).toBe('hunk');
    expect(diffLineKind('+added')).toBe('add');
    expect(diffLineKind('-removed')).toBe('remove');
    expect(diffLineKind(' same')).toBe('context');
  });
});

describe('projectFolderFor', () => {
  it('suggests a folder named after the project, inside the projects folder', () => {
    const base = '/home/you/symposium-projects';
    expect(projectFolderFor(base, 'Sock Shop!')).toBe(`${base}/sock-shop`);
    expect(projectFolderFor(`${base}/`, '  My  App 2 ')).toBe(`${base}/my-app-2`);
    expect(projectFolderFor(base, 'Café – Ünïcode')).toBe(`${base}/caf-n-code`);
    // Nothing to suggest until the name has a letter or a digit.
    expect(projectFolderFor(base, '')).toBe('');
    expect(projectFolderFor(base, '!!!')).toBe('');
  });
});
