import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openDatabase } from '../src/index'
import { openPostgres } from '../src/connection'
import { createLogger } from '../src/logger'
import { createLocalEmbeddingProvider } from '../src/utils/embeddings'
import { readSql } from '../src/utils'
import { stringifyJsonValues } from '../src/utils/json'

// Mock dependencies
vi.mock('../src/connection')
vi.mock('../src/logger')
vi.mock('../src/utils/embeddings')
vi.mock('../src/utils')
vi.mock('../src/utils/json')

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
    }

    vi.mocked(openPostgres).mockResolvedValue(mockDbClient)
    vi.mocked(createLogger).mockReturnValue(mockLogger)
    vi.mocked(createLocalEmbeddingProvider).mockResolvedValue(mockEmbeddingProvider)
    vi.mocked(readSql).mockReturnValue('FAKE_SQL')
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

      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', ['123']) // for getEntityById
      expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith(JSON.stringify({ b: 2 }))
      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
        '123',
        null,
        { b: 2 },
        JSON.stringify({ b: 2 }),
        '[0.1,0.2,0.3]',
        null,
      ])
      expect(result).toEqual(updatedEntity)
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
        0.5,
        0.5,
        50,
      ])
      expect(result).toEqual([{ id: '1' }])
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

    it('clearEntities should clear all entities', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      await db.clearEntities()
      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL')
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
        'Title',
        'hello',
        's1',
        '[0.1,0.2,0.3]',
        null,
      ])
      expect(result).toEqual(expectedDoc)
    })

    it('getDocumentById should return a document if found', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const expectedDoc = { id: '123', projectId: 'p1', type: 't1', name: 'Title', content: 'hello', src: 's1' }
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

    it('updateDocument should update an existing document', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      const existingDoc = { id: '123', name: 'Title', content: 'old' }
      const patch = { content: 'new' }
      const updatedDoc = { ...existingDoc, ...patch }
      mockDbClient.query
        .mockResolvedValueOnce({ rows: [existingDoc] })
        .mockResolvedValueOnce({ rows: [updatedDoc] })

      const result = await db.updateDocument('123', patch)

      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', ['123']) // for getDocumentById
      expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith('new')
      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
        '123',
        null,
        null,
        'new',
        null,
        '[0.1,0.2,0.3]',
        null,
      ])
      expect(result).toEqual(updatedDoc)
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
        0.5,
        0.5,
        50,
      ])
      expect(result).toEqual([{ id: '1' }])
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

    it('clearDocuments should clear documents by project', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      await db.clearDocuments(['p1'])
      expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [['p1']])
    })
  })

  it('close should end the database connection', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    await db.close()
    expect(mockDbClient.end).toHaveBeenCalledOnce()
  })

  it('raw should return the raw client', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const rawClient = db.raw()
    expect(rawClient).toBe(mockDbClient)
  })
})
