import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'

import { openDatabase } from '../../src/index'

describe('Documents.listDocumentSrcs', () => {
  const { mockDbClient } = setupUnitTestMocks()

  it('returns every src stored for the project', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [{ src: 'a.ts' }, { src: 'dir/b.md' }] })

    const result = await db.listDocumentSrcs('p1')

    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', ['p1'])
    expect(result).toEqual(['a.ts', 'dir/b.md'])
  })

  it('returns an empty list for a project with no documents', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    expect(await db.listDocumentSrcs('p1')).toEqual([])
  })
})

describe('Documents.deleteDocumentsBySrc', () => {
  const { mockDbClient } = setupUnitTestMocks()

  it('deletes the named srcs of the project and returns how many rows went', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rowCount: 2 })

    const result = await db.deleteDocumentsBySrc('p1', ['a.ts', 'b.ts'])

    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', ['p1', ['a.ts', 'b.ts']])
    expect(result).toBe(2)
  })

  it('does not touch the database when there is nothing to delete', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockClear()

    expect(await db.deleteDocumentsBySrc('p1', [])).toBe(0)
    expect(mockDbClient.query).not.toHaveBeenCalled()
  })

  it('reads a missing rowCount as zero', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({})

    expect(await db.deleteDocumentsBySrc('p1', ['a.ts'])).toBe(0)
  })
})
