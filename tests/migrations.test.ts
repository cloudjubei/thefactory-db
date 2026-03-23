import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openDatabase } from '../src/client/openDatabase.js'
import { openPostgres } from '../src/connection.js'

// Mock Postgres client setup
vi.mock('../src/connection.js', () => ({
  openPostgres: vi.fn(),
}))

// Mock embeddings so openDatabase doesn't try to load a real model
vi.mock('../src/utils/embeddings.js', () => ({
  createLocalEmbeddingProvider: vi.fn().mockResolvedValue({
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    close: vi.fn(),
  }),
}))

// Mock logger to avoid noise and to test outputs
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}
vi.mock('../src/logger.js', () => ({
  createLogger: () => mockLogger,
}))

describe('Migrations', () => {
  let queries: string[] = []
  let released = 0

  beforeEach(() => {
    vi.clearAllMocks()
    queries = []
    released = 0
  })

  /**
   * Creates a mock Pool (the DB type returned by openPostgres).
   * The pool's single client tracks all queries in `queries` and handles
   * advisory-lock and schema_version responses inline — no attachMigrationSupport
   * needed here so that no extra connect() override stomps our tracking client.
   */
  const createDbMock = (initialSchemaVersion: number) => {
    const clientQuery = vi.fn().mockImplementation((q: string, _params?: any[]) => {
      queries.push(q)
      const s = q.toLowerCase()
      if (s.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }], rowCount: 1 }
      if (s.includes('select schema_version from thefactory.meta'))
        return { rows: [{ schema_version: initialSchemaVersion }], rowCount: 1 }
      if (s.includes('select schema_version'))
        return { rows: [{ schema_version: initialSchemaVersion }], rowCount: 1 }
      // ensureMetadata: meta table row-count check
      if (s.includes('select schema_version')) return { rows: [{ schema_version: initialSchemaVersion }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })

    const client = {
      query: clientQuery,
      release: vi.fn().mockImplementation(() => {
        released++
      }),
    }

    return {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockImplementation((...args) => clientQuery(...args)),
      end: vi.fn(),
      options: {},
    }
  }

  it('runs migrations automatically by default on new database (schemaVersion=0)', async () => {
    const mockDb = createDbMock(0)
    vi.mocked(openPostgres).mockResolvedValue(mockDb as any)

    await openDatabase({ connectionString: 'postgres://x' })

    const allQueries = queries.join('\n').toLowerCase()

    // Should create metadata
    expect(allQueries).toContain('create schema if not exists thefactory')
    expect(allQueries).toContain('create table if not exists thefactory.meta')

    // Should lock/unlock
    expect(allQueries).toContain('pg_try_advisory_lock')
    expect(allQueries).toContain('pg_advisory_unlock')

    // Should apply 001 init schema
    expect(allQueries).toContain('create extension if not exists pgcrypto')
    expect(allQueries).toContain('create table if not exists documents')
    expect(allQueries).toContain('insert into thefactory.migration_log')
    expect(allQueries).toContain('update thefactory.meta set schema_version = $1')

    // Connection must be released
    expect(released).toBe(1)
  })

  it('skips migrations if migrations: "none"', async () => {
    const mockDb = createDbMock(0)
    vi.mocked(openPostgres).mockResolvedValue(mockDb as any)

    await openDatabase({ connectionString: 'postgres://x', migrations: 'none' })

    const allQueries = queries.join('\n').toLowerCase()

    // Should NOT acquire lock or run schema
    expect(allQueries).not.toContain('pg_try_advisory_lock')
    expect(allQueries).not.toContain('create extension if not exists pgcrypto')
  })

  it('is idempotent (does nothing if already at latest schema)', async () => {
    // Current latest version is 1 (001-init)
    const mockDb = createDbMock(1)
    vi.mocked(openPostgres).mockResolvedValue(mockDb as any)

    await openDatabase({ connectionString: 'postgres://x' })

    const allQueries = queries.join('\n').toLowerCase()

    expect(allQueries).toContain('pg_try_advisory_lock') // Still locks to check version
    expect(allQueries).not.toContain('insert into thefactory.migration_log') // But doesn't apply
    expect(allQueries).not.toContain('create extension if not exists pgcrypto')

    // Logs should say it's up to date
    expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Database is up to date'))
  })

  it('retries lock acquisition on failure, and throws on timeout', async () => {
    // Override connect mock to return a client that never acquires the lock
    const lockClient = {
      query: vi.fn().mockImplementation((q) => {
        if (q.includes('pg_try_advisory_lock')) return { rows: [{ acquired: false }] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }

    const mockDb = {
      connect: vi.fn().mockResolvedValue(lockClient),
      query: vi.fn(),
      end: vi.fn(),
      options: {},
    }
    vi.mocked(openPostgres).mockResolvedValue(mockDb as any)

    // Set a very short timeout so the test finishes quickly (e.g. 500ms)
    vi.stubEnv('MIGRATION_LOCK_TIMEOUT_MS', '500')
    vi.stubEnv('MIGRATION_LOCK_RETRY_MS', '100')

    await expect(openDatabase({ connectionString: 'postgres://x' })).rejects.toThrow(
      'Failed to acquire migration lock',
    )

    // It should have called the lock function multiple times
    const tries = lockClient.query.mock.calls.filter((args) =>
      args[0].includes('pg_try_advisory_lock'),
    ).length
    expect(tries).toBeGreaterThan(1)

    vi.unstubAllEnvs()
  })

  it('rolls back and rethrows if a migration fails', async () => {
    const mockDb = createDbMock(0)

    // Override connect to inject a client that throws on the actual migration SQL
    mockDb.connect = vi.fn().mockResolvedValue({
      query: vi.fn().mockImplementation((q) => {
        queries.push(q)
        const s = q.toLowerCase()
        if (s.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
        if (s.includes('select schema_version from thefactory.meta'))
          return { rows: [{ schema_version: 0 }], rowCount: 1 }
        if (s.includes('select schema_version'))
          return { rows: [{ schema_version: 0 }], rowCount: 1 }
        if (s.includes('create extension if not exists pgcrypto'))
          throw new Error('Simulated syntax error')
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn().mockImplementation(() => {
        released++
      }),
    })

    vi.mocked(openPostgres).mockResolvedValue(mockDb as any)

    await expect(openDatabase({ connectionString: 'postgres://x' })).rejects.toThrow(
      'Migration failed at version 1 (001-init-schema)',
    )

    const allQueries = queries.join('\n').toLowerCase()

    expect(allQueries).toContain('begin')
    expect(allQueries).toContain('rollback')
    expect(allQueries).toContain('pg_advisory_unlock')
    expect(allQueries).not.toContain('commit')
  })
})
