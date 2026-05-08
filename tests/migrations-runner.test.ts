import { describe, it, expect, vi, beforeEach } from 'vitest'

const pgHoisted = vi.hoisted(() => ({ PoolCtor: vi.fn() }))

vi.mock('pg', () => ({ Pool: pgHoisted.PoolCtor }))
vi.mock('../src/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import { getDatabaseInfo, migrateDatabase } from '../src/migrations/runner.js'
import { migrations } from '../src/migrations/index.js'

const LATEST_VERSION = migrations[migrations.length - 1].version

type QueryResult = { rows: unknown[]; rowCount: number }
type ClientStub = {
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
}
type PoolStub = {
  connect: ReturnType<typeof vi.fn>
  query: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

function buildPool(opts: { schemaVersion: number; recorded: string[]; acquireLock?: boolean }): {
  pool: PoolStub
  client: ClientStub
} {
  const { schemaVersion, recorded, acquireLock = true } = opts
  const client: ClientStub = {
    query: vi.fn(async (sql: string): Promise<QueryResult> => {
      recorded.push(sql)
      const s = sql.toLowerCase()
      if (s.includes('pg_try_advisory_lock'))
        return { rows: [{ acquired: acquireLock }], rowCount: 1 }
      if (s.includes('select schema_version'))
        return { rows: [{ schema_version: schemaVersion }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  const pool: PoolStub = {
    connect: vi.fn(async () => client),
    query: vi.fn(),
    end: vi.fn(),
  }
  return { pool, client }
}

describe('runner.getDatabaseInfo()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports schemaVersion, latestVersion, and pending list when given a Pool', async () => {
    const recorded: string[] = []
    const { pool } = buildPool({ schemaVersion: 0, recorded })

    const info = await getDatabaseInfo(pool as any)

    expect(info.schemaVersion).toBe(0)
    expect(info.latestVersion).toBe(LATEST_VERSION)
    expect(info.pending).toHaveLength(migrations.length)
    expect(info.pending[0].id).toBe(migrations[0].id)
    // Caller-owned pools must not be ended by the runner.
    expect(pool.end).not.toHaveBeenCalled()
  })

  it('reports an empty pending list when already at latest', async () => {
    const recorded: string[] = []
    const { pool } = buildPool({ schemaVersion: LATEST_VERSION, recorded })

    const info = await getDatabaseInfo(pool as any)

    expect(info.schemaVersion).toBe(LATEST_VERSION)
    expect(info.pending).toEqual([])
  })

  it('builds its own Pool when given OpenDbOptions and ends it after use', async () => {
    const recorded: string[] = []
    const { pool } = buildPool({ schemaVersion: 0, recorded })
    pgHoisted.PoolCtor.mockImplementationOnce(() => pool)

    await getDatabaseInfo({ connectionString: 'postgres://x' } as any)

    expect(pgHoisted.PoolCtor).toHaveBeenCalledWith({ connectionString: 'postgres://x' })
    expect(pool.end).toHaveBeenCalledTimes(1)
  })

  it('seeds thefactory.meta with schema_version=0 when the meta row is missing', async () => {
    // ensureMetadata's INSERT path: SELECT returns rowCount=0 once, then resolves to v0.
    let metaSeeded = false
    const recorded: string[] = []
    const client: ClientStub = {
      query: vi.fn(async (sql: string): Promise<QueryResult> => {
        recorded.push(sql)
        const s = sql.toLowerCase()
        if (s.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }], rowCount: 1 }
        if (s.includes('insert into thefactory.meta')) {
          metaSeeded = true
          return { rows: [], rowCount: 1 }
        }
        if (s.includes('select schema_version from thefactory.meta')) {
          return metaSeeded
            ? { rows: [{ schema_version: 0 }], rowCount: 1 }
            : { rows: [], rowCount: 0 }
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool: PoolStub = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
      end: vi.fn(),
    }

    await getDatabaseInfo(pool as any)

    const sqls = recorded.join('\n').toLowerCase()
    expect(sqls).toContain('insert into thefactory.meta (schema_version) values (0)')
    expect(metaSeeded).toBe(true)
  })
})

describe('runner.migrateDatabase()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs the plan but applies nothing when dryRun=true', async () => {
    const recorded: string[] = []
    const { pool, client } = buildPool({ schemaVersion: 0, recorded })

    await migrateDatabase(pool as any, { dryRun: true })

    const sqls = recorded.join('\n').toLowerCase()
    expect(sqls).not.toContain('begin')
    expect(sqls).not.toContain('insert into thefactory.migration_log')
    expect(sqls).not.toContain('update thefactory.meta set schema_version')
    expect(sqls).toContain('pg_try_advisory_lock')
    expect(sqls).toContain('pg_advisory_unlock')
    expect(client.release).toHaveBeenCalled()
  })

  it('builds its own Pool when given OpenDbOptions and ends it after migrating', async () => {
    const recorded: string[] = []
    const { pool } = buildPool({ schemaVersion: LATEST_VERSION, recorded })
    pgHoisted.PoolCtor.mockImplementationOnce(() => pool)

    await migrateDatabase({ connectionString: 'postgres://x' } as any)

    expect(pgHoisted.PoolCtor).toHaveBeenCalledWith({ connectionString: 'postgres://x' })
    expect(pool.end).toHaveBeenCalledTimes(1)
  })
})
