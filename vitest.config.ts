import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    // better-sqlite3 is a native addon; worker threads can segfault with
    // node-gyp addons, so run tests in child processes instead
    pool: 'forks',
  },
})