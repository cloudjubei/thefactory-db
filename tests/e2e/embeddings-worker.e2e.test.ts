import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

import { describe, it, expect } from 'vitest'

import { createLocalEmbeddingProvider } from '../../src/utils/embeddings'

const RUN = process.env.RUN_E2E === '1'

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

/**
 * The model's vectors computed on a calling thread — in a separate process: loading onnxruntime-node
 * on this thread while worker threads come and go aborts the process (a V8 backing-store check).
 */
function referenceVectors(texts: string[]): { single: Float32Array[]; batch: Float32Array[] } {
  const script = `
    const { createInProcessEmbeddingProvider } = await import(process.argv[1])
    const { readFileSync } = await import('node:fs')
    const texts = JSON.parse(readFileSync(0, 'utf8'))
    const p = await createInProcessEmbeddingProvider()
    const single = []
    for (const t of texts) single.push(Array.from(await p.embed(t)))
    const batch = (await p.embedBatch(texts)).map((v) => Array.from(v))
    await p.close()
    process.stdout.write(JSON.stringify({ single, batch }))
  `
  const out = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      script,
      new URL('../../src/utils/embeddings.ts', import.meta.url).href,
    ],
    {
      input: JSON.stringify(texts),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  const parsed = JSON.parse(out) as { single: number[][]; batch: number[][] }
  return {
    single: parsed.single.map((v) => new Float32Array(v)),
    batch: parsed.batch.map((v) => new Float32Array(v)),
  }
}

/** Longest gap between 1 ms timer ticks while `work` runs: how long the event loop was blocked. */
async function longestStall(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now()
  let longest = 0
  const timer = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 1)
  try {
    await work()
    await new Promise((r) => setTimeout(r, 5))
  } finally {
    clearInterval(timer)
  }
  return longest
}

;(RUN ? describe : describe.skip)('E2E: embedding in a worker thread (real model)', () => {
  const source = fs.readFileSync(new URL('../../src/sql.ts', import.meta.url), 'utf8')

  it('returns the vectors the model returns on the calling thread', async () => {
    const texts = ['hybrid search over documents', source]
    const reference = referenceVectors(texts)
    const worker = await createLocalEmbeddingProvider()
    try {
      for (let i = 0; i < texts.length; i++) {
        expect(cosine(await worker.embed(texts[i]), reference.single[i])).toBeCloseTo(1, 5)
      }
      const viaWorker = await worker.embedBatch(texts)
      viaWorker.forEach((v, i) => expect(cosine(v, reference.batch[i])).toBeCloseTo(1, 5))
      expect(worker.dimension).toBe(384)
    } finally {
      await worker.close?.()
    }
  }, 120_000)

  it('keeps the calling thread responsive while it embeds a batch', async () => {
    const worker = await createLocalEmbeddingProvider()
    try {
      await worker.embed('warm up')
      const stall = await longestStall(() =>
        Promise.all(Array.from({ length: 40 }, () => worker.embed(source))),
      )
      // On the calling thread this batch blocked the loop for ~3 s without a single tick.
      expect(stall).toBeLessThan(100)
    } finally {
      await worker.close?.()
    }
  })
})
