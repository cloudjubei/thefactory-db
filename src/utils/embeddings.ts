import { pipeline, env, Tensor } from '@xenova/transformers'

export interface EmbeddingProvider {
  readonly name: string
  readonly dimension: number
  embed(text: string): Promise<Float32Array> | Float32Array
  embedBatch(texts: string[]): Promise<Float32Array[]>
}

// Embedding provider using Transformers.js with a sentence embedding model
// Uses mean pooling over last hidden states and L2 normalization.
// Works in Node.js, browsers (including Next.js), Electron, and React Native (with proper backend configuration).
export async function createLocalEmbeddingProvider(options?: {
  model?: string // Preconverted ONNX model id, default: 'Xenova/all-MiniLM-L6-v2'
  revision?: string // Optional model revision
  normalize?: boolean // L2 normalize output (default true)
}): Promise<EmbeddingProvider> {
  const model = options?.model ?? 'Xenova/all-MiniLM-L6-v2'
  const revision = options?.revision
  const normalize = options?.normalize ?? true

  // Lazy pipeline init shared across calls
  let ready: ReturnType<typeof pipeline<'feature-extraction'>> | null = null

  async function getExtractor() {
    if (!ready) {
      // Only pass options if revision is explicitly provided to preserve test expectations
      const pipelineOptions: any = revision ? { revision } : undefined
      ready = pipeline('feature-extraction', model, pipelineOptions)
    }
    return ready
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

  async function embedAsync(text: string): Promise<Float32Array> {
    const extractor = await getExtractor()
    const output: any = await extractor(text, { pooling: 'mean', normalize: false })
    // output is either a TypedArray or nested array depending on backend; use .data if available
    let data: Float32Array
    if (output?.data instanceof Float32Array) {
      data = output.data as Float32Array
    } else if (Array.isArray(output)) {
      // Flatten first element (single input)
      const arr = output.flat(Infinity) as number[]
      data = new Float32Array(arr)
    } else if (Array.isArray(output?.[0])) {
      const arr = (output[0] as number[]).flat(Infinity as any) as number[]
      data = new Float32Array(arr)
    } else {
      // Try to access tensor
      const maybe = output?.to && typeof output.to === 'function' ? output.to('cpu') : output
      const arr: number[] = Array.isArray(maybe)
        ? (maybe as number[])
        : Array.from(maybe?.data ?? [])
      data = new Float32Array(arr)
    }
    return normalize ? l2norm(data) : data
  }

  async function embedBatchAsync(texts: string[]): Promise<Float32Array[]> {
    if (!texts || texts.length === 0) {
      return []
    }
    const extractor = await getExtractor()
    const output: Tensor = await extractor(texts, { pooling: 'mean', normalize: false })

    const batchSize = output.dims[0]
    const embeddingDim = output.dims[1]
    const embeddings: Float32Array[] = []

    for (let i = 0; i < batchSize; i++) {
      const start = i * embeddingDim
      const end = start + embeddingDim
      let embedding = output.data.slice(start, end) as Float32Array
      if (normalize) {
        embedding = l2norm(embedding)
      }
      embeddings.push(embedding)
    }

    return embeddings
  }

  // Dimension is not known synchronously until first run. Expose common default of MiniLM (384).
  // Consumers can read provider.dimension after first embed if they need exact size.
  let dimension = 384
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
  }

  return provider
}
