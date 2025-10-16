import { defineConfig, coverageConfigDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: '.coverage-v8',
      reporter: ['text', 'json'], // ensure coverage-final.json is written
      exclude: [
        ...coverageConfigDefaults.exclude,
        'scripts/**',
        'src/types.ts',
        'tests/**',
        '.stories/**',
      ],
    },
  },
})
