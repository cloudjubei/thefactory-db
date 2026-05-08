import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Documents.searchDocuments', () => {
  const { mockDbClient, mockEmbeddingProvider } = setupUnitTestMocks()

  it('searchDocuments should embed query and pass weights', async () => {
    const db = await openDatabase({ connectionString: 'test' })

    mockDbClient.query.mockResolvedValue({ rows: [] })

    await db.searchDocuments({ query: 'test', projectIds: ['p1'], vectorWeight: 2 })

    expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith('test')

    // Implementation detail:
    // textWeight is clamped to [0,1], then divided by 2.
    // keywordWeight === textWeight.
    // semWeight = 1 - (textWeight + keywordWeight)
    // So with default textWeight=0.5 => 0.25, keyword=0.25, sem=0.5
    expect(mockDbClient.query.mock.calls[0][1][5]).toBe(0.25)
    expect(mockDbClient.query.mock.calls[0][1][6]).toBe(0.25)
    expect(mockDbClient.query.mock.calls[0][1][7]).toBe(0.5)
  })

  it('searchDocuments should clamp and transform textWeight', async () => {
    const db = await openDatabase({ connectionString: 'test' })

    mockDbClient.query.mockResolvedValue({ rows: [] })

    await db.searchDocuments({ query: 'test', projectIds: ['p1'], textWeight: 1 })

    // textWeight=1 => 0.5, keyword=0.5, sem=0
    expect(mockDbClient.query.mock.calls[0][1][5]).toBe(0.5)
    expect(mockDbClient.query.mock.calls[0][1][6]).toBe(0.5)
    expect(mockDbClient.query.mock.calls[0][1][7]).toBe(0)
  })

  it('searchDocuments should pass {} filter when no filters provided', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    await db.searchDocuments({ query: 'test' })

    // Hybrid query is first call
    const filterJson = mockDbClient.query.mock.calls[0][1][3]
    expect(filterJson).toBe(JSON.stringify({}))
    // Name query is second call
    const filterJson2 = mockDbClient.query.mock.calls[1][1][2]
    expect(filterJson2).toBe(JSON.stringify({}))
  })

  it('searchDocuments should return deduped results across name + hybrid (name first)', async () => {
    const db = await openDatabase({ connectionString: 'test' })

    // 1st call = hybrid query, 2nd call = name query
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [{ id: '1' }, { id: '2' }] })
      .mockResolvedValueOnce({ rows: [{ id: '2' }, { id: '3' }] })

    const res = await db.searchDocuments({ query: 'test', projectIds: ['p1'], limit: 20 })

    // Merge alternates name/hybrid, starting with name.
    // Name: [2,3], Hybrid: [1,2] => [2(name), 1(hybrid), 3(name)]
    expect(res).toEqual([{ id: '2' }, { id: '1' }, { id: '3' }])
  })

  it('searchDocuments should return rows unchanged (including vecScore=0)', async () => {
    const db = await openDatabase({ connectionString: 'test' })

    mockDbClient.query
      .mockResolvedValueOnce({ rows: [{ id: '1', vecScore: 0, totalScore: 0.1 }] })
      .mockResolvedValueOnce({ rows: [] })

    const res = await db.searchDocuments({ query: 'test', projectIds: ['p1'] })
    expect(res).toEqual([{ id: '1', vecScore: 0, totalScore: 0.1 }])
  })

  it('returns [] for whitespace-only query without hitting the embedder or db', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const callsBefore = mockDbClient.query.mock.calls.length
    const res = await db.searchDocuments({ query: '   ' } as any)
    expect(res).toEqual([])
    expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled()
    expect(mockDbClient.query.mock.calls.length).toBe(callsBefore)
  })

  it('forwards every filter (types/ids/projectIds) into the hybrid filter JSON', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    await db.searchDocuments({
      query: 'q',
      types: ['t1'],
      ids: ['i1'],
      projectIds: ['p1'],
    })

    const filterJson = mockDbClient.query.mock.calls[0][1][3]
    const parsed = JSON.parse(filterJson)
    expect(parsed).toEqual({ types: ['t1'], ids: ['i1'], projectIds: ['p1'] })
  })

  it('falls back to remaining name matches when hybrid is exhausted on a !pickName turn', async () => {
    const db = await openDatabase({ connectionString: 'test' })

    // 1st call = hybrid (1 row), 2nd call = name (5 rows).
    mockDbClient.query.mockResolvedValueOnce({ rows: [{ id: 'h1' }] }).mockResolvedValueOnce({
      rows: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }, { id: 'n4' }, { id: 'n5' }],
    })

    const res = await db.searchDocuments({ query: 'q', limit: 20 })

    // pickName starts true, alternates. With name=[n1..n5], hybrid=[h1]:
    //   take n1 (name), h1 (hybrid), n2 (name), then !pickName but hybrid empty → fallback to name → n3, name → n4, !pickName but empty → name → n5.
    expect(res).toEqual([
      { id: 'n1' },
      { id: 'h1' },
      { id: 'n2' },
      { id: 'n3' },
      { id: 'n4' },
      { id: 'n5' },
    ])
  })

  it('dedupes a row that appears in both hybrid and name', async () => {
    const db = await openDatabase({ connectionString: 'test' })

    mockDbClient.query
      .mockResolvedValueOnce({ rows: [{ id: 'shared' }, { id: 'h2' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'shared' }, { id: 'n2' }] })

    const res = await db.searchDocuments({ query: 'q', limit: 20 })
    const ids = res.map((r: any) => r.id)
    // pickName starts true → take name[0]=shared (out=[shared], seen={shared}).
    // !pickName → hybrid[0]=shared (deduped, skipped). pickName flips back to true.
    // pickName → name[1]=n2 (out=[shared,n2]). !pickName → hybrid[1]=h2 (out=[shared,n2,h2]).
    expect(ids).toEqual(['shared', 'n2', 'h2'])
  })

  it('respects the limit when both lists have plenty of rows', async () => {
    const db = await openDatabase({ connectionString: 'test' })

    mockDbClient.query
      .mockResolvedValueOnce({ rows: [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }] })

    const res = await db.searchDocuments({ query: 'q', limit: 3 })
    expect(res.length).toBe(3)
  })
})
