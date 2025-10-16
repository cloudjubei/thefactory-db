import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock transformers pipeline
vi.mock('@xenova/transformers', () => {
  return {
    pipeline: vi.fn(async () => {
      // return an async extractor function
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
    expect(pipeline).toHaveBeenCalledWith('feature-extraction', 'Xenova/all-MiniLM-L6-v2', undefined)
  })

  it('respects custom model and revision options', async () => {
    const provider = await createLocalEmbeddingProvider({ model: 'custom/model', revision: 'v1' })
    await provider.embed('x')
    expect(pipeline).toHaveBeenCalledWith('feature-extraction', 'custom/model', { revision: 'v1' })
  })

  it('handles array-shaped outputs without .data field', async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => {
      return () => [[1, 2, 3]]
    })
    const provider = await createLocalEmbeddingProvider()
    const vec = await provider.embed('x')
    expect(vec.length).toBe(3)
    const len = l2normLength(vec)
    expect(len).toBeGreaterThan(0.999)
    expect(len).toBeLessThan(1.001)
  })

  it('handles tensor-like output with a .to() method', async () => {
    const toMock = vi.fn(() => ({ data: [4, 5, 6] }))
    ;(pipeline as any).mockResolvedValueOnce(async () => {
      return () => ({
        to: toMock,
      })
    })
    const provider = await createLocalEmbeddingProvider()
    const vec = await provider.embed('x')
    expect(toMock).toHaveBeenCalledWith('cpu')
    expect(vec).toEqual(expect.any(Float32Array))
    expect(vec.length).toBe(3)
    const len = l2normLength(vec)
    expect(len).toBeGreaterThan(0.999)
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
      ;(pipeline as any).mockResolvedValueOnce(async () => {
        return (texts: string[]) => {
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
        }
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

    it('handles an empty array', async () => {
      const provider = await createLocalEmbeddingProvider()
      const vecs = await provider.embedBatch([])
      expect(vecs.length).toBe(0)
    })

    it('throws an error for unsupported batch output format', async () => {
      ;(pipeline as any).mockResolvedValueOnce(async () => {
        // Return a flat array, which is not a valid batch output
        return () => [1, 2, 3]
      })
      const provider = await createLocalEmbeddingProvider()
      const texts = ['a', 'b']
      await expect(provider.embedBatch(texts)).rejects.toThrow(
        /Unsupported embedding output format for batch/,
      )
    })
  })

  describe('close', () => {
    it('disposes the pipeline instance after it has been used', async () => {
      const disposeMock = vi.fn()
      ;(pipeline as any).mockResolvedValueOnce(async () => {
        const extractor = async () => ({ data: new Float32Array([1, 2, 3]) })
        ;(extractor as any).dispose = disposeMock
        return extractor
      })

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
      ;(pipeline as any).mockResolvedValueOnce(async () => {
        return async () => ({ data: new Float32Array([1, 2, 3]) })
      })

      const provider = await createLocalEmbeddingProvider()
      await provider.embed('some text')
      await expect(provider.close()).resolves.not.toThrow()
    })

    it('handles errors during dispose gracefully', async () => {
      const disposeMock = vi.fn().mockRejectedValue(new Error('Disposal failed'))
      ;(pipeline as any).mockResolvedValueOnce(async () => {
        const extractor = async () => ({ data: new Float32Array([1, 2, 3]) })
        ;(extractor as any).dispose = disposeMock
        return extractor
      })

      const provider = await createLocalEmbeddingProvider()
      await provider.embed('some text')
      await expect(provider.close()).resolves.not.toThrow()
    })
  })
})
