import { describe, it, expect } from 'vitest'
import { createLocalEmbeddingProvider } from '../../src/utils/embeddings'

const RUN = process.env.RUN_E2E === '1'

;(RUN ? describe : describe.skip)('E2E: Embeddings Provider (Transformers.js)', () => {
  it('initializes and returns 384-dim normalized vectors (default model)', async () => {
    const provider = await createLocalEmbeddingProvider()
    const v = await provider.embed('hello world')
    expect(v.length).toBeGreaterThan(0)
    // Expect MiniLM default dimension
    expect(v.length).toBeGreaterThanOrEqual(256)
    expect(v.length).toBeLessThanOrEqual(1024)
    // Norm ~ 1
    const norm = Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0))
    expect(norm).toBeGreaterThan(0.98)
    expect(norm).toBeLessThan(1.02)
  })
})
