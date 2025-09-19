import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock transformers pipeline
vi.mock('@xenova/transformers', () => {
  return {
    pipeline: vi.fn(async () => {
      // return an async extractor function
      return async (text: string, _opts?: any) => {
        // produce a simple 3-dim vector derived from length
        const a = text.length % 5
        const arr = new Float32Array([a + 1, a + 2, a + 3])
        return { data: arr }
      }
    }),
  }
})

import { createLocalEmbeddingProvider } from '../src/utils/embeddings'
import { pipeline } from '@xenova/transformers'

function l2normLength(v: Float32Array): number {
  const s = v.reduce((acc, x) => acc + x * x, 0)
  return Math.sqrt(s)
}

describe('createLocalEmbeddingProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('embeds text and normalizes vectors to unit length by default', async () => {
    const provider = await createLocalEmbeddingProvider()
    const vec = await provider.embed('abc')
    expect(Array.isArray(Array.from(vec))).toBe(true)
    const len = l2normLength(vec)
    // allow small tolerance; should be ~1
    expect(len).toBeGreaterThan(0.999)
    expect(len).toBeLessThan(1.001)
    expect(provider.dimension).toBe(vec.length)
    expect(pipeline).toHaveBeenCalledWith('feature-extraction', 'Xenova/all-MiniLM-L6-v2', undefined)
  })

  it('respects custom model and revision options', async () => {
    const provider = await createLocalEmbeddingProvider({ model: 'custom/model', revision: 'v1' })
    await provider.embed('x')
    expect(pipeline).toHaveBeenCalledWith('feature-extraction', 'custom/model', { revision: 'v1' })
  })

  it('handles array-shaped outputs without .data field', async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => {
      return [[1, 2, 3]]
    })
    const provider = await createLocalEmbeddingProvider()
    const vec = await provider.embed('x')
    expect(vec.length).toBe(3)
    const len = l2normLength(vec)
    expect(len).toBeGreaterThan(0.999)
    expect(len).toBeLessThan(1.001)
  })
})
