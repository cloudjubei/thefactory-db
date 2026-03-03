import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Consolidated embeddings tests
 *
 * NOTE: `vi.mock()` is hoisted, so we keep a single transformers mock here and
 * override behavior per-test using `mockResolvedValueOnce`.
 */
vi.mock('@xenova/transformers', () => {
  return {
    pipeline: vi.fn(async () => {
      // Default extractor: supports single and batch.
      return async (text: string | string[], _opts?: any) => {
        if (Array.isArray(text)) {
          // BATCH MODE: return nested array
          return text.map((t) => {
            const a = t.length % 5
            return [a + 1, a + 2, a + 3]
          })
        }
        // SINGLE TEXT MODE
        const a = text.length % 5
        const arr = new Float32Array([a + 1, a + 2, a + 3])
        return { data: arr } // Return tensor-like for single embed
      }
    }),
    Tensor: class Tensor {
      dims: number[]
      data: Float32Array
      constructor(dims: number[], data: Float32Array) {
        this.dims = dims
        this.data = data
      }
    },
    env: {
      // mock env to avoid side-effects
      useBrowserCache: true,
      allowLocalModels: true,
      backends: {
        onnx: {
          wasm: {
            proxy: false,
            numThreads: 1,
          },
        },
      },
    },
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
    expect(pipeline).toHaveBeenCalledWith(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
      undefined,
    )
  })

  it('respects custom model and revision options', async () => {
    const provider = await createLocalEmbeddingProvider({ model: 'custom/model', revision: 'v1' })
    await provider.embed('x')
    expect(pipeline).toHaveBeenCalledWith('feature-extraction', 'custom/model', { revision: 'v1' })
  })

  it('normalize: false returns non-unit vector', async () => {
    // Force a deterministic non-unit vector
    ;(pipeline as any).mockResolvedValueOnce(async () => ({ data: new Float32Array([3, 4, 0]) }))
    const provider = await createLocalEmbeddingProvider({ normalize: false })
    const v = await provider.embed('anything')
    const norm = Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0))
    expect(norm).not.toBeCloseTo(1, 3)
  })

  it('handles array-shaped outputs without .data field', async () => {
    ;(pipeline as any).mockResolvedValueOnce(() => [[1, 2, 3]])
    const provider = await createLocalEmbeddingProvider()
    const vec = await provider.embed('x')
    expect(vec.length).toBe(3)
    const len = l2normLength(vec)
    expect(len).toBeGreaterThan(0.999)
    expect(len).toBeLessThan(1.001)
  })

  it('handles flat array-shaped outputs', async () => {
    ;(pipeline as any).mockResolvedValueOnce(() => [1, 2, 3])
    const provider = await createLocalEmbeddingProvider()
    const vec = await provider.embed('x')
    expect(vec.length).toBe(3)
    const len = l2normLength(vec)
    expect(len).toBeGreaterThan(0.999)
    expect(len).toBeLessThan(1.001)
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

  it('handles tensor-like output with a .to() method', async () => {
    const toMock = vi.fn(() => ({ data: [4, 5, 6] }))
    ;(pipeline as any).mockResolvedValueOnce(() => ({
      to: toMock,
    }))
    const provider = await createLocalEmbeddingProvider()
    const vec = await provider.embed('x')
    expect(toMock).toHaveBeenCalledWith('cpu')
    expect(vec).toEqual(expect.any(Float32Array))
    expect(vec.length).toBe(3)
    const len = l2normLength(vec)
    expect(len).toBeGreaterThan(0.999)
  })

  it("handles tensor-like output with to('cpu') returning an array (Array.isArray(maybe) true path)", async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => ({
      to: (_loc: string) => [1, 2, 3],
    }))

    const provider = await createLocalEmbeddingProvider()
    const vec = await provider.embed('y')
    expect(Array.from(vec)).toHaveLength(3)
    const len = l2normLength(vec)
    expect(len).toBeGreaterThan(0.999)
    expect(len).toBeLessThan(1.001)
  })

  it("handles tensor-like output with to('cpu') returning an object with data (Array.isArray(maybe) false path)", async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => ({
      to: (_loc: string) => ({ data: new Float32Array([1, 2, 3]) }),
    }))

    const provider = await createLocalEmbeddingProvider()
    const vec = await provider.embed('z')
    expect(Array.from(vec)).toEqual(expect.arrayContaining([expect.any(Number)]))
    const len = l2normLength(vec)
    expect(len).toBeGreaterThan(0.999)
    expect(len).toBeLessThan(1.001)
  })

  it('embedAsync handles output with data as a number array', async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => ({ data: [1, 2, 3] }))
    const provider = await createLocalEmbeddingProvider({ normalize: false })
    const vec = await provider.embed('a')
    expect(Array.from(vec)).toEqual([1, 2, 3])
  })

  it('embedAsync handles output with data as a Float32Array', async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => ({ data: new Float32Array([1, 2, 3]) }))
    const provider = await createLocalEmbeddingProvider({ normalize: false })
    const vec = await provider.embed('a')
    expect(Array.from(vec)).toEqual([1, 2, 3])
  })

  describe('embedBatch', () => {
    it('embeds a batch of texts using nested array output', async () => {
      const provider = await createLocalEmbeddingProvider()
      const texts = ['abc', 'defg']
      const vecs = await provider.embedBatch(texts)

      expect(vecs.length).toBe(2)
      expect(vecs[0].length).toBe(3)
      expect(vecs[1].length).toBe(3)

      const len1 = l2normLength(vecs[0])
      expect(len1).toBeGreaterThan(0.999)
      expect(len1).toBeLessThan(1.001)

      const len2 = l2normLength(vecs[1])
      expect(len2).toBeGreaterThan(0.999)
      expect(len2).toBeLessThan(1.001)

      expect(provider.dimension).toBe(3)
    })

    it('embeds a batch of texts using Tensor output', async () => {
      ;(pipeline as any).mockResolvedValueOnce((texts: string[]) => {
        const batchSize = texts.length
        const dim = 3
        const data = new Float32Array(batchSize * dim)
        for (let i = 0; i < batchSize; ++i) {
          const a = texts[i].length % 5
          data[i * dim + 0] = a + 1
          data[i * dim + 1] = a + 2
          data[i * dim + 2] = a + 3
        }
        return { dims: [batchSize, dim], data }
      })
      const provider = await createLocalEmbeddingProvider()
      const texts = ['a', 'bb', 'ccc']
      const vecs = await provider.embedBatch(texts)

      expect(vecs.length).toBe(3)
      expect(vecs[0].length).toBe(3)
      expect(vecs[1].length).toBe(3)
      expect(vecs[2].length).toBe(3)

      const len1 = l2normLength(vecs[0])
      expect(len1).toBeGreaterThan(0.999)

      expect(vecs[0][0]).not.toBe(vecs[1][0]) // check they are different embeddings
    })

    it('unwrapOutput handles function that expects batch texts', async () => {
      const extractorFn = (texts: string[]) => {
        return texts.map((t) => [t.length, t.length + 1, t.length + 2])
      }
      ;(pipeline as any).mockResolvedValueOnce(async () => extractorFn)
      const provider = await createLocalEmbeddingProvider({ normalize: false })
      const vecs = await provider.embedBatch(['a', 'bb'])
      expect(vecs).toHaveLength(2)
      expect(Array.from(vecs[0])).toEqual([1, 2, 3])
      expect(Array.from(vecs[1])).toEqual([2, 3, 4])
    })

    it('handles an empty array', async () => {
      const provider = await createLocalEmbeddingProvider()
      const vecs = await provider.embedBatch([])
      expect(vecs.length).toBe(0)
    })

    it('throws an error for unsupported batch output format', async () => {
      // Return a flat array, which is not a valid batch output
      ;(pipeline as any).mockResolvedValueOnce(() => [1, 2, 3])
      const provider = await createLocalEmbeddingProvider()
      const texts = ['a', 'b']
      await expect(provider.embedBatch(texts)).rejects.toThrow(
        /Unsupported embedding output format for batch/,
      )
    })

    it('throws if model returns null or undefined output', async () => {
      ;(pipeline as any).mockResolvedValueOnce(async () => null)
      const provider = await createLocalEmbeddingProvider()
      await expect(provider.embedBatch(['a'])).rejects.toThrow(
        'Embedding failed: received null or undefined output from model.',
      )
    })

    it('throws on unsupported output format (e.g. object without length)', async () => {
      ;(pipeline as any).mockResolvedValueOnce(async () => ({}))
      const provider = await createLocalEmbeddingProvider()
      await expect(provider.embedBatch(['a'])).rejects.toThrow(
        /Unsupported embedding output format for batch.*length=n\/a/,
      )
    })

    it('throws on unsupported tensor shape', async () => {
      ;(pipeline as any).mockResolvedValueOnce(async () => ({ dims: [1, 2, 3], data: [1] }))
      const provider = await createLocalEmbeddingProvider()
      await expect(provider.embedBatch(['a'])).rejects.toThrow(
        /Unsupported embedding output format for batch.*dims=\[1,2,3\]/,
      )
    })
  })

  describe('close', () => {
    it('disposes the pipeline instance after it has been used', async () => {
      const disposeMock = vi.fn()
      const extractor = async () => ({ data: new Float32Array([1, 2, 3]) })
      ;(extractor as any).dispose = disposeMock
      ;(pipeline as any).mockResolvedValueOnce(extractor)

      const provider = await createLocalEmbeddingProvider()
      await provider.embed('some text') // initialize
      await provider.close()

      expect(disposeMock).toHaveBeenCalledTimes(1)
    })

    it('does nothing if the pipeline was never created', async () => {
      const provider = await createLocalEmbeddingProvider()
      // We don't call embed, so pipeline is not initialized
      await provider.close()
      // No mocks to check, just ensuring no errors are thrown
    })

    it('does not throw if dispose method is missing', async () => {
      // Mock pipeline without a dispose method
      ;(pipeline as any).mockResolvedValueOnce(async () => ({ data: new Float32Array([1, 2, 3]) }))

      const provider = await createLocalEmbeddingProvider()
      await provider.embed('some text')
      await expect(provider.close()).resolves.toBeUndefined()
    })

    it('handles errors during dispose gracefully', async () => {
      const disposeMock = vi.fn().mockRejectedValue(new Error('Disposal failed'))
      const extractor = async () => ({ data: new Float32Array([1, 2, 3]) })
      ;(extractor as any).dispose = disposeMock
      ;(pipeline as any).mockResolvedValueOnce(extractor)

      const provider = await createLocalEmbeddingProvider()
      await provider.embed('some text')
      await expect(provider.close()).resolves.toBeUndefined()
    })

    it('unwrapOutput breaks out of a function that throws', async () => {
      const errorThrower = () => {
        throw new Error('ops')
      }
      ;(pipeline as any).mockResolvedValueOnce(async () => errorThrower)
      const provider = await createLocalEmbeddingProvider()
      // It should not throw inside unwrapOutput, but return the function
      // Then embedAsync will fail to process it, and create an empty (length 0) Float32Array
      const vec = await provider.embed('a')
      expect(vec.length).toBe(0)
    })
  })
})
