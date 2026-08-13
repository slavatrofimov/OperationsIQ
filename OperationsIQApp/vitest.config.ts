/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';

// Test runner config for the agent tool layer. Tests are pure/network-free and
// run in Node; DOM-dependent suites can opt in per-file with:
//   // @vitest-environment jsdom
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'deploy/**/*.test.ts'],
  },
});
