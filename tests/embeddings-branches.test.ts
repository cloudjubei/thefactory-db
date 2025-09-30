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
    ;(pipeline as any).mockResolvedValueOnce(async () => () => ({ 0: [1, 2, 3] }))

    const provider = await createLocalEmbeddingProvider()
    const vec = await provider.embed('x')
    expect(vec.length).toBe(3)
    const len = l2normLength(vec)
    expect(len).toBeGreaterThan(0.999)
    expect(len).toBeLessThan(1.001)
  })

  it("handles tensor-like output with to('cpu') returning an array (Array.isArray(maybe) true path)", async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => () => ({ to: (_loc: string) => [1, 2, 3] }))

    const provider = await createLocalEmbeddingProvider()
    const vec = await provider.embed('y')
    expect(Array.from(vec)).toHaveLength(3)
    const len = l2normLength(vec)
    expect(len).toBeGreaterThan(0.999)
    expect(len).toBeLessThan(1.001)
  })

  it("handles tensor-like output with to('cpu') returning an object with data (Array.isArray(maybe) false path)", async () => {
    ;(pipeline as any).mockResolvedValueOnce(
      async () => () => ({ to: (_loc: string) => ({ data: new Float32Array([1, 2, 3]) }) }),
    )

    const provider = await createLocalEmbeddingProvider()
    const vec = await provider.embed('z')
    expect(Array.from(vec)).toEqual(expect.arrayContaining([expect.any(Number)]))
    const len = l2normLength(vec)
    expect(len).toBeGreaterThan(0.999)
    expect(len).toBeLessThan(1.001)
  })

  it('unwrapOutput handles function that expects batch texts', async () => {
    const extractorFn = (texts: string[]) => {
      return texts.map((t) => [t.length, t.length + 1, t.length + 2])
    }
    ;(pipeline as any).mockResolvedValueOnce(async () => () => extractorFn)
    const provider = await createLocalEmbeddingProvider({ normalize: false })
    const vecs = await provider.embedBatch(['a', 'bb'])
    expect(vecs).toHaveLength(2)
    expect(Array.from(vecs[0])).toEqual([1, 2, 3])
    expect(Array.from(vecs[1])).toEqual([2, 3, 4])
  })

  it('embedAsync handles output with data as a number array', async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => () => ({ data: [1, 2, 3] }))
    const provider = await createLocalEmbeddingProvider({ normalize: false })
    const vec = await provider.embed('a')
    expect(Array.from(vec)).toEqual([1, 2, 3])
  })

  it('embedAsync handles output with data as a Float32Array', async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => () => ({ data: new Float32Array([1, 2, 3]) }))
    const provider = await createLocalEmbeddingProvider({ normalize: false })
    const vec = await provider.embed('a')
    expect(Array.from(vec)).toEqual([1, 2, 3])
  })

  it('embedBatchAsync throws if model returns null or undefined output', async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => () => null)
    const provider = await createLocalEmbeddingProvider()
    await expect(provider.embedBatch(['a'])).rejects.toThrow(
      'Embedding failed: received null or undefined output from model.',
    )
  })

  it('embedBatchAsync throws on unsupported output format (e.g. flat array)', async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => () => [1, 2, 3])
    const provider = await createLocalEmbeddingProvider()
    await expect(provider.embedBatch(['a'])).rejects.toThrow(
      /Unsupported embedding output format for batch/,
    )
  })

  it('embedBatchAsync throws on unsupported output format (e.g. object without length)', async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => () => ({}))
    const provider = await createLocalEmbeddingProvider()
    await expect(provider.embedBatch(['a'])).rejects.toThrow(
      /Unsupported embedding output format for batch.*length=n\/a/,
    )
  })

  it('embedBatchAsync throws on unsupported tensor shape', async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => () => ({ dims: [1, 2, 3], data: [1] }))
    const provider = await createLocalEmbeddingProvider()
    await expect(provider.embedBatch(['a'])).rejects.toThrow(
      /Unsupported embedding output format for batch.*dims=\[1,2,3\]/,
    )
  })

  it('unwrapOutput breaks out of a function that throws', async () => {
    const errorThrower = () => {
      throw new Error('ops')
    }
    ;(pipeline as any).mockResolvedValueOnce(async () => () => errorThrower)
    const provider = await createLocalEmbeddingProvider()
    // It should not throw inside unwrapOutput, but return the function
    // Then embedAsync will fail to process it, and create an empty (length 0) Float32Array
    const vec = await provider.embed('a')
    expect(vec.length).toBe(0)
  })
})
