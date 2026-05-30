import { defineConfig, coverageConfigDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: '.coverage-v8',
      reporter: ['text', 'json'], // ensure coverage-final.json is written
      // Scope coverage to the actual source tree. Without an explicit
      // `include`, v8 reports anything loaded by the test process, which
      // also pulls in root-level files like `vitest.e2e.config.ts`.
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        ...coverageConfigDefaults.exclude,
        'scripts/**',
        'src/**/types.ts',
        'tests/**',
        '.stories/**',
      ],
    },
  },
})
