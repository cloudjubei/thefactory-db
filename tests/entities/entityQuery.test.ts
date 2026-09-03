import { describe, it, expect } from 'vitest'

import { buildEntityMatchQuery, buildEntityCountQuery } from '../../src/client/entityQuery'

describe('entityQuery — buildEntityMatchQuery', () => {
  it('projects every Entity field and orders stably by default', () => {
    const q = buildEntityMatchQuery(undefined, { limit: 50 })
    expect(q.text).toContain('FROM entities')
    expect(q.text).toContain('project_id AS "projectId"')
    expect(q.text).toContain('should_embed AS "shouldEmbed"')
    expect(q.text).toContain('external_key AS "externalKey"')
    expect(q.text).toMatch(/ORDER BY[\s\S]*updated_at DESC, id ASC/)
    expect(q.text).toContain('LIMIT $1')
    expect(q.params).toEqual([50])
  })

  it('defaults to a limit of 100 when none is given', () => {
    const q = buildEntityMatchQuery(undefined)
    expect(q.text).toContain('LIMIT $1')
    expect(q.params).toEqual([100])
  })

  it('filters by projectIds / types / ids as bound array params', () => {
    const q = buildEntityMatchQuery(undefined, {
      projectIds: ['p1'],
      types: ['run'],
      ids: ['11111111-1111-1111-1111-111111111111'],
      limit: 10,
    })
    expect(q.text).toContain('project_id = ANY($1::text[])')
    expect(q.text).toContain('type = ANY($2::text[])')
    expect(q.text).toContain('id = ANY($3::uuid[])')
    expect(q.params).toEqual([['p1'], ['run'], ['11111111-1111-1111-1111-111111111111'], 10])
  })

  it('passes jsonb containment criteria as a bound jsonb param', () => {
    const q = buildEntityMatchQuery({ status: 'failed' }, { projectIds: ['p1'], limit: 10 })
    expect(q.text).toContain('content @> $2::jsonb')
    expect(q.params[1]).toBe(JSON.stringify({ status: 'failed' }))
  })

  it('compiles a numeric "greater than" predicate, matching only JSON numbers', () => {
    const q = buildEntityMatchQuery(undefined, {
      where: { field: 'metrics.total_return_pct', op: '>', value: 0 },
      limit: 10,
    })
    expect(q.text).toContain("jsonb_typeof(content #> $1::text[]) = 'number'")
    expect(q.text).toContain('(content #>> $1::text[])::numeric > $2::numeric')
    expect(q.params[0]).toEqual(['metrics', 'total_return_pct'])
    expect(q.params[1]).toBe(0)
  })

  it('compiles a text equality predicate', () => {
    const q = buildEntityMatchQuery(undefined, {
      where: { field: 'config.asset', op: '=', value: 'BTCUSDT' },
      limit: 10,
    })
    expect(q.text).toContain('(content #>> $1::text[]) = $2')
    expect(q.params).toEqual([['config', 'asset'], 'BTCUSDT', 10])
  })

  it('compiles an exists predicate with no value param', () => {
    const q = buildEntityMatchQuery(undefined, {
      where: { field: 'objective', op: 'exists' },
      limit: 10,
    })
    expect(q.text).toContain('(content #> $1::text[]) IS NOT NULL')
    expect(q.params).toEqual([['objective'], 10])
  })

  it('composes and/or/not boolean trees', () => {
    const q = buildEntityMatchQuery(undefined, {
      where: {
        and: [
          { field: 'metrics.n_trades', op: '>=', value: 2 },
          {
            or: [
              { field: 'objective', op: '>', value: 0 },
              { not: { field: 'status', op: '=', value: 'failed' } },
            ],
          },
        ],
      },
      limit: 10,
    })
    expect(q.text).toMatch(/\(.*AND.*\)/s)
    expect(q.text).toContain(' OR ')
    expect(q.text).toContain('NOT (')
    // 3 predicates -> 3 path params + 3 value params + limit
    expect(q.params).toEqual([
      ['metrics', 'n_trades'],
      2,
      ['objective'],
      0,
      ['status'],
      'failed',
      10,
    ])
  })

  it('orders by a numeric content field with NULLS LAST and the stable tiebreak', () => {
    const q = buildEntityMatchQuery(undefined, {
      orderBy: [{ field: 'objective', direction: 'desc', numeric: true }],
      limit: 25,
    })
    expect(q.text).toMatch(
      /ORDER BY \(CASE WHEN jsonb_typeof\(content #> \$1::text\[\]\) = 'number' THEN \(content #>> \$1::text\[\]\)::numeric END\) DESC NULLS LAST, updated_at DESC, id ASC/,
    )
    expect(q.params).toEqual([['objective'], 25])
  })

  it('orders by a text content field', () => {
    const q = buildEntityMatchQuery(undefined, {
      orderBy: [{ field: 'config.model_name', direction: 'asc' }],
      limit: 25,
    })
    expect(q.text).toContain('(content #>> $1::text[]) ASC NULLS LAST')
    expect(q.params).toEqual([['config', 'model_name'], 25])
  })

  it('appends LIMIT then OFFSET for pagination', () => {
    const q = buildEntityMatchQuery(undefined, { projectIds: ['p1'], limit: 50, offset: 100 })
    expect(q.text).toMatch(/LIMIT \$2 OFFSET \$3/)
    expect(q.params).toEqual([['p1'], 50, 100])
  })

  it('rejects an unsafe field path', () => {
    expect(() =>
      buildEntityMatchQuery(undefined, {
        where: { field: "x'); drop", op: '=', value: 1 },
        limit: 10,
      }),
    ).toThrow()
  })

  it('rejects an unknown operator', () => {
    expect(() =>
      buildEntityMatchQuery(undefined, {
        where: { field: 'x', op: 'like' as any, value: 1 },
        limit: 10,
      }),
    ).toThrow()
  })

  it('compiles contains (case-insensitive substring)', () => {
    const q = buildEntityMatchQuery(undefined, {
      where: { field: 'name', op: 'contains', value: 'swan' },
      limit: 10,
    })
    expect(q.text).toContain("(content #>> $1::text[]) ILIKE '%' || $2 || '%'")
    expect(q.params).toEqual([['name'], 'swan', 10])
  })

  it('compiles numeric and text inequality (!=)', () => {
    const numeric = buildEntityMatchQuery(undefined, {
      where: { field: 'objective', op: '!=', value: 0 },
      limit: 10,
    })
    expect(numeric.text).toContain('(content #>> $1::text[])::numeric <> $2::numeric')
    const text = buildEntityMatchQuery(undefined, {
      where: { field: 'status', op: '!=', value: 'ok' },
      limit: 10,
    })
    expect(text.text).toContain(
      '((content #>> $1::text[]) IS NOT NULL AND (content #>> $1::text[]) <> $2)',
    )
  })

  it('binds a boolean equality as its text form', () => {
    const q = buildEntityMatchQuery(undefined, {
      where: { field: 'flags.live', op: '=', value: true },
      limit: 10,
    })
    expect(q.text).toContain('(content #>> $1::text[]) = $2')
    expect(q.params).toEqual([['flags', 'live'], 'true', 10])
  })

  it('reduces an empty and to TRUE and an empty or to FALSE', () => {
    expect(buildEntityMatchQuery(undefined, { where: { and: [] }, limit: 10 }).text).toContain(
      '(TRUE)',
    )
    expect(buildEntityMatchQuery(undefined, { where: { or: [] }, limit: 10 }).text).toContain(
      '(FALSE)',
    )
  })

  it('rejects a malformed filter node (neither predicate nor and/or/not)', () => {
    expect(() =>
      buildEntityMatchQuery(undefined, { where: { bogus: 1 } as any, limit: 10 }),
    ).toThrow()
  })

  it('rejects an empty field path', () => {
    expect(() =>
      buildEntityMatchQuery(undefined, { where: { field: '', op: 'exists' }, limit: 10 }),
    ).toThrow()
  })
})

describe('entityQuery — content projection (omit push-down)', () => {
  it('drops a top-level content path via jsonb #- as a bound text[] param, guarded to object content', () => {
    const q = buildEntityMatchQuery(undefined, { omit: ['series'], limit: 10 })
    expect(q.text).toContain("CASE WHEN jsonb_typeof(content) = 'object'")
    expect(q.text).toContain('#- $1::text[]')
    expect(q.text).toContain('AS content')
    expect(q.text).toContain('LIMIT $2')
    expect(q.params).toEqual([['series'], 10])
  })

  it('drops a nested content path, guarding on the PARENT node being an object (matches JS omit)', () => {
    const q = buildEntityMatchQuery(undefined, { omit: ['artifacts.runChart'], limit: 10 })
    expect(q.text).toContain("jsonb_typeof(content #> $1::text[]) = 'object'")
    expect(q.text).toContain('#- $2::text[]')
    expect(q.params).toEqual([['artifacts'], ['artifacts', 'runChart'], 10])
  })

  it('chains multiple omit paths (top-level + nested) in one projected content column', () => {
    const q = buildEntityMatchQuery(undefined, {
      omit: ['series', 'artifacts.runChart'],
      limit: 10,
    })
    expect(q.text).toContain('#- $1::text[]')
    expect(q.text).toContain('jsonb_typeof(content #> $2::text[])')
    expect(q.text).toContain('#- $3::text[]')
    expect(q.text).toContain('LIMIT $4')
    expect(q.params).toEqual([['series'], ['artifacts'], ['artifacts', 'runChart'], 10])
  })

  it('selects the bare content column (no #-) and does not shift params when no omit is given', () => {
    const q = buildEntityMatchQuery(undefined, { projectIds: ['p1'], limit: 10 })
    expect(q.text).not.toContain('#-')
    expect(q.text).toContain('\n  content,')
    expect(q.text).toContain('project_id = ANY($1::text[])')
    expect(q.params).toEqual([['p1'], 10])
  })

  it('compiles the omit projection BEFORE the filter, so omit params precede where params', () => {
    const q = buildEntityMatchQuery(undefined, {
      omit: ['series'],
      projectIds: ['p1'],
      where: { field: 'status', op: '=', value: 'ok' },
      limit: 10,
    })
    expect(q.text).toContain('#- $1::text[]')
    expect(q.text).toContain('project_id = ANY($2::text[])')
    expect(q.text).toContain('(content #>> $3::text[]) = $4')
    expect(q.params).toEqual([['series'], ['p1'], ['status'], 'ok', 10])
  })

  it('rejects an unsafe omit path segment (never interpolates the path)', () => {
    expect(() => buildEntityMatchQuery(undefined, { omit: ["a'); drop"], limit: 10 })).toThrow()
  })

  it('guards EVERY ancestor (not just the parent) for a 3+ segment path, matching JS refuse-to-descend', () => {
    // JS omitPaths refuses to descend an array/scalar at ANY level, so removing a.b.c requires both a and
    // a.b to be objects — guarding only the immediate parent a.b would wrongly descend an array `a`.
    const q = buildEntityMatchQuery(undefined, { omit: ['a.b.c'], limit: 10 })
    expect(q.text).toContain("jsonb_typeof(content #> $1::text[]) = 'object'")
    expect(q.text).toContain("jsonb_typeof(content #> $2::text[]) = 'object'")
    expect(q.text).toContain('#- $3::text[]')
    expect(q.params).toEqual([['a'], ['a', 'b'], ['a', 'b', 'c'], 10])
  })
})

describe('entityQuery — buildEntityCountQuery', () => {
  it('counts with the same WHERE but no order/limit/offset', () => {
    const q = buildEntityCountQuery(undefined, {
      projectIds: ['p1'],
      where: { field: 'objective', op: '>', value: 0 },
      limit: 50,
      offset: 100,
    })
    expect(q.text).toMatch(/SELECT count\(\*\)::int AS count FROM entities/i)
    expect(q.text).toContain('project_id = ANY($1::text[])')
    expect(q.text).toContain('(content #>> $2::text[])::numeric > $3::numeric')
    expect(q.text).not.toMatch(/LIMIT|OFFSET|ORDER BY/)
    expect(q.params).toEqual([['p1'], ['objective'], 0])
  })
})
