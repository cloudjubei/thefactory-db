import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reportsDirectory: '.coverage-v8',
      reporter: ['text', 'json'], // ensure coverage-final.json is written
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts', 'src/index.ts', 'tests/**', '.stories/**'],
    },
  },
})
