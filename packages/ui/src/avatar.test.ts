import { describe, expect, it } from 'vitest';
import { AVATAR_COLOURS, avatarColour, initials } from './avatar.ts';

describe('avatarColour', () => {
  it('gives a name the same colour whatever its case', () => {
    expect(avatarColour('Ada')).toBe(avatarColour('ada'));
    for (const name of ['Ada', 'Grace', 'Linus', '', '名前']) {
      expect(avatarColour(name)).toBeGreaterThanOrEqual(0);
      expect(avatarColour(name)).toBeLessThan(AVATAR_COLOURS);
    }
  });
});

describe('initials', () => {
  it('takes one letter per word, two at most', () => {
    expect(initials('Ada')).toBe('A');
    expect(initials('sock shop')).toBe('SS');
    expect(initials('a-b c')).toBe('AB');
    expect(initials('  ')).toBe('?');
  });
});
