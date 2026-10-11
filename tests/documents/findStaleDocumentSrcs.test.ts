import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'

import { CHUNKER_VERSION } from '../../src/chunking/chunkingConstants'
import { openDatabase } from '../../src/index'

describe('Documents.findStaleDocumentSrcs', () => {
  const { mockDbClient } = setupUnitTestMocks()

  it('sends the sources as parallel src and fingerprint arrays and returns the stale srcs', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [{ src: 'b.ts' }] })

    const result = await db.findStaleDocumentSrcs('p1', [
      { src: 'a.ts', fingerprint: '1:1' },
      { src: 'b.ts', fingerprint: '2:2' },
    ])

    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
      'p1',
      ['a.ts', 'b.ts'],
      ['1:1', '2:2'],
      CHUNKER_VERSION,
    ])
    expect(result).toEqual(['b.ts'])
  })

  it('does not touch the database when given no sources', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const before = mockDbClient.query.mock.calls.length

    expect(await db.findStaleDocumentSrcs('p1', [])).toEqual([])
    expect(mockDbClient.query.mock.calls.length).toBe(before)
  })

  it('leaves out sources whose only fault is an older chunk version when asked to', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    await db.findStaleDocumentSrcs('p1', [{ src: 'a.ts', fingerprint: '1:1' }], {
      includeOutdatedChunks: false,
    })

    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', ['p1', ['a.ts'], ['1:1'], null])
  })
})
