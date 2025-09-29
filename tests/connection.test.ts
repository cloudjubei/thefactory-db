import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SQL } from '../src/utils'

// Hoisted mocks for 'pg'
const hoisted = vi.hoisted(() => {
  const clientMock = {
    query: vi.fn(),
    release: vi.fn(),
  }
  const poolMock = {
    connect: vi.fn().mockResolvedValue(clientMock),
    end: vi.fn(),
  }
  const PoolCtor = vi.fn(() => poolMock)
  return { clientMock, poolMock, PoolCtor }
})

vi.mock('pg', () => ({ Pool: hoisted.PoolCtor }))

// Import after mocks so they take effect
import { openPostgres } from '../src/connection'

describe('openPostgres (connection)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.clientMock.query.mockReset()
    hoisted.clientMock.release.mockReset()
    hoisted.poolMock.connect.mockReset().mockResolvedValue(hoisted.clientMock)
    hoisted.poolMock.end.mockReset()
  })

  afterEach(() => {
    // Restore SQL in case a test mutated it
    ;(SQL as any).schema = SQL.schema ?? SQL.schema // no-op but keeps TS happy
    ;(SQL as any).hybridSearch = SQL.hybridSearch ?? SQL.hybridSearch
  })

  it('connects, initializes schema (schema + hybrid), releases client, and returns pool', async () => {
    hoisted.clientMock.query.mockResolvedValue({})

    const pool = await openPostgres('postgres://user:pass@host:5432/db')

    expect(hoisted.PoolCtor).toHaveBeenCalledWith({ connectionString: 'postgres://user:pass@host:5432/db' })
    expect(hoisted.poolMock.connect).toHaveBeenCalledTimes(1)

    // Expect both schema and hybrid SQL to be executed in order
    const queries = hoisted.clientMock.query.mock.calls.map((c: any[]) => c[0])
    expect(queries[0]).toBe(SQL.schema)
    expect(queries[1]).toBe(SQL.hybridSearch)
    expect(hoisted.clientMock.query).toHaveBeenCalledTimes(2)

    // Client must be released in finally
    expect(hoisted.clientMock.release).toHaveBeenCalledTimes(1)

    // Pool should not be ended on success
    expect(hoisted.poolMock.end).not.toHaveBeenCalled()

    // Should return the pool (DB type)
    expect(pool).toBe(hoisted.poolMock)
  })

  it('ends pool and rethrows if schema initialization fails; always releases client', async () => {
    const error = new Error('init failure')
    hoisted.clientMock.query.mockRejectedValueOnce(error)

    await expect(openPostgres('postgres://u:p@h/db')).rejects.toThrow(error)

    expect(hoisted.poolMock.connect).toHaveBeenCalledTimes(1)
    // On failure during init, pool should be ended
    expect(hoisted.poolMock.end).toHaveBeenCalledTimes(1)
    // Client released in finally regardless of error
    expect(hoisted.clientMock.release).toHaveBeenCalledTimes(1)

    // Only first query attempted due to failure
    expect(hoisted.clientMock.query).toHaveBeenCalledTimes(1)
  })

  it('does nothing when SQL strings are not present (no schema/hybrid), still releases client', async () => {
    // Temporarily unset SQL to hit the falsy branches
    const originalSchema = SQL.schema
    const originalHybrid = SQL.hybridSearch
    ;(SQL as any).schema = undefined
    ;(SQL as any).hybridSearch = undefined

    hoisted.clientMock.query.mockResolvedValue({})

    const pool = await openPostgres('postgres://user:pass@host:5432/db')

    expect(hoisted.poolMock.connect).toHaveBeenCalledTimes(1)
    expect(hoisted.clientMock.query).not.toHaveBeenCalled()
    expect(hoisted.clientMock.release).toHaveBeenCalledTimes(1)
    expect(hoisted.poolMock.end).not.toHaveBeenCalled()
    expect(pool).toBe(hoisted.poolMock)

    // Restore
    ;(SQL as any).schema = originalSchema
    ;(SQL as any).hybridSearch = originalHybrid
  })
})
