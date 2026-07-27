import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    // Live integration tests self-skip unless ASTROPILOT_LIVE=1 (they need a running
    // PixInsight with the AstroPilot watcher). See test/bridge.integration.test.ts.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
    },
  },
});
