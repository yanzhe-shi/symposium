import { describe, expect, it } from 'vitest';
import { clampSideWidth, MIN_CHAT_WIDTH, MIN_SIDE_WIDTH } from './side-width.ts';

describe('clampSideWidth', () => {
  it('keeps the width the human dragged to when there is room', () => {
    expect(clampSideWidth(500.4, 1200)).toBe(500);
  });

  it('does not go below the minimum', () => {
    expect(clampSideWidth(40, 1200)).toBe(MIN_SIDE_WIDTH);
  });

  it('always leaves room for the chat', () => {
    expect(clampSideWidth(5000, 1200)).toBe(1200 - MIN_CHAT_WIDTH);
  });

  it('prefers the panel minimum in a window too small for both', () => {
    expect(clampSideWidth(400, 500)).toBe(MIN_SIDE_WIDTH);
  });
});
