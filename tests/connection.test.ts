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
import { openPostgres, probeDatabase } from '../src/connection'

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

    // `connectionTimeoutMillis` is required: pg's default is "wait
    // forever". Without it a stopped DB container hangs the entire
    // backend boot — exactly the symptom we just hit. The exact value
    // doesn't matter for correctness here, just that it is finite.
    expect(hoisted.PoolCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgres://user:pass@host:5432/db',
        connectionTimeoutMillis: expect.any(Number),
      }),
    )
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

describe('probeDatabase (fresh, timeout-bounded health probe)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.clientMock.query.mockReset()
    hoisted.clientMock.release.mockReset()
    hoisted.poolMock.connect.mockReset().mockResolvedValue(hoisted.clientMock)
    hoisted.poolMock.end.mockReset()
  })

  it('returns { ok: true } when SELECT 1 round-trips successfully', async () => {
    hoisted.clientMock.query.mockResolvedValue({ rows: [{ '?column?': 1 }] })

    const result = await probeDatabase('postgres://u:p@h/db')

    expect(result).toEqual({ ok: true })
  })

  it('uses a fresh pool (does NOT share state with openPostgres)', async () => {
    hoisted.clientMock.query.mockResolvedValue({ rows: [] })

    await probeDatabase('postgres://u:p@h/db')

    // A new Pool is constructed for the probe — the whole point is that a
    // health check works even when a prior `openPostgres` pool is wedged.
    expect(hoisted.PoolCtor).toHaveBeenCalled()
  })

  it('passes a connectionTimeoutMillis so a network-level hang surfaces', async () => {
    hoisted.clientMock.query.mockResolvedValue({ rows: [] })

    await probeDatabase('postgres://u:p@h/db', 1234)

    const callArgs = hoisted.PoolCtor.mock.calls.at(-1)?.[0] ?? {}
    expect(callArgs.connectionString).toBe('postgres://u:p@h/db')
    expect(callArgs.connectionTimeoutMillis).toBe(1234)
  })

  it('closes the throwaway pool whether the probe succeeds or fails', async () => {
    hoisted.clientMock.query.mockResolvedValue({ rows: [] })

    await probeDatabase('postgres://u:p@h/db')

    expect(hoisted.poolMock.end).toHaveBeenCalledTimes(1)
  })

  it('returns { ok: false, error } when connect fails (does not throw)', async () => {
    const err = new Error('ECONNREFUSED 127.0.0.1:5432')
    hoisted.poolMock.connect.mockReset().mockRejectedValueOnce(err)

    const result = await probeDatabase('postgres://u:p@h/db')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/ECONNREFUSED/)
  })

  it('returns { ok: false, error } when SELECT 1 fails (does not throw)', async () => {
    hoisted.clientMock.query.mockRejectedValueOnce(new Error('boom'))

    const result = await probeDatabase('postgres://u:p@h/db')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/boom/)
    // Client must still be released and pool closed on failure.
    expect(hoisted.clientMock.release).toHaveBeenCalledTimes(1)
    expect(hoisted.poolMock.end).toHaveBeenCalledTimes(1)
  })

  it('returns { ok: false, error } when the probe itself exceeds the timeout', async () => {
    // Connect resolves only after a delay longer than the probe timeout —
    // the probe must give up and report the timeout rather than hang.
    hoisted.poolMock.connect.mockReset().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(hoisted.clientMock), 200)),
    )

    const result = await probeDatabase('postgres://u:p@h/db', 30)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/timed\s*out|timeout/i)
  })
})
