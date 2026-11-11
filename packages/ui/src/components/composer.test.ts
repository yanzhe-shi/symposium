import { describe, expect, it } from 'vitest';
import { cleanDraft } from './Composer.tsx';

describe('cleanDraft', () => {
  it('removes trailing whitespace and leading blank lines', () => {
    expect(cleanDraft('\n\n  hello\nworld \n')).toBe('  hello\nworld');
  });

  it('turns a blank draft into an empty string', () => {
    expect(cleanDraft(' \n\t\n ')).toBe('');
  });
});
