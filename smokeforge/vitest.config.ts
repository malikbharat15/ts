// vitest.config.ts — Unit + Integration tests (fast, no AI calls)
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    globals: true,
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/cli/**',
        'src/generation/prompts/**',
        'src/generation/client.ts',
      ],
      thresholds: {
        lines: 50,
        functions: 55,
        branches: 45,
        statements: 50,
      },
    },
  },
});
