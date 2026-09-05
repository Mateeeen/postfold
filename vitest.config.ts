import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The suite writes SQLite files; running files in parallel against the
    // same database is exactly the multi-writer situation we do not support.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
