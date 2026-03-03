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
})
