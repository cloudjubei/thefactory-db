import { describe, it, expect, vi } from 'vitest'

import { setupUnitTestMocks } from './utils/unitTestMocks'
import { openDatabase } from '../src/index'

describe('openDatabase()', () => {
  const { mockDbClient, mockEmbeddingProvider } = setupUnitTestMocks()

  it('runs migrations when migrations="auto" is set explicitly', async () => {
    await openDatabase({ connectionString: 'test', migrations: 'auto' })

    expect(mockDbClient.connect).toHaveBeenCalled()
  })

  it('skips migrations entirely when migrations="none"', async () => {
    await openDatabase({ connectionString: 'test', migrations: 'none' })

    const queries = mockDbClient.query.mock.calls
      .map((c: unknown[]) => String(c[0] ?? ''))
      .join('\n')
      .toLowerCase()
    expect(queries).not.toContain('pg_try_advisory_lock')
    expect(mockDbClient.connect).not.toHaveBeenCalled()
  })

  it('treats migrations={toVersion} as auto and forwards the cap to the runner', async () => {
    const lockClient = {
      query: vi.fn(async (sql: string) => {
        const s = (sql || '').toLowerCase()
        if (s.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }], rowCount: 1 }
        if (s.includes('select schema_version'))
          return { rows: [{ schema_version: 0 }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    mockDbClient.connect.mockImplementationOnce(async () => lockClient)

    // toVersion=0 caps below the only migration (v1), so nothing should be applied.
    await openDatabase({ connectionString: 'test', migrations: { toVersion: 0 } })

    const sqls = lockClient.query.mock.calls
      .map((c) => String(c[0] ?? ''))
      .join('\n')
      .toLowerCase()
    expect(sqls).toContain('pg_try_advisory_lock')
    expect(sqls).not.toContain('insert into thefactory.migration_log')
  })

  it('close() swallows embedding-provider close errors and still ends the db pool', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockEmbeddingProvider.close.mockRejectedValueOnce(new Error('embedder dead'))

    await expect(db.close()).resolves.toBeUndefined()
    expect(mockDbClient.end).toHaveBeenCalled()
  })

  it('close() works when the embedding provider has no close() method', async () => {
    const original = mockEmbeddingProvider.close
    delete mockEmbeddingProvider.close

    const db = await openDatabase({ connectionString: 'test' })
    await expect(db.close()).resolves.toBeUndefined()
    expect(mockDbClient.end).toHaveBeenCalled()

    mockEmbeddingProvider.close = original
  })

  it('exposes raw() returning the underlying db', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    expect(db.raw()).toBe(mockDbClient)
  })
})
