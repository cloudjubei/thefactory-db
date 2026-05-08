import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Entities.searchEntities', () => {
  const { mockDbClient, mockEmbeddingProvider } = setupUnitTestMocks()

  it('should perform a search', async () => {
    const db = await openDatabase({ connectionString: 'test' })

    mockDbClient.query.mockResolvedValue({ rows: [{ id: '1' }] })

    const res = await db.searchEntities({ query: 'q', projectIds: ['p1'] })

    expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith('q')
    expect(res).toEqual([{ id: '1' }])
  })

  it('returns [] for whitespace-only query', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const callsBefore = mockDbClient.query.mock.calls.length
    const res = await db.searchEntities({ query: '   ' } as any)
    expect(res).toEqual([])
    expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled()
    expect(mockDbClient.query.mock.calls.length).toBe(callsBefore)
  })

  it('forwards types/ids/projectIds into the filter JSON', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    await db.searchEntities({
      query: 'q',
      types: ['t1'],
      ids: ['e1'],
      projectIds: ['p1'],
    })

    const filterJson = mockDbClient.query.mock.calls.at(-1)[1][3]
    expect(JSON.parse(filterJson)).toEqual({
      types: ['t1'],
      ids: ['e1'],
      projectIds: ['p1'],
    })
  })

  it('omits empty filter arrays', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    await db.searchEntities({ query: 'q', types: [], ids: [], projectIds: [] })

    const filterJson = mockDbClient.query.mock.calls.at(-1)[1][3]
    expect(filterJson).toBe(JSON.stringify({}))
  })
})
