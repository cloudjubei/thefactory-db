import { describe, it, expect, vi } from 'vitest'
import Docker from 'dockerode'
import { createDatabase } from '../../../src/index'

// Stub embeddings to avoid heavy model downloads during e2e tests
vi.mock('../../../src/utils/embeddings', () => {
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

const RUN = process.env.RUN_E2E === '1'

async function dockerAvailable(): Promise<boolean> {
  try {
    const docker = new Docker()
    await docker.ping()
    return true
  } catch {
    return false
  }
}

const DOCKER = RUN ? await dockerAvailable() : false

;(DOCKER ? describe : describe.skip)('E2E: Lifecycle (managed container)', () => {
  it(
    'starts fresh pgvector container, performs ops, and destroys cleanly',
    async () => {
      const { client, connectionString, destroy, isManaged, dbName } =
        await createDatabase({ logLevel: 'error' })

      expect(isManaged).toBe(true)
      expect(connectionString).toContain('postgresql://')
      expect(dbName).toMatch(/^tfdb_/)

      const doc = await client.addDocument({
        projectId: 'p1',
        type: 'md',
        src: 'README.md',
        name: 'Readme',
        content: 'Hello world for managed e2e test',
        metadata: { a: 1 },
      })
      expect(doc.id).toBeDefined()

      const ent = await client.addEntity({
        projectId: 'p1',
        type: 'item',
        content: { title: 'hello', x: 1 },
        metadata: { b: 2 },
      })
      expect(ent.id).toBeDefined()

      const dres = await client.searchDocuments({ query: 'hello', limit: 5 })
      expect(Array.isArray(dres)).toBe(true)

      const eres = await client.searchEntities({ query: 'hello', limit: 5 })
      expect(Array.isArray(eres)).toBe(true)

      await destroy()

      await expect(client.searchDocuments({ query: 'hello', limit: 1 })).rejects.toBeTruthy()

      // Container should be gone (no container exposing the same host port for pgvector image)
      const url = new URL(connectionString)
      const hostPort = Number(url.port)
      const docker = new Docker()
      const all = await docker.listContainers({ all: true })
      const match = all.find(
        (c: any) =>
          (c.Image || '').includes('pgvector/pgvector:pg16') &&
          (c.Ports || []).some((p: any) => p.PublicPort === hostPort),
      )
      expect(match).toBeFalsy()
    },
    120_000,
  )
})
