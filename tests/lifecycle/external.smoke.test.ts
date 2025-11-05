import { describe, it, expect, vi } from 'vitest'
import { Pool } from 'pg'
import { createDatabase } from '../../src/index'

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

const SERVER_URL = process.env.DATABASE_SERVER_URL

;(SERVER_URL ? describe : describe.skip)('lifecycle: external (temporary database on provided server)', () => {
  it('creates a temporary database, initializes schema, and drops it on destroy', async () => {
    const { client, dbName, connectionString, destroy } = await createDatabase({
      connectionString: SERVER_URL!,
      logLevel: 'error',
    })

    expect(dbName).toMatch(/^tfdb_/)
    expect(connectionString).toContain(dbName)

    // Quick smoke ops
    const d = await client.addDocument({
      projectId: 'ext',
      type: 'md',
      src: 'note.md',
      name: 'Note',
      content: 'hello external smoke',
    })
    expect(d.id).toBeDefined()

    const res = await client.searchDocuments({ query: 'hello', limit: 5 })
    expect(Array.isArray(res)).toBe(true)

    // Teardown: drops the temporary database
    await destroy()

    // Verify the database no longer exists by checking pg_database
    const adminUrl = new URL(SERVER_URL!)
    adminUrl.pathname = '/postgres'
    const pool = new Pool({ connectionString: adminUrl.toString() })
    try {
      const r = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
      expect(r.rowCount).toBe(0)
    } finally {
      await pool.end()
    }
  }, 120_000)
})
