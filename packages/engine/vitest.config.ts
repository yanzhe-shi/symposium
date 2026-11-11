import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'engine',
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
  },
});
