import { EventEmitter } from 'node:events'

import { pipeline } from '@xenova/transformers'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  createInProcessEmbeddingProvider,
  createWorkerEmbeddingProvider,
  EMBEDDING_WORKER_CLOSE_GRACE_MS,
  runEmbeddingWorker,
  type EmbeddingProvider,
  type EmbeddingWorkerChannel,
  type EmbeddingWorkerPort,
  type EmbeddingWorkerRequest,
  type EmbeddingWorkerResponse,
} from '../src/utils/embeddings'

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

function l2normLength(v: Float32Array): number {
  const s = v.reduce((acc, x) => acc + x * x, 0)
  return Math.sqrt(s)
}

describe('createInProcessEmbeddingProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('embeds text and normalizes vectors to unit length by default', async () => {
    const provider = await createInProcessEmbeddingProvider()
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
    const provider = await createInProcessEmbeddingProvider({
      model: 'custom/model',
      revision: 'v1',
    })
    await provider.embed('x')
    expect(pipeline).toHaveBeenCalledWith('feature-extraction', 'custom/model', { revision: 'v1' })
  })

  it('normalize: false returns non-unit vector', async () => {
    // Force a deterministic non-unit vector
    ;(pipeline as any).mockResolvedValueOnce(async () => ({ data: new Float32Array([3, 4, 0]) }))
    const provider = await createInProcessEmbeddingProvider({ normalize: false })
    const v = await provider.embed('anything')
    const norm = Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0))
    expect(norm).not.toBeCloseTo(1, 3)
  })

  it('handles array-shaped outputs without .data field', async () => {
    ;(pipeline as any).mockResolvedValueOnce(() => [[1, 2, 3]])
    const provider = await createInProcessEmbeddingProvider()
    const vec = await provider.embed('x')
    expect(vec.length).toBe(3)
    const len = l2normLength(vec)
    expect(len).toBeGreaterThan(0.999)
    expect(len).toBeLessThan(1.001)
  })

  it('handles flat array-shaped outputs', async () => {
    ;(pipeline as any).mockResolvedValueOnce(() => [1, 2, 3])
    const provider = await createInProcessEmbeddingProvider()
    const vec = await provider.embed('x')
    expect(vec.length).toBe(3)
    const len = l2normLength(vec)
    expect(len).toBeGreaterThan(0.999)
    expect(len).toBeLessThan(1.001)
  })

  it('handles object output with index 0 containing an array (output?.[0] path)', async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => ({ 0: [1, 2, 3] }))

    const provider = await createInProcessEmbeddingProvider()
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
    const provider = await createInProcessEmbeddingProvider()
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

    const provider = await createInProcessEmbeddingProvider()
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

    const provider = await createInProcessEmbeddingProvider()
    const vec = await provider.embed('z')
    expect(Array.from(vec)).toEqual(expect.arrayContaining([expect.any(Number)]))
    const len = l2normLength(vec)
    expect(len).toBeGreaterThan(0.999)
    expect(len).toBeLessThan(1.001)
  })

  it('embedAsync handles output with data as a number array', async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => ({ data: [1, 2, 3] }))
    const provider = await createInProcessEmbeddingProvider({ normalize: false })
    const vec = await provider.embed('a')
    expect(Array.from(vec)).toEqual([1, 2, 3])
  })

  it('embedAsync handles output with data as a Float32Array', async () => {
    ;(pipeline as any).mockResolvedValueOnce(async () => ({ data: new Float32Array([1, 2, 3]) }))
    const provider = await createInProcessEmbeddingProvider({ normalize: false })
    const vec = await provider.embed('a')
    expect(Array.from(vec)).toEqual([1, 2, 3])
  })

  describe('embedBatch', () => {
    it('embeds a batch of texts using nested array output', async () => {
      const provider = await createInProcessEmbeddingProvider()
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
      const provider = await createInProcessEmbeddingProvider()
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
      const provider = await createInProcessEmbeddingProvider({ normalize: false })
      const vecs = await provider.embedBatch(['a', 'bb'])
      expect(vecs).toHaveLength(2)
      expect(Array.from(vecs[0])).toEqual([1, 2, 3])
      expect(Array.from(vecs[1])).toEqual([2, 3, 4])
    })

    it('handles an empty array', async () => {
      const provider = await createInProcessEmbeddingProvider()
      const vecs = await provider.embedBatch([])
      expect(vecs.length).toBe(0)
    })

    it('throws an error for unsupported batch output format', async () => {
      // Return a flat array, which is not a valid batch output
      ;(pipeline as any).mockResolvedValueOnce(() => [1, 2, 3])
      const provider = await createInProcessEmbeddingProvider()
      const texts = ['a', 'b']
      await expect(provider.embedBatch(texts)).rejects.toThrow(
        /Unsupported embedding output format for batch/,
      )
    })

    it('throws if model returns null or undefined output', async () => {
      ;(pipeline as any).mockResolvedValueOnce(async () => null)
      const provider = await createInProcessEmbeddingProvider()
      await expect(provider.embedBatch(['a'])).rejects.toThrow(
        'Embedding failed: received null or undefined output from model.',
      )
    })

    it('throws on unsupported output format (e.g. object without length)', async () => {
      ;(pipeline as any).mockResolvedValueOnce(async () => ({}))
      const provider = await createInProcessEmbeddingProvider()
      await expect(provider.embedBatch(['a'])).rejects.toThrow(
        /Unsupported embedding output format for batch.*length=n\/a/,
      )
    })

    it('throws on unsupported tensor shape', async () => {
      ;(pipeline as any).mockResolvedValueOnce(async () => ({ dims: [1, 2, 3], data: [1] }))
      const provider = await createInProcessEmbeddingProvider()
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

      const provider = await createInProcessEmbeddingProvider()
      await provider.embed('some text') // initialize
      await provider.close()

      expect(disposeMock).toHaveBeenCalledTimes(1)
    })

    it('does nothing if the pipeline was never created', async () => {
      const provider = await createInProcessEmbeddingProvider()
      // We don't call embed, so pipeline is not initialized
      await provider.close()
      // No mocks to check, just ensuring no errors are thrown
    })

    it('does not throw if dispose method is missing', async () => {
      // Mock pipeline without a dispose method
      ;(pipeline as any).mockResolvedValueOnce(async () => ({ data: new Float32Array([1, 2, 3]) }))

      const provider = await createInProcessEmbeddingProvider()
      await provider.embed('some text')
      await expect(provider.close()).resolves.toBeUndefined()
    })

    it('handles errors during dispose gracefully', async () => {
      const disposeMock = vi.fn().mockRejectedValue(new Error('Disposal failed'))
      const extractor = async () => ({ data: new Float32Array([1, 2, 3]) })
      ;(extractor as any).dispose = disposeMock
      ;(pipeline as any).mockResolvedValueOnce(extractor)

      const provider = await createInProcessEmbeddingProvider()
      await provider.embed('some text')
      await expect(provider.close()).resolves.toBeUndefined()
    })

    it('unwrapOutput breaks out of a function that throws', async () => {
      const errorThrower = () => {
        throw new Error('ops')
      }
      ;(pipeline as any).mockResolvedValueOnce(async () => errorThrower)
      const provider = await createInProcessEmbeddingProvider()
      // It should not throw inside unwrapOutput, but return the function
      // Then embedAsync will fail to process it, and create an empty (length 0) Float32Array
      const vec = await provider.embed('a')
      expect(vec.length).toBe(0)
    })
  })
})

type EmbedRequest = Extract<EmbeddingWorkerRequest, { kind: 'embed' }>

/** A stand-in worker thread: records requests and lets each test answer them. */
class FakeWorker extends EventEmitter implements EmbeddingWorkerPort {
  requests: EmbedRequest[] = []
  closeAsked = false
  ref = vi.fn()
  unref = vi.fn()
  terminate = vi.fn(async () => 0)
  postMessage(request: EmbeddingWorkerRequest) {
    if (request.kind === 'close') this.closeAsked = true
    else this.requests.push(request)
  }
  reply(request: EmbedRequest, vectors: number[][]) {
    this.emit('message', { id: request.id, vectors: vectors.map((v) => new Float32Array(v)) })
  }
}

function workerProvider() {
  const workers: FakeWorker[] = []
  const spawn = vi.fn(() => {
    const w = new FakeWorker()
    workers.push(w)
    return w
  })
  const provider = createWorkerEmbeddingProvider(spawn, 'test-model')
  return { provider, spawn, workers }
}

const values = (v: Float32Array) => Array.from(v)

describe('createWorkerEmbeddingProvider', () => {
  it('starts no worker until the first embedding is asked for', async () => {
    const { provider, spawn } = workerProvider()
    await provider.embedBatch([])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('carries the name it was given', () => {
    expect(workerProvider().provider.name).toBe('test-model')
  })

  it('reports the default dimension before any embedding', () => {
    expect(workerProvider().provider.dimension).toBe(384)
  })

  it('sends one text as a request of one text', async () => {
    const { provider, workers } = workerProvider()
    void provider.embed('hello')
    expect(workers[0].requests).toEqual([{ kind: 'embed', id: 1, texts: ['hello'] }])
  })

  it('resolves embed with the vector the worker returns', async () => {
    const { provider, workers } = workerProvider()
    const pending = provider.embed('hello')
    workers[0].reply(workers[0].requests[0], [[0.6, 0.8]])
    expect(values(await pending)).toEqual([expect.closeTo(0.6), expect.closeTo(0.8)])
  })

  it('records the dimension of the vectors the worker returns', async () => {
    const { provider, workers } = workerProvider()
    const pending = provider.embed('hello')
    workers[0].reply(workers[0].requests[0], [[1, 2, 3, 4]])
    await pending
    expect(provider.dimension).toBe(4)
  })

  it('sends a batch in one request', async () => {
    const { provider, workers } = workerProvider()
    void provider.embedBatch(['a', 'b'])
    expect(workers[0].requests).toEqual([{ kind: 'embed', id: 1, texts: ['a', 'b'] }])
  })

  it('resolves a batch with every vector in order', async () => {
    const { provider, workers } = workerProvider()
    const pending = provider.embedBatch(['a', 'b'])
    workers[0].reply(workers[0].requests[0], [[1], [2]])
    expect((await pending).map(values)).toEqual([[1], [2]])
  })

  it('sends each text to the worker whole, however long', async () => {
    const { provider, workers } = workerProvider()
    const long = 'x'.repeat(1_000_000)
    void provider.embedBatch([long, 'short'])
    expect(workers[0].requests[0].texts).toEqual([long, 'short'])
  })

  it('routes concurrent replies to their own callers by id', async () => {
    const { provider, workers } = workerProvider()
    const first = provider.embed('one')
    const second = provider.embed('two')
    const [worker] = workers
    worker.reply(worker.requests[1], [[2]])
    worker.reply(worker.requests[0], [[1]])
    expect([values(await first), values(await second)]).toEqual([[1], [2]])
  })

  it('rejects the call whose request the worker failed', async () => {
    const { provider, workers } = workerProvider()
    const failing = provider.embed('bad')
    workers[0].emit('message', { id: workers[0].requests[0].id, error: 'model exploded' })
    await expect(failing).rejects.toThrow('model exploded')
  })

  it('still resolves the other calls when one request fails', async () => {
    const { provider, workers } = workerProvider()
    void provider.embed('bad').catch(() => undefined)
    const fine = provider.embed('good')
    workers[0].emit('message', { id: workers[0].requests[0].id, error: 'model exploded' })
    workers[0].reply(workers[0].requests[1], [[1]])
    expect(values(await fine)).toEqual([1])
  })

  it('ignores a reply for a request it is not waiting on', async () => {
    const { provider, workers } = workerProvider()
    const pending = provider.embed('a')
    workers[0].emit('message', { id: 99, vectors: [new Float32Array([9])] })
    workers[0].reply(workers[0].requests[0], [[1]])
    expect(values(await pending)).toEqual([1])
  })

  it('holds the process open while a request is outstanding', () => {
    const { provider, workers } = workerProvider()
    void provider.embed('a')
    expect(workers[0].ref).toHaveBeenCalledTimes(1)
  })

  it('lets the process exit once no request is outstanding', async () => {
    const { provider, workers } = workerProvider()
    const pending = provider.embed('a')
    workers[0].reply(workers[0].requests[0], [[1]])
    await pending
    expect(workers[0].unref).toHaveBeenCalledTimes(1)
  })

  it('rejects outstanding calls with the error a crashing worker raised', async () => {
    const { provider, workers } = workerProvider()
    const pending = provider.embed('a')
    const crash = new Error('worker died')
    workers[0].emit('error', crash)
    await expect(pending).rejects.toBe(crash)
  })

  it('starts a fresh worker for the call after a crash', async () => {
    const { provider, workers } = workerProvider()
    void provider.embed('a').catch(() => undefined)
    workers[0].emit('error', new Error('worker died'))
    const next = provider.embed('b')
    workers[1].reply(workers[1].requests[0], [[3]])
    expect(values(await next)).toEqual([3])
  })

  it('rejects outstanding calls when the worker exits without answering', async () => {
    const { provider, workers } = workerProvider()
    const pending = provider.embed('a')
    workers[0].emit('exit', 1)
    await expect(pending).rejects.toThrow('embedding worker exited with code 1')
  })

  it('close rejects what is outstanding', async () => {
    const { provider } = workerProvider()
    const pending = provider.embed('a')
    void provider.close?.()
    await expect(pending).rejects.toThrow('embedding provider closed')
  })

  it('close asks the worker to exit instead of terminating it mid-inference', () => {
    const { provider, workers } = workerProvider()
    void provider.embed('a').catch(() => undefined)
    void provider.close?.()
    expect([workers[0].closeAsked, workers[0].terminate.mock.calls.length]).toEqual([true, 0])
  })

  it('close holds the process open until the worker has exited', () => {
    const { provider, workers } = workerProvider()
    void provider.embed('a').catch(() => undefined)
    void provider.close?.()
    expect(workers[0].ref).toHaveBeenCalledTimes(2)
  })

  it('close resolves once the worker exits', async () => {
    const { provider, workers } = workerProvider()
    void provider.embed('a').catch(() => undefined)
    const closing = provider.close?.()
    workers[0].emit('exit', 0)
    await expect(closing).resolves.toBeUndefined()
  })

  it('close terminates a worker that has not exited within the grace period', async () => {
    vi.useFakeTimers()
    try {
      const { provider, workers } = workerProvider()
      void provider.embed('a').catch(() => undefined)
      const closing = provider.close?.()
      await vi.advanceTimersByTimeAsync(EMBEDDING_WORKER_CLOSE_GRACE_MS)
      expect(workers[0].terminate).toHaveBeenCalledTimes(1)
      workers[0].emit('exit', 1)
      await closing
    } finally {
      vi.useRealTimers()
    }
  })

  it('a call after close starts a fresh worker', async () => {
    const { provider, workers } = workerProvider()
    void provider.embed('a').catch(() => undefined)
    const closing = provider.close?.()
    workers[0].emit('exit', 0)
    await closing
    const next = provider.embed('b')
    workers[1].reply(workers[1].requests[0], [[1]])
    expect(values(await next)).toEqual([1])
  })

  it('a closed worker exiting late does not fail calls made to its replacement', async () => {
    const { provider, workers } = workerProvider()
    void provider.embed('a').catch(() => undefined)
    void provider.close?.()
    const next = provider.embed('b')
    workers[0].emit('exit', 0)
    workers[1].reply(workers[1].requests[0], [[1]])
    expect(values(await next)).toEqual([1])
  })

  it('close before any embedding starts nothing', async () => {
    const { provider, spawn } = workerProvider()
    await provider.close?.()
    expect(spawn).not.toHaveBeenCalled()
  })
})

/** The worker thread's end of the channel: lets a test send requests and read the responses. */
class FakeChannel extends EventEmitter implements EmbeddingWorkerChannel {
  responses: EmbeddingWorkerResponse[] = []
  postMessage(response: EmbeddingWorkerResponse) {
    this.responses.push(response)
  }
  async send(request: EmbeddingWorkerRequest) {
    await Promise.all(this.listeners('message').map((listener) => listener(request)))
  }
}

function fakeModel(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    name: 'fake',
    dimension: 1,
    embed: vi.fn(async (text: string) => new Float32Array([text.length])),
    embedBatch: vi.fn(async (texts: string[]) => texts.map((t) => new Float32Array([t.length]))),
    close: vi.fn(async () => undefined),
    ...overrides,
  }
}

function workerLoop(model: Promise<EmbeddingProvider> = Promise.resolve(fakeModel())) {
  const channel = new FakeChannel()
  const exit = vi.fn()
  runEmbeddingWorker(channel, model, exit)
  return { channel, exit, model }
}

const vectorsOf = (response: EmbeddingWorkerResponse) => response.vectors?.map(values)

describe('runEmbeddingWorker', () => {
  it('answers a request of one text with the model’s single embedding', async () => {
    const model = fakeModel()
    const { channel } = workerLoop(Promise.resolve(model))
    await channel.send({ kind: 'embed', id: 7, texts: ['abc'] })
    expect([channel.responses.map(vectorsOf), vi.mocked(model.embedBatch).mock.calls]).toEqual([
      [[[3]]],
      [],
    ])
  })

  it('answers a request of several texts with the model’s batch embedding', async () => {
    const { channel } = workerLoop()
    await channel.send({ kind: 'embed', id: 7, texts: ['a', 'bb'] })
    expect(channel.responses.map((r) => [r.id, vectorsOf(r)])).toEqual([[7, [[1], [2]]]])
  })

  it('answers with the message of the error that stopped the model', async () => {
    const model = fakeModel({ embed: async () => Promise.reject(new Error('out of memory')) })
    const { channel } = workerLoop(Promise.resolve(model))
    await channel.send({ kind: 'embed', id: 1, texts: ['a'] })
    expect(channel.responses).toEqual([{ id: 1, error: 'out of memory' }])
  })

  it('answers with whatever was thrown when it is not an Error', async () => {
    const model = fakeModel({ embed: async () => Promise.reject('no model file') })
    const { channel } = workerLoop(Promise.resolve(model))
    await channel.send({ kind: 'embed', id: 1, texts: ['a'] })
    expect(channel.responses).toEqual([{ id: 1, error: 'no model file' }])
  })

  it('answers with the error when the model failed to load', async () => {
    const { channel } = workerLoop(Promise.reject(new Error('download failed')))
    await channel.send({ kind: 'embed', id: 1, texts: ['a'] })
    expect(channel.responses).toEqual([{ id: 1, error: 'download failed' }])
  })

  it('on close while idle releases the model, then exits', async () => {
    const model = fakeModel()
    const { channel, exit } = workerLoop(Promise.resolve(model))
    await channel.send({ kind: 'close' })
    expect(vi.mocked(model.close!).mock.invocationCallOrder[0]).toBeLessThan(
      exit.mock.invocationCallOrder[0],
    )
  })

  it('on close exits even when the model failed to load', async () => {
    const { channel, exit } = workerLoop(Promise.reject(new Error('download failed')))
    await channel.send({ kind: 'close' })
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('on close lets a running request finish and answer before exiting', async () => {
    let finish: (v: Float32Array) => void = () => undefined
    const model = fakeModel({ embed: () => new Promise<Float32Array>((r) => (finish = r)) })
    const { channel, exit } = workerLoop(Promise.resolve(model))
    const running = channel.send({ kind: 'embed', id: 1, texts: ['a'] })
    await channel.send({ kind: 'close' })
    expect(exit).not.toHaveBeenCalled()
    finish(new Float32Array([5]))
    await running
    expect([channel.responses.map(vectorsOf), exit.mock.calls.length]).toEqual([[[[5]]], 1])
  })

  it('drops requests that arrive after close', async () => {
    const { channel } = workerLoop()
    await channel.send({ kind: 'close' })
    await channel.send({ kind: 'embed', id: 2, texts: ['late'] })
    expect(channel.responses).toEqual([])
  })
})
