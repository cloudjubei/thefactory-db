import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Entities.matchEntities', () => {
  const { mockDbClient } = setupUnitTestMocks()

  it('should find entities by criteria (and include optional filter + limit)', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [{ id: '1' }] })

    const result = await db.matchEntities({ projectIds: ['p1'] })

    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
      JSON.stringify({ projectIds: ['p1'] }),
      null,
      20,
    ])
    expect(result).toEqual([{ id: '1' }])
  })

  it('should work with empty criteria', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    await db.matchEntities({})
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [JSON.stringify({}), null, 20])
  })

  it('should pass filter json when options include projectIds', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    await db.matchEntities({}, { projectIds: ['p1'], limit: 10 })
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
      JSON.stringify({}),
      JSON.stringify({ projectIds: ['p1'] }),
      10,
    ])
  })
})
