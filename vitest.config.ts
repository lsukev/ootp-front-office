import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Builds the fixture league and points the server at it before anything
    // imports ./server/db.js, which opens its database on load.
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // The modules share one SQLite handle and module-level caches, so the
    // suites must not run against each other in parallel.
    fileParallelism: false,
  },
});
