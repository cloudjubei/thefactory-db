import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openDatabase } from '../src/index'
import { openPostgres } from '../src/connection'
import { createLogger } from '../src/logger'
import { createLocalEmbeddingProvider } from '../src/utils/embeddings'
import { stringifyJsonValues } from '../src/utils/json'

// Mock dependencies
vi.mock('../src/connection')
vi.mock('../src/logger')
vi.mock('../src/utils/embeddings')
vi.mock('../src/utils/json')
vi.mock('../src/utils', () => ({
  SQL: new Proxy({}, { get: () => 'FAKE_SQL' }),
}))

describe('TheFactoryDb', () => {
  let mockDbClient: any
  let mockLogger: any
  let mockEmbeddingProvider: any

  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks()

    // Setup mock implementations
    mockDbClient = {
      query: vi.fn(),
      end: vi.fn(),
    }

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    mockEmbeddingProvider = {
      embed: vi.fn(),
      close: vi.fn(),
    }

    vi.mocked(openPostgres).mockResolvedValue(mockDbClient)
    vi.mocked(createLogger).mockReturnValue(mockLogger)
    vi.mocked(createLocalEmbeddingProvider).mockResolvedValue(mockEmbeddingProvider)
    vi.mocked(stringifyJsonValues).mockImplementation((val) => JSON.stringify(val))
    mockEmbeddingProvider.embed.mockResolvedValue(new Float32Array([0.1, 0.2, 0.3]))
  })

  describe('Entities', () => {
    it('addEntity should insert a new entity', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const entityInput = { projectId: 'p1', type: 't1', content: { a: 1 } }
      const expectedEntity = { ...entityInput, id: '123' }
      mockDbClient.query.mockResolvedValue({ rows: [expectedEntity] })

      const result = await db.addEntity(entityInput)

      expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith(JSON.stringify({ a: 1 }))
      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
        'p1',
        't1',
        { a: 1 },
        JSON.stringify({ a: 1 }),
        '[0.1,0.2,0.3]',
        null,
      ])
      expect(result).toEqual(expectedEntity)
    })

    it('getEntityById should return an entity if found', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const expectedEntity = { id: '123', projectId: 'p1', type: 't1', content: { a: 1 } }
      mockDbClient.query.mockResolvedValue({ rows: [expectedEntity] })

      const result = await db.getEntityById('123')

      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', ['123'])
      expect(result).toEqual(expectedEntity)
    })

    it('getEntityById should return undefined if not found', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [] })

      const result = await db.getEntityById('123')

      expect(result).toBeUndefined()
    })

    it('updateEntity should update an existing entity', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const existingEntity = { id: '123', content: { a: 1 } }
      const patch = { content: { b: 2 } }
      const updatedEntity = { ...existingEntity, ...patch }
      // Mock getEntityById and the update query
      mockDbClient.query
        .mockResolvedValueOnce({ rows: [existingEntity] })
        .mockResolvedValueOnce({ rows: [updatedEntity] })

      const result = await db.updateEntity('123', patch)

      expect(mockDbClient.query).toHaveBeenNthCalledWith(1, 'FAKE_SQL', ['123']) // for getEntityById
      expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith(JSON.stringify({ b: 2 }))
      expect(mockDbClient.query).toHaveBeenNthCalledWith(2, 'FAKE_SQL', [
        '123',
        null,
        { b: 2 },
        JSON.stringify({ b: 2 }),
        '[0.1,0.2,0.3]',
        null,
      ])
      expect(result).toEqual(updatedEntity)
    })

    it('updateEntity should return undefined if entity does not exist', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [] }) // getEntityById returns nothing

      const result = await db.updateEntity('123', { type: 't2' })
      expect(result).toBeUndefined()
      expect(mockDbClient.query).toHaveBeenCalledTimes(1) // only getEntityById
    })

    it('updateEntity should update without changing embedding if content is not provided', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const existingEntity = { id: '123', type: 't1', content: { a: 1 } }
      const patch = { type: 't2' }
      const updatedEntity = { ...existingEntity, ...patch }
      mockDbClient.query
        .mockResolvedValueOnce({ rows: [existingEntity] })
        .mockResolvedValueOnce({ rows: [updatedEntity] })

      const result = await db.updateEntity('123', patch)

      expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled()
      expect(mockDbClient.query).toHaveBeenNthCalledWith(2, 'FAKE_SQL', [
        '123',
        't2',
        null, // newContent
        null, // newContentString
        null, // embeddingLiteral
        null,
      ])
      expect(result).toEqual(updatedEntity)
    })

    it('updateEntity should return undefined if update query fails', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const existingEntity = { id: '123', type: 't1', content: { a: 1 } }
      const patch = { type: 't2' }
      mockDbClient.query
        .mockResolvedValueOnce({ rows: [existingEntity] })
        .mockResolvedValueOnce({ rows: [] }) // update returns empty

      const result = await db.updateEntity('123', patch)
      expect(result).toBeUndefined()
    })

    it('deleteEntity should return true if deleted', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rowCount: 1 })

      const result = await db.deleteEntity('123')

      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', ['123'])
      expect(result).toBe(true)
    })

    it('searchEntities should perform a search', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const searchParams = { query: 'test', projectIds: ['p1'] }
      mockDbClient.query.mockResolvedValue({ rows: [{ id: '1' }] })

      const result = await db.searchEntities(searchParams)

      expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith('test')
      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
        'test',
        '[0.1,0.2,0.3]',
        20,
        JSON.stringify({ projectIds: ['p1'] }),
        0.25, // textWeight / 2
        0.25, // keywordWeight = textWeight
        0.5, // semWeight = 1 - (text+keyword)
        50,
      ])
      expect(result).toEqual([{ id: '1' }])
    })

    it('searchEntities should return empty array for empty query', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const result = await db.searchEntities({ query: '   ' })
      expect(result).toEqual([])
      expect(mockDbClient.query).not.toHaveBeenCalled()
    })

    it('searchEntities should use types and ids filters', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const searchParams = { query: 'test', types: ['t1'], ids: ['1', '2'] }
      mockDbClient.query.mockResolvedValue({ rows: [] })
      await db.searchEntities(searchParams)
      const filter = JSON.parse(mockDbClient.query.mock.calls[0][1][3])
      expect(filter).toEqual({ types: ['t1'], ids: ['1', '2'] })
    })

    it('matchEntities should find entities by content', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [{ id: '1' }] })

      const result = await db.matchEntities({ a: 1 }, { projectIds: ['p1'] })

      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
        JSON.stringify({ a: 1 }),
        JSON.stringify({ projectIds: ['p1'] }),
        20,
      ])
      expect(result).toEqual([{ id: '1' }])
    })

    it('matchEntities should work with no criteria', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [] })
      await db.matchEntities(undefined, { projectIds: ['p1'] })
      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
        JSON.stringify({}),
        JSON.stringify({ projectIds: ['p1'] }),
        20,
      ])
    })

    it('matchEntities should work with no filters', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [] })
      await db.matchEntities({ a: 1 })
      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
        JSON.stringify({ a: 1 }),
        null,
        20,
      ])
    })

    it('clearEntities should clear all entities', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      await db.clearEntities()
      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL')
    })

    it('clearEntities should clear entities by project', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      await db.clearEntities(['p1'])
      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [['p1']])
    })
  })

  describe('Documents', () => {
    it('addDocument should insert a new document', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const docInput = { projectId: 'p1', type: 't1', name: 'Title', content: 'hello', src: 's1' }
      const expectedDoc = { ...docInput, id: '123' }
      mockDbClient.query.mockResolvedValue({ rows: [expectedDoc] })

      const result = await db.addDocument(docInput)

      expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith('hello')
      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
        'p1',
        't1',
        's1',
        'Title',
        'hello',
        '[0.1,0.2,0.3]',
        null,
      ])
      expect(result).toEqual(expectedDoc)
    })

    it('getDocumentById should return a document if found', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const expectedDoc = {
        id: '123',
        projectId: 'p1',
        type: 't1',
        name: 'Title',
        content: 'hello',
        src: 's1',
      }
      mockDbClient.query.mockResolvedValue({ rows: [expectedDoc] })

      const result = await db.getDocumentById('123')

      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', ['123'])
      expect(result).toEqual(expectedDoc)
    })

    it('getDocumentById should return undefined if not found', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [] })

      const result = await db.getDocumentById('123')

      expect(result).toBeUndefined()
    })

    it('getDocumentBySrc should return a document if found', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const expectedDoc = { id: '123', projectId: 'p1', type: 't1', name: 'Title', content: 'hello', src: 's1' }
      mockDbClient.query.mockResolvedValue({ rows: [expectedDoc] })

      const result = await db.getDocumentBySrc('p1', 's1')

      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', ['p1', 's1'])
      expect(result).toEqual(expectedDoc)
    })

    it('getDocumentBySrc should return undefined if not found', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [] })

      const result = await db.getDocumentBySrc('p1', 's1')

      expect(result).toBeUndefined()
    })

    it('upsertDocuments should return an empty array for no inputs', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const result = await db.upsertDocuments([])
      expect(result).toEqual([])
      expect(mockDbClient.query).not.toHaveBeenCalled()
    })

    it('upsertDocuments should do nothing if no documents have changed', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const inputs = [{ projectId: 'p1', src: 's1', content: 'c1', type: 't1', name: 'n1' }]
      // Mock getChangingDocuments to return empty set
      mockDbClient.query.mockResolvedValue({ rows: [] })

      const result = await db.upsertDocuments(inputs)

      expect(result).toEqual([])
      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', ['p1', ['s1'], ['c1']]) // getChangingDocuments
      // No other query calls
      expect(mockDbClient.query).toHaveBeenCalledTimes(1)
    })

    it('upsertDocuments should upsert documents that have changed', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const inputs = [
        { projectId: 'p1', src: 's1', content: 'new', type: 'md', name: 'n1' }, // changed
        { projectId: 'p1', src: 's2', content: 'same', type: 't2', name: 'n2' }, // unchanged
      ]
      const upsertedDoc = { ...inputs[0], id: '1' }

      // Mock getChangingDocuments to return 's1'
      mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's1' }] })
      // Mock the upsert query inside the transaction
      mockDbClient.query.mockResolvedValueOnce({ rows: [upsertedDoc] })

      const result = await db.upsertDocuments(inputs)

      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', ['p1', ['s1', 's2'], ['new', 'same']])
      expect(mockDbClient.query).toHaveBeenCalledWith('BEGIN')
      expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith('new n1 s1')
      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
        'p1',
        'md',
        's1',
        'n1',
        'new',
        '[0.1,0.2,0.3]',
        null,
      ])
      expect(mockDbClient.query).toHaveBeenCalledWith('COMMIT')
      expect(result).toEqual([upsertedDoc])
    })

    it('upsertDocuments should rollback transaction on error', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const inputs = [{ projectId: 'p1', src: 's1', content: 'new', type: 't1', name: 'n1' }]

      // Mock getChangingDocuments to return 's1'
      mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's1' }] })
      // Mock the upsert query to throw an error
      mockDbClient.query.mockRejectedValueOnce(new Error('DB error'))

      await expect(db.upsertDocuments(inputs)).rejects.toThrow('DB error')

      expect(mockDbClient.query).toHaveBeenCalledWith('BEGIN')
      expect(mockDbClient.query).toHaveBeenCalledWith('ROLLBACK')
      expect(mockDbClient.query).not.toHaveBeenCalledWith('COMMIT')
    })

    it('upsertDocument should call upsertDocuments with a single item', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const input = { projectId: 'p1', src: 's1', content: 'c1', type: 't1', name: 'n1' }
      const upsertedDoc = { ...input, id: '1' }

      // Mock getChangingDocuments
      mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's1' }] })
      // Mock upsert
      mockDbClient.query.mockResolvedValueOnce({ rows: [upsertedDoc] })

      const result = await db.upsertDocument(input)
      expect(result).toEqual(upsertedDoc)
      expect(mockDbClient.query).toHaveBeenCalledWith('BEGIN')
      expect(mockDbClient.query).toHaveBeenCalledWith('COMMIT')
    })

    it('updateDocument should update an existing document', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const existingDoc = { id: '123', name: 'Title', content: 'old' }
      const patch = { content: 'new' }
      const updatedDoc = { ...existingDoc, ...patch }
      mockDbClient.query
        .mockResolvedValueOnce({ rows: [existingDoc] })
        .mockResolvedValueOnce({ rows: [updatedDoc] })

      const result = await db.updateDocument('123', patch)

      expect(mockDbClient.query).toHaveBeenNthCalledWith(1, 'FAKE_SQL', ['123']) // for getDocumentById
      expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith('new')
      expect(mockDbClient.query).toHaveBeenNthCalledWith(2, 'FAKE_SQL', [
        '123',
        null,
        null,
        null,
        'new',
        '[0.1,0.2,0.3]',
        null,
      ])
      expect(result).toEqual(updatedDoc)
    })

    it('updateDocument should return undefined if document does not exist', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [] }) // getDocumentById returns nothing

      const result = await db.updateDocument('123', { name: 'new name' })
      expect(result).toBeUndefined()
      expect(mockDbClient.query).toHaveBeenCalledTimes(1) // only getDocumentById
    })

    it('updateDocument should update without changing embedding if content is not provided', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const existingDoc = { id: '123', name: 'Title', content: 'old' }
      const patch = { name: 'new name' }
      const updatedDoc = { ...existingDoc, ...patch }
      mockDbClient.query
        .mockResolvedValueOnce({ rows: [existingDoc] })
        .mockResolvedValueOnce({ rows: [updatedDoc] })

      const result = await db.updateDocument('123', patch)

      expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled()
      expect(mockDbClient.query).toHaveBeenNthCalledWith(2, 'FAKE_SQL', [
        '123',
        null,
        null,
        'new name',
        null, // newContent
        null, // embeddingLiteral
        null,
      ])
      expect(result).toEqual(updatedDoc)
    })

    it('updateDocument should return undefined if update fails', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const existingDoc = { id: '123', name: 'Title', content: 'old' }
      const patch = { content: 'new' }

      mockDbClient.query
        .mockResolvedValueOnce({ rows: [existingDoc] }) // get by id
        .mockResolvedValueOnce({ rows: [] }) // update returns empty

      const result = await db.updateDocument('123', patch)
      expect(result).toBeUndefined()
      expect(mockLogger.warn).toHaveBeenCalledWith('updateDocument failed: document not found', { id: '123' })
    })

    it('deleteDocument should return true if deleted', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rowCount: 1 })

      const result = await db.deleteDocument('123')

      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', ['123'])
      expect(result).toBe(true)
    })

    it('searchDocuments should perform a search', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const searchParams = { query: 'test', projectIds: ['p1'] }
      mockDbClient.query.mockResolvedValue({ rows: [{ id: '1' }] })

      const result = await db.searchDocuments(searchParams)

      expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith('test')
      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
        'test',
        '[0.1,0.2,0.3]',
        20,
        JSON.stringify({ projectIds: ['p1'] }),
        10,
        0.25,
        0.25,
        0.5,
        50,
      ])
      expect(result).toEqual([{ id: '1' }])
    })

    it('searchDocuments should return empty array for empty query', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const result = await db.searchDocuments({ query: ' ' })
      expect(result).toEqual([])
      expect(mockDbClient.query).not.toHaveBeenCalled()
    })

    it('searchDocuments should use types and ids filters', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const searchParams = { query: 'test', types: ['t1'], ids: ['1', '2'] }
      mockDbClient.query.mockResolvedValue({ rows: [] })
      await db.searchDocuments(searchParams)
      const filter = JSON.parse(mockDbClient.query.mock.calls[0][1][3])
      expect(filter).toEqual({ types: ['t1'], ids: ['1', '2'] })
    })

    it('matchDocuments should find documents by filters', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [{ id: '1' }] })

      const result = await db.matchDocuments({ projectIds: ['p1'] })

      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
        JSON.stringify({ projectIds: ['p1'] }),
        20,
      ])
      expect(result).toEqual([{ id: '1' }])
    })

    it('matchDocuments should work with no filters', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [] })
      await db.matchDocuments({})
      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [null, 20])
    })

    it('clearDocuments should clear documents by project', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      await db.clearDocuments(['p1'])
      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [['p1']])
    })

    it('clearDocuments should clear all documents', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      await db.clearDocuments()
      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL')
    })
  })

  it('close should end the database connection', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    await db.close()
    expect(mockDbClient.end).toHaveBeenCalledOnce()
  })

  it('close should ignore embedding provider close errors', async () => {
    mockEmbeddingProvider.close.mockRejectedValue(new Error('close error'))

    const db = await openDatabase({ connectionString: 'test' })
    await db.close()

    expect(mockEmbeddingProvider.close).toHaveBeenCalled()
    expect(mockDbClient.end).toHaveBeenCalled() // Should still be called
  })
})
