import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock transformers pipeline. Default extractor returns a simple Float32Array.
vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn(async () => async (_text: string) => ({ data: new Float32Array([1, 2, 3]) })),
}))

import { createLocalEmbeddingProvider } from '../src/utils/embeddings'
import { pipeline } from '@xenova/transformers'

function l2normLength(v: Float32Array): number {
  return Math.sqrt(v.reduce((acc, x) => acc + x * x, 0))
}

describe('embeddings additional branches', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('handles object output with index 0 containing an array (output?.[0] path)', async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => ({ 0: [1, 2, 3] }))

    const provider = await createLocalEmbeddingProvider()
    const vec = await provider.embed('x')
    expect(vec.length).toBe(3)
    const len = l2normLength(vec)
    expect(len).toBeGreaterThan(0.999)
    expect(len).toBeLessThan(1.001)
  })

  it("handles tensor-like output with to('cpu') returning an array (Array.isArray(maybe) true path)", async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => ({ to: (_loc: string) => [1, 2, 3] }))

    const provider = await createLocalEmbeddingProvider()
    const vec = await provider.embed('y')
    expect(Array.from(vec)).toHaveLength(3)
    const len = l2normLength(vec)
    expect(len).toBeGreaterThan(0.999)
    expect(len).toBeLessThan(1.001)
  })

  it("handles tensor-like output with to('cpu') returning an object with data (Array.isArray(maybe) false path)", async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => ({ to: (_loc: string) => ({ data: new Float32Array([1, 2, 3]) }) }))

    const provider = await createLocalEmbeddingProvider()
    const vec = await provider.embed('z')
    expect(Array.from(vec)).toEqual(expect.arrayContaining([expect.any(Number)]))
    const len = l2normLength(vec)
    expect(len).toBeGreaterThan(0.999)
    expect(len).toBeLessThan(1.001)
  })
})
