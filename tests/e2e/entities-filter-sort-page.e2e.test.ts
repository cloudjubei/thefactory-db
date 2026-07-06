import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

// Exercises the composable filter / content-field sort / offset pagination + count capability
// against a real Postgres so the generated SQL is proven to execute (unit tests only check text).
;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: entity filter/sort/pagination', () => {
  const projectId = `e2e-fsp-${Date.now()}`
  let db: Awaited<ReturnType<typeof openDatabase>>

  beforeAll(async () => {
    db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
    await db.clearEntities({ projectIds: [projectId] })
    // 5 "run" entities with a numeric objective + nested metrics + a text status.
    const rows = [
      { objective: -3, status: 'ok', metrics: { n_trades: 10 }, config: { asset: 'BTCUSDT' } },
      { objective: 1, status: 'ok', metrics: { n_trades: 0 }, config: { asset: 'BTCUSDT' } },
      { objective: 5, status: 'failed', metrics: { n_trades: 7 }, config: { asset: 'ETHUSDT' } },
      { objective: 2, status: 'ok', metrics: { n_trades: 3 }, config: { asset: 'BTCUSDT' } },
      { objective: 9, status: 'ok', metrics: { n_trades: 20 }, config: { asset: 'BTCUSDT' } },
    ]
    for (const content of rows) {
      await db.addEntity({ projectId, type: 'run', content, shouldEmbed: false })
    }
  })

  afterAll(async () => {
    try {
      await db.clearEntities({ projectIds: [projectId] })
    } finally {
      await db.close()
    }
  })

  it('filters by a numeric content field (objective > 1)', async () => {
    const rows = await db.matchEntities(undefined, {
      projectIds: [projectId],
      types: ['run'],
      where: { field: 'objective', op: '>', value: 1 },
      limit: 100,
    })
    expect(rows.map((r) => (r.content as any).objective).sort((a, b) => a - b)).toEqual([2, 5, 9])
  })

  it('filters on a nested numeric field (metrics.n_trades >= 7)', async () => {
    const rows = await db.matchEntities(undefined, {
      projectIds: [projectId],
      where: { field: 'metrics.n_trades', op: '>=', value: 7 },
      limit: 100,
    })
    expect(rows.length).toBe(3)
  })

  it('filters by a text field and composes and/not', async () => {
    const rows = await db.matchEntities(undefined, {
      projectIds: [projectId],
      where: {
        and: [
          { field: 'config.asset', op: '=', value: 'BTCUSDT' },
          { not: { field: 'status', op: '=', value: 'failed' } },
          { field: 'objective', op: '>=', value: 2 },
        ],
      },
      limit: 100,
    })
    expect(rows.map((r) => (r.content as any).objective).sort((a, b) => a - b)).toEqual([2, 9])
  })

  it('orders by a numeric content field, descending', async () => {
    const rows = await db.matchEntities(undefined, {
      projectIds: [projectId],
      orderBy: [{ field: 'objective', direction: 'desc', numeric: true }],
      limit: 100,
    })
    expect(rows.map((r) => (r.content as any).objective)).toEqual([9, 5, 2, 1, -3])
  })

  it('paginates a sorted result set with limit + offset', async () => {
    const sort = { field: 'objective', direction: 'desc' as const, numeric: true }
    const page1 = await db.matchEntities(undefined, {
      projectIds: [projectId],
      orderBy: [sort],
      limit: 2,
      offset: 0,
    })
    const page2 = await db.matchEntities(undefined, {
      projectIds: [projectId],
      orderBy: [sort],
      limit: 2,
      offset: 2,
    })
    expect(page1.map((r) => (r.content as any).objective)).toEqual([9, 5])
    expect(page2.map((r) => (r.content as any).objective)).toEqual([2, 1])
  })

  it('counts the full filtered set independent of paging', async () => {
    const total = await db.countEntities(undefined, {
      projectIds: [projectId],
      where: { field: 'objective', op: '>', value: 1 },
    })
    expect(total).toBe(3)
  })

  it('filters with contains and exists, and composes or', async () => {
    const contains = await db.matchEntities(undefined, {
      projectIds: [projectId],
      where: { field: 'config.asset', op: 'contains', value: 'eth' },
      limit: 100,
    })
    expect(contains.map((r) => (r.content as any).config.asset)).toEqual(['ETHUSDT'])

    const either = await db.matchEntities(undefined, {
      projectIds: [projectId],
      where: {
        or: [
          { field: 'status', op: '=', value: 'failed' },
          { field: 'objective', op: '>=', value: 9 },
        ],
      },
      limit: 100,
    })
    expect(either.map((r) => (r.content as any).objective).sort((a, b) => a - b)).toEqual([5, 9])

    const exists = await db.matchEntities(undefined, {
      projectIds: [projectId],
      where: { field: 'metrics.n_trades', op: 'exists' },
      limit: 100,
    })
    expect(exists.length).toBe(5)
  })

  it('orders by a text content field ascending', async () => {
    const rows = await db.matchEntities(undefined, {
      projectIds: [projectId],
      where: { field: 'config.asset', op: '=', value: 'BTCUSDT' },
      orderBy: [{ field: 'status', direction: 'asc' }],
      limit: 100,
    })
    // All BTCUSDT here are status 'ok' — assert the query runs and returns them all in a stable order.
    expect(rows.length).toBe(4)
    expect(new Set(rows.map((r) => (r.content as any).status))).toEqual(new Set(['ok']))
  })

  // The heavy-jsonb OOM fix: `omit` must drop the subtree IN SQL (proven here against real Postgres,
  // since unit tests only assert the generated text), keep siblings, and never throw on content shapes
  // where a path can't be followed (array/scalar node) — the guarded `#-` must degrade to a no-op.
  describe('omit projection (heavy-field push-down)', () => {
    const omitProject = `e2e-omit-${Date.now()}`
    beforeAll(async () => {
      await db.clearEntities({ projectIds: [omitProject] })
      // r1: full object with a top-level heavy field + a nested heavy field under an object.
      await db.addEntity({
        projectId: omitProject,
        type: 'run',
        shouldEmbed: false,
        content: {
          objective: 5,
          series: { equity: [1, 2, 3] },
          artifacts: { checkpoint: 'c.pt', runChart: { price: [9, 9, 9] } },
        },
      })
      // r2: `artifacts` is an ARRAY — a nested omit path `artifacts.runChart` must NOT throw.
      await db.addEntity({
        projectId: omitProject,
        type: 'run',
        shouldEmbed: false,
        content: { objective: 1, series: 'scalar-not-object', artifacts: ['a', 'b'] },
      })
    })
    afterAll(async () => {
      await db.clearEntities({ projectIds: [omitProject] })
    })

    it('drops top-level and nested omit paths in SQL while keeping siblings', async () => {
      const [row] = await db.matchEntities(undefined, {
        projectIds: [omitProject],
        where: { field: 'objective', op: '=', value: 5 },
        omit: ['series', 'artifacts.runChart'],
        limit: 10,
      })
      expect(row.content).toEqual({ objective: 5, artifacts: { checkpoint: 'c.pt' } })
    })

    it('is a no-op (never throws) when an omit path leads through an array or scalar node', async () => {
      const [row] = await db.matchEntities(undefined, {
        projectIds: [omitProject],
        where: { field: 'objective', op: '=', value: 1 },
        omit: ['series', 'artifacts.runChart'],
        limit: 10,
      })
      // `series` is a top-level scalar → dropped; `artifacts` is an array so `artifacts.runChart` can't
      // be followed → left intact (guard degraded to no-op), matching the JS omit semantics.
      expect(row.content).toEqual({ objective: 1, artifacts: ['a', 'b'] })
    })
  })
})
