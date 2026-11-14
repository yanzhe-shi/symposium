import { describe, expect, it } from 'vitest';
import { diffLineKind, projectFolderFor, shortPath } from './text-format.ts';

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

describe('shortPath', () => {
  it('keeps the end of a long path and leaves a short one alone', () => {
    expect(shortPath('/home/you/projects/sock-shop')).toBe('…/projects/sock-shop');
    expect(shortPath('/srv/app')).toBe('/srv/app');
    expect(shortPath('C:\\Users\\you\\code\\app')).toBe('…/code/app');
  });
});
