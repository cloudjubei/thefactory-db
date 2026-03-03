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
})
