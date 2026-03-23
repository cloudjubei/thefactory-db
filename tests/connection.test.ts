import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

  it('connects, verifies connection, releases client, and returns pool', async () => {
    hoisted.clientMock.query.mockResolvedValue({})

    const pool = await openPostgres('postgres://user:pass@host:5432/db')

    expect(hoisted.PoolCtor).toHaveBeenCalledWith({
      connectionString: 'postgres://user:pass@host:5432/db',
    })
    expect(hoisted.poolMock.connect).toHaveBeenCalledTimes(1)

    // Expect 'SELECT 1' to be executed
    const queries = hoisted.clientMock.query.mock.calls.map((c: any[]) => c[0])
    expect(queries[0]).toBe('SELECT 1')
    expect(hoisted.clientMock.query).toHaveBeenCalledTimes(1)

    // Client must be released in finally
    expect(hoisted.clientMock.release).toHaveBeenCalledTimes(1)

    // Pool should not be ended on success
    expect(hoisted.poolMock.end).not.toHaveBeenCalled()

    // Should return the pool
    expect(pool).toBe(hoisted.poolMock)
  })

  it('ends pool and rethrows if verification fails; always releases client', async () => {
    const error = new Error('verification failure')
    hoisted.clientMock.query.mockRejectedValueOnce(error)

    await expect(openPostgres('postgres://u:p@h/db')).rejects.toThrow(error)

    expect(hoisted.poolMock.connect).toHaveBeenCalledTimes(1)
    // On failure during verification, pool should be ended
    expect(hoisted.poolMock.end).toHaveBeenCalledTimes(1)
    // Client released in finally regardless of error
    expect(hoisted.clientMock.release).toHaveBeenCalledTimes(1)
  })
})
