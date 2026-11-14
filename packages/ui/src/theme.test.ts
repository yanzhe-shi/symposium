import { describe, expect, it } from 'vitest';
import { nextTheme, readTheme } from './theme.ts';

describe('theme', () => {
  it('cycles system, light, dark', () => {
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
  });

  it('falls back to the system theme for anything unknown', () => {
    expect(readTheme('dark')).toBe('dark');
    expect(readTheme(null)).toBe('system');
    expect(readTheme('purple')).toBe('system');
  });
});
