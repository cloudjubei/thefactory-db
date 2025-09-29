import { describe, it, expect } from 'vitest'
import { SQL } from '../src/utils'

// Basic sanity checks for embedded SQL registry

describe('utils.SQL registry', () => {
  it('contains required SQL keys and non-empty strings', () => {
    const requiredKeys = [
      // schema and hybrid
      'schema',
      'hybridSearch',
      // entities
      'insertEntity',
      'getEntityById',
      'deleteEntity',
      'updateEntity',
      'searchEntitiesQuery',
      'matchEntities',
      'clearEntities',
      'clearEntitiesByProject',
      // documents
      'insertDocument',
      'getDocumentById',
      'getDocumentBySrc',
      'deleteDocument',
      'updateDocument',
      'upsertDocument',
      'searchDocumentsQuery',
      'matchDocuments',
      'clearDocuments',
      'clearDocumentsByProject',
    ] as const

    for (const k of requiredKeys) {
      const sql = (SQL as any)[k]
      expect(typeof sql).toBe('string')
      expect(sql.length).toBeGreaterThan(0)
    }
  })
})
