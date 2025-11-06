import { describe, it, expect, vi } from 'vitest'
import Docker from 'dockerode'
import { createReusableDatabase, openDatabase } from '../../src/index'

// Stub embeddings to avoid heavy model downloads during smoke tests
vi.mock('../../src/utils/embeddings', () => {
  const makeVec = () => new Float32Array(Array.from({ length: 384 }, () => 0.01))
  return {
    createLocalEmbeddingProvider: vi.fn(async () => ({
      name: 'mock-embeddings',
      dimension: 384,
      embed: vi.fn(async () => makeVec()),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => makeVec())),
      close: vi.fn(async () => {}),
    })),
  }
})

async function dockerAvailable(): Promise<boolean> {
  try {
    const docker = new Docker()
    await docker.ping()
    return true
  } catch {
    return false
  }
}

const DOCKER = await dockerAvailable()

;(DOCKER ? describe : describe.skip)(
  'lifecycle: reusable provisioning (managed persistent)',
  () => {
    it('is idempotent and schema is initialized for connections', async () => {
      const r1 = await createReusableDatabase({ logLevel: 'error' })
      // In CI, container may already exist; allow created to be either true or false
      expect(typeof r1.created).toBe('boolean')

      const r2 = await createReusableDatabase({ logLevel: 'error' })
      expect(r2.connectionString).toEqual(r1.connectionString)
      expect(r2.created).toBe(false)

      const db = await openDatabase({ connectionString: r1.connectionString, logLevel: 'error' })
      // Perform a tiny op to ensure schema exists; use upsert to be idempotent across runs
      const doc = await db.upsertDocument({
        projectId: 'reusable',
        type: 'md',
        src: 'file.md',
        name: 'File',
        content: 'hello reusable',
      })
      // Regardless of whether upsert inserted/updated or was a no-op, the doc should exist
      const fetched = await db.getDocumentBySrc('reusable', 'file.md')
      expect(fetched && fetched.id).toBeDefined()
      await db.close()

      // Do not destroy the reusable container here; it is intended to persist across runs
    }, 120_000)
  },
)
