import { describe, it, expect, vi } from 'vitest'

vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn(async () => async (_text: string) => ({ data: new Float32Array([3, 4, 0]) })),
}))

import { createLocalEmbeddingProvider } from '../src/utils/embeddings'

describe('embeddings options', () => {
  it('normalize: false returns non-unit vector', async () => {
    const provider = await createLocalEmbeddingProvider({ normalize: false })
    const v = await provider.embed('anything')
    const norm = Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0))
    expect(norm).not.toBeCloseTo(1, { precision: 3 })
  })
})
