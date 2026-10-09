import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

/** Turns text into vectors. `name` identifies the model, so vectors of different models never mix. */
export interface EmbeddingProvider {
  readonly name: string
  /** Vector length; the model's default until the first embedding reports the real one. */
  readonly dimension: number
  embed(text: string): Promise<Float32Array> | Float32Array
  embedBatch(texts: string[]): Promise<Float32Array[]>
  /** Releases the model (and any thread it runs on). */
  close?: () => Promise<void> | void
}

/** Options for the Transformers.js sentence-embedding model. */
export type LocalEmbeddingOptions = {
  /** Preconverted ONNX model id; default `Xenova/all-MiniLM-L6-v2`. */
  model?: string
  /** Model revision. */
  revision?: string
  /** L2-normalise output vectors; default true. */
  normalize?: boolean
  /** Configure the Transformers.js env to avoid caches and extra threads; default true. */
  configureEnv?: boolean
}

const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
const DEFAULT_EMBEDDING_DIMENSION = 384
const EMBEDDING_WORKER_ROLE = 'thefactory-db-embedding-worker'

/**
 * A message to the worker thread: embed `texts` (a single text is `texts` of length one), or finish
 * what is running, release the model and exit.
 */
export type EmbeddingWorkerRequest =
  | { kind: 'embed'; id: number; texts: string[] }
  | { kind: 'close' }

/**
 * How long `close` waits for the worker to finish its inference and exit before terminating it.
 * Terminating a worker mid-inference aborts the whole process (onnxruntime-node throws out of a
 * dying environment), so this only fires for a worker that hangs.
 */
export const EMBEDDING_WORKER_CLOSE_GRACE_MS = 30_000

/** The worker thread's answer to one request: its vectors, or why it failed. */
export type EmbeddingWorkerResponse = { id: number; vectors?: Float32Array[]; error?: string }

/** The worker thread's side of the channel: requests arrive on it and responses leave through it. */
export type EmbeddingWorkerChannel = {
  on(event: 'message', listener: (request: EmbeddingWorkerRequest) => void): unknown
  postMessage(response: EmbeddingWorkerResponse): void
}

/** The part of a `Worker` the provider uses, so tests can stand one in. */
export type EmbeddingWorkerPort = {
  postMessage(request: EmbeddingWorkerRequest): void
  on(event: 'message', listener: (response: EmbeddingWorkerResponse) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  ref(): void
  unref(): void
  terminate(): Promise<number>
}

/**
 * The default provider: the model runs in a worker thread. Inference is synchronous CPU work (about
 * 60 ms per document) that, on the caller's thread, stalled a server's event loop for 7 s per batch
 * of 100 documents. The worker starts on the first embedding, not on creation.
 */
export async function createLocalEmbeddingProvider(
  options?: LocalEmbeddingOptions,
): Promise<EmbeddingProvider> {
  const model = options?.model ?? DEFAULT_EMBEDDING_MODEL
  return createWorkerEmbeddingProvider(
    () =>
      new Worker(new URL(import.meta.url), {
        workerData: { role: EMBEDDING_WORKER_ROLE, options: options ?? {} },
      }),
    `transformersjs-${model}`,
  )
}

/**
 * An embedding provider whose model runs behind `spawn`'s worker. The worker holds the process open only while
 * a request is outstanding; one that crashes or exits fails what it held and is replaced on the next call.
 */
export function createWorkerEmbeddingProvider(
  spawn: () => EmbeddingWorkerPort,
  name: string,
): EmbeddingProvider {
  type Pending = { resolve: (vectors: Float32Array[]) => void; reject: (err: Error) => void }
  const pending = new Map<number, Pending>()
  const exits = new Map<EmbeddingWorkerPort, Promise<void>>()
  let worker: EmbeddingWorkerPort | undefined
  let nextId = 1
  let dimension = DEFAULT_EMBEDDING_DIMENSION

  function failAll(current: EmbeddingWorkerPort, err: Error) {
    if (worker !== current) return
    worker = undefined
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }

  function settle(id: number, settleWith: (p: Pending) => void) {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (pending.size === 0) worker?.unref()
    settleWith(p)
  }

  function ensureWorker(): EmbeddingWorkerPort {
    if (worker) return worker
    const current = spawn()
    worker = current
    current.on('message', (response) =>
      settle(response.id, (p) =>
        response.error !== undefined
          ? p.reject(new Error(response.error))
          : p.resolve(response.vectors ?? []),
      ),
    )
    current.on('error', (err) => failAll(current, err))
    exits.set(
      current,
      new Promise<void>((resolve) =>
        current.on('exit', (code) => {
          exits.delete(current)
          failAll(current, new Error(`embedding worker exited with code ${code}`))
          resolve()
        }),
      ),
    )
    return current
  }

  function request(texts: string[]): Promise<Float32Array[]> {
    const target = ensureWorker()
    const id = nextId++
    return new Promise<Float32Array[]>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      if (pending.size === 1) target.ref()
      target.postMessage({ kind: 'embed', id, texts })
    }).then((vectors) => {
      if (vectors.length > 0) dimension = vectors[0].length
      return vectors
    })
  }

  return {
    name,
    get dimension() {
      return dimension
    },
    async embed(text: string): Promise<Float32Array> {
      const [vector] = await request([text])
      return vector
    },
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return []
      return request(texts)
    },
    /**
     * Rejects what is outstanding and asks the worker to finish its running inference, release the
     * model and exit, holding the process open until it has.
     */
    async close() {
      const current = worker
      if (!current) return
      const exited = exits.get(current)
      failAll(current, new Error('embedding provider closed'))
      current.ref()
      current.postMessage({ kind: 'close' })
      const hung = setTimeout(() => void current.terminate(), EMBEDDING_WORKER_CLOSE_GRACE_MS)
      await exited
      clearTimeout(hung)
    },
  }
}

/**
 * The worker thread's loop: answers each embed request with `provider`'s vectors (or the error that
 * stopped them), and on `close` lets running requests finish, releases the model, then calls `exit`.
 * Requests that arrive after `close` are dropped; the client has already rejected them. A model that
 * failed to load has nothing to release, and each request already reported why it failed.
 */
export function runEmbeddingWorker(
  port: EmbeddingWorkerChannel,
  provider: Promise<EmbeddingProvider>,
  exit: () => void,
): void {
  let running = 0
  let closing = false
  const exitWhenIdle = async () => {
    if (!closing || running > 0) return
    const loaded = await provider.catch(() => undefined)
    try {
      await loaded?.close?.()
    } finally {
      exit()
    }
  }
  port.on('message', async (req) => {
    if (req.kind === 'close') {
      closing = true
      await exitWhenIdle()
      return
    }
    if (closing) return
    running++
    try {
      const p = await provider
      const vectors =
        req.texts.length === 1 ? [await p.embed(req.texts[0])] : await p.embedBatch(req.texts)
      port.postMessage({ id: req.id, vectors })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      port.postMessage({ id: req.id, error })
    } finally {
      running--
      await exitWhenIdle()
    }
  })
}

/**
 * A Transformers.js sentence-embedding provider on the calling thread (mean pooling, L2 norm). It runs
 * inside the worker `createLocalEmbeddingProvider` starts. Do not also use it on a thread of a process
 * whose embedding workers come and go: onnxruntime-node loaded on both sides makes V8 abort the process
 * when a worker exits (array_buffer_allocator check).
 */
export async function createInProcessEmbeddingProvider(
  options?: LocalEmbeddingOptions,
): Promise<EmbeddingProvider> {
  const { pipeline, env } = await import('@xenova/transformers')
  const model = options?.model ?? DEFAULT_EMBEDDING_MODEL
  const revision = options?.revision
  const normalize = options?.normalize ?? true
  const configureEnv = options?.configureEnv ?? true

  // Conservative env configuration to minimize background workers and external caching side-effects in tests/CI
  if (configureEnv) {
    try {
      // Avoid persisting caches in browsers; in Node this is a no-op but safe
      env.useBrowserCache = false
      // Prefer local cache and prevent unexpected remote calls if possible in CI
      env.allowLocalModels = true
      // Reduce thread usage to 1 to limit background worker creation
      env.backends = env.backends ?? {}
      env.backends.onnx = env.backends.onnx ?? {}
      env.backends.onnx.wasm = env.backends.onnx.wasm ?? {}
      // Force wasm to run in-process and not via a proxy worker to avoid lingering worker threads in Node
      env.backends.onnx.wasm.proxy = false
      env.backends.onnx.wasm.numThreads = 1
    } catch {
      // best-effort; ignore if newer/older transformers.js differs
    }
  }

  // Lazy pipeline init shared across calls
  let ready: ReturnType<typeof pipeline<'feature-extraction'>> | null = null
  let extractorInstance: any | null = null

  async function getExtractor() {
    if (!ready) {
      // Only pass options if revision is explicitly provided to preserve test expectations
      const pipelineOptions: any = revision ? { revision } : undefined
      ready = pipeline('feature-extraction', model, pipelineOptions)
      extractorInstance = await ready
    }
    return extractorInstance ?? (await ready)
  }

  function l2norm(v: Float32Array): Float32Array {
    let sum = 0
    for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
    const n = Math.sqrt(sum) || 1
    if (n !== 0 && n !== 1) {
      for (let i = 0; i < v.length; i++) v[i] = v[i] / n
    }
    return v
  }

  // Some backends (and tests) may return functions which, when called, yield the real value.
  // This helper unwraps such layers.
  function unwrapOutput(output: any, textsForBatch?: string[]): any {
    let out = output
    // Limit unwrapping depth to avoid infinite recursion in case of pathological outputs
    let depth = 0
    while (typeof out === 'function' && depth < 5) {
      try {
        // Prefer passing texts for batch if the function expects parameters
        if (textsForBatch && out.length > 0) {
          out = out(textsForBatch)
        } else {
          out = out()
        }
      } catch {
        // If calling fails, break to avoid throwing here; the caller will handle type checks
        break
      }
      depth++
    }
    return out
  }

  async function embedAsync(text: string): Promise<Float32Array> {
    const extractor = await getExtractor()
    const raw: any = await extractor(text, { pooling: 'mean', normalize: false })
    const output: any = unwrapOutput(raw)

    // output is either a TypedArray or nested array depending on backend; use .data if available
    let data: Float32Array
    if (output?.data instanceof Float32Array) {
      data = output.data as Float32Array
    } else if (Array.isArray(output)) {
      // Flatten any nested structure to a 1D vector
      const arr = (output as any[]).flat(Infinity) as number[]
      data = new Float32Array(arr)
    } else if (Array.isArray(output?.[0])) {
      const arr = (output[0] as number[]).flat(Infinity as any) as number[]
      data = new Float32Array(arr)
    } else if (output && (output.data instanceof Float32Array || Array.isArray(output.data))) {
      const arr: Iterable<number> = Array.isArray(output.data)
        ? (output.data as number[])
        : Array.from(output.data)
      data = new Float32Array(arr)
    } else {
      // Try to access tensor-like shape
      const maybe = output?.to && typeof output.to === 'function' ? output.to('cpu') : output
      const arr: number[] = Array.isArray(maybe)
        ? (maybe as number[])
        : Array.from(maybe?.data ?? [])
      data = new Float32Array(arr)
    }
    return normalize ? l2norm(data) : data
  }

  async function embedBatchAsync(texts: string[]): Promise<Float32Array[]> {
    const extractor = await getExtractor()
    const raw: any = await extractor(texts, { pooling: 'mean', normalize: false })
    const output: any = unwrapOutput(raw, texts)

    if (!output) {
      throw new Error('Embedding failed: received null or undefined output from model.')
    }

    // Handle Tensor-like output (e.g. from transformers.js node backend)
    // It has dims=[batch_size, model_dim] and a flat data array
    if (output.dims && output.data && output.dims.length === 2) {
      const batchSize = output.dims[0]
      const embeddingDim = output.dims[1]
      const embeddings: Float32Array[] = []

      for (let i = 0; i < batchSize; i++) {
        const start = i * embeddingDim
        const end = start + embeddingDim
        let embedding: Float32Array = new Float32Array(
          (output.data as Float32Array | number[]).slice(start, end),
        )
        if (normalize) {
          embedding = l2norm(embedding)
        }
        embeddings.push(embedding)
      }
      return embeddings
    }

    // Handle nested array output (e.g. from mock or some backends)
    if (Array.isArray(output) && output.length > 0 && Array.isArray(output[0])) {
      return (output as number[][]).map((row: number[]) => {
        let embedding: Float32Array = new Float32Array(row)
        if (normalize) {
          embedding = l2norm(embedding)
        }
        return embedding
      })
    }

    const outputType = Array.isArray(output) ? 'array' : typeof output
    const outputShape = output?.dims
      ? `dims=${JSON.stringify(output.dims)}`
      : `length=${output?.length ?? 'n/a'}`
    const message = `Unsupported embedding output format for batch. Expected a 2D Tensor or a nested array. Got ${outputType} with ${outputShape}.`
    throw new Error(message)
  }

  // Dimension is not known synchronously until first run. Expose common default of MiniLM (384).
  // Consumers can read provider.dimension after first embed if they need exact size.
  let dimension = DEFAULT_EMBEDDING_DIMENSION
  const provider: EmbeddingProvider = {
    name: `transformersjs-${model}`,
    get dimension() {
      return dimension
    },
    async embed(text: string): Promise<Float32Array> {
      const vec = await embedAsync(text)
      dimension = vec.length
      return vec
    },
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (!texts || texts.length === 0) return []
      const vecs = await embedBatchAsync(texts)
      if (vecs.length > 0) {
        dimension = vecs[0].length
      }
      return vecs
    },
    async close() {
      try {
        const inst = extractorInstance ?? (ready ? await ready : null)

        if (inst && typeof inst.dispose === 'function') {
          await inst.dispose()
        }
      } catch {
      } finally {
        ready = null
        extractorInstance = null
      }
    },
  }

  return provider
}

if (
  !isMainThread &&
  parentPort &&
  (workerData as { role?: string } | null)?.role === EMBEDDING_WORKER_ROLE
) {
  const { options } = workerData as { options: LocalEmbeddingOptions }
  runEmbeddingWorker(parentPort, createInProcessEmbeddingProvider(options), () => process.exit(0))
}
