import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const testDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: testDir,
  test: {
    environment: 'node',
    include: ['_components/*.test.ts'],
  },
});
