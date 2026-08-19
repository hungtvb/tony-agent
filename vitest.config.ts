import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    // better-sqlite3 is a native addon; worker threads can segfault with
    // node-gyp addons, so run tests in child processes instead
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        // CLI entry points + demo runners — thin wrappers, low value under tests
        'src/cli/**',
        'src/index.ts',
        // host adapters (CDP/browser) — environment-dependent, covered by e2e smoke instead
        'src/host/**',
        // benchmarks runner
        'src/bench/**',
      ],
      thresholds: {
        // baseline lifted from 74% → per-file 100% target tracked in kanban;
        // each sprint raises these, never lowers.
        statements: 80,
        branches: 79,
        functions: 82,
        lines: 80,
      },
    },
  },
})