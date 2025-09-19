import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as utils from '../src/utils'

// Polyfill atob for Node environment
const originalAtob = (globalThis as any).atob
beforeAll(() => {
  ;(globalThis as any).atob = (b64: string) => Buffer.from(b64, 'base64').toString('binary')
})
afterAll(() => {
  ;(globalThis as any).atob = originalAtob
})

describe('utils.readSql', () => {
  it('returns SQL string for known keys', () => {
    const keys = [
      'schema',
      'hybridSearch',
      'insertEntity',
      'getEntityById',
      'deleteEntity',
      'updateEntity',
      'searchEntitiesQuery',
      'matchEntities',
      'clearEntities',
      'clearEntitiesByProject',
      'insertDocument',
      'getDocumentById',
      'getDocumentBySrc',
      'deleteDocument',
      'updateDocument',
      'searchDocumentsQuery',
      'matchDocuments',
      'clearDocuments',
      'clearDocumentsByProject',
    ]
    for (const k of keys) {
      const sql = utils.readSql(k)
      expect(typeof sql).toBe('string')
      expect(sql).toBeTruthy()
    }
  })

  it('returns undefined for unknown keys', () => {
    const sql = utils.readSql('not-a-real-key')
    expect(sql).toBeUndefined()
  })
})

describe('utils.base64ToUtf8', () => {
  it('decodes plain base64 strings', () => {
    const helloB64 = Buffer.from('hello world').toString('base64')
    expect(utils.base64ToUtf8(helloB64)).toBe('hello world')
  })

  it('decodes data URI base64 strings', () => {
    const txt = 'sample text!'
    const b64 = Buffer.from(txt).toString('base64')
    const dataUri = `data:text/plain;base64,${b64}`
    expect(utils.base64ToUtf8(dataUri)).toBe(txt)
  })
})
