import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts: that one is rooted at src/renderer for
// the UI bundle, while the API tests run in Node against src/main.
export default defineConfig({
  test: {
    root: '.',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      exclude: [
        '**/__tests__/**',
        // Generated data table, no logic.
        'src/main/api/operations.ts',
        // Only run inside Electron (window, x.com view, menu): covered by `npm run e2e`.
        'src/main/main.ts',
        'src/main/xview.ts',
        'src/main/menu.ts',
      ],
      thresholds: { statements: 80, branches: 75, functions: 80, lines: 80 },
      reporter: ['text-summary', 'text'],
    },
  },
});
