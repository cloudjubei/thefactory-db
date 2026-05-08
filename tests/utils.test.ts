import { describe, it, expect } from 'vitest'
import {
  SQL,
  prepareQuery,
  normalizeDocPath,
  normalizePathPrefix,
  escapeLikePattern,
  toTokens,
  buildEmbeddingTextForDoc,
  toVectorLiteral,
} from '../src/utils'

describe('utils.prepareQuery', () => {
  it('coerces null/undefined to an empty string', () => {
    expect(prepareQuery(undefined as any)).toBe('')
    expect(prepareQuery(null as any)).toBe('')
  })

  it('trims surrounding whitespace from a real string', () => {
    expect(prepareQuery('  hello  ')).toBe('hello')
  })
})

describe('utils.normalizeDocPath', () => {
  it('returns the input unchanged when it is empty/falsy', () => {
    expect(normalizeDocPath('')).toBe('')
    expect(normalizeDocPath(undefined as any)).toBe(undefined as any)
  })

  it('normalizes Windows separators and strips a leading "./"', () => {
    expect(normalizeDocPath('./a\\b\\c.ts')).toBe('a/b/c.ts')
    expect(normalizeDocPath('a/b.ts')).toBe('a/b.ts')
  })
})

describe('utils.normalizePathPrefix', () => {
  it('returns undefined for an empty/missing prefix', () => {
    expect(normalizePathPrefix(undefined)).toBeUndefined()
    expect(normalizePathPrefix('')).toBeUndefined()
  })

  it('returns undefined when normalization collapses to nothing', () => {
    expect(normalizePathPrefix('/')).toBeUndefined()
  })

  it('strips a leading slash and normalizes separators', () => {
    expect(normalizePathPrefix('/src\\components')).toBe('src/components')
  })
})

describe('utils.escapeLikePattern', () => {
  it('escapes backslash, percent, and underscore for LIKE patterns', () => {
    expect(escapeLikePattern('a_b%c\\d')).toBe('a\\_b\\%c\\\\d')
  })
})

describe('utils.toTokens', () => {
  it('trims and filters when given a string array', () => {
    expect(toTokens([' a ', '', 'b'])).toEqual(['a', 'b'])
  })

  it('splits on commas/semicolons and drops empties', () => {
    expect(toTokens('a, b ; ;c,')).toEqual(['a', 'b', 'c'])
  })
})

describe('utils.buildEmbeddingTextForDoc', () => {
  it('joins type/name/src/content with newlines and skips falsy parts', () => {
    expect(buildEmbeddingTextForDoc('t', 'body', undefined, undefined)).toBe('t\nbody')
    expect(buildEmbeddingTextForDoc('t', 'body', 'name', 'src')).toBe('t\nname\nsrc\nbody')
  })
})

describe('utils.toVectorLiteral', () => {
  it('stringifies numeric arrays and Float32Array alike', () => {
    expect(toVectorLiteral([1, 2, 3])).toBe('[1,2,3]')
    expect(toVectorLiteral(new Float32Array([0.5, 0.25]))).toBe('[0.5,0.25]')
  })
})

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
      'clearEntitiesByProject',
      'clearEntitiesByProjectAndType',
      // documents
      'insertDocument',
      'getDocumentById',
      'getDocumentBySrc',
      'deleteDocument',
      'updateDocument',
      'upsertDocument',
      'searchDocumentsForPaths',
      'searchDocumentsForKeywords',
      'searchDocumentsForExact',
      'searchDocumentsQuery',
      'searchDocumentsByName',
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
