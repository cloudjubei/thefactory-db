import { describe, it, expect } from 'vitest'
import {
  assertDocumentInput,
  assertDocumentPatch,
  assertEntityInput,
  assertEntityPatch,
  assertMatchParams,
  assertSearchParams,
  assertSearchDocumentsForExactArgs,
  assertSearchDocumentsForKeywordsArgs,
  assertSearchDocumentsForPathsArgs,
  assertSearchEntitiesForKeywordsArgs,
  assertSearchEntitiesForExactArgs,
} from '../src/validation'

describe('validation', () => {
  describe('assertDocumentInput', () => {
    it('accepts valid input', () => {
      expect(() =>
        assertDocumentInput({
          projectId: 'p',
          type: 't',
          src: 's',
          name: 'n',
          content: 'c',
          metadata: { a: 1 },
        }),
      ).not.toThrow()
    })
    it('rejects invalid shapes', () => {
      expect(() => assertDocumentInput(null as any)).toThrow()
      expect(() => assertDocumentInput({} as any)).toThrow()
      expect(() =>
        assertDocumentInput({ projectId: '', type: 't', src: 's', content: 'c' }),
      ).toThrow()
      expect(() =>
        assertDocumentInput({ projectId: 'p', type: '', src: 's', content: 'c' }),
      ).toThrow()
      expect(() =>
        assertDocumentInput({ projectId: 'p', type: 't', src: '', content: 'c' }),
      ).toThrow()
      expect(() =>
        assertDocumentInput({ projectId: 'p', type: 't', src: 's', content: 1 as any }),
      ).toThrow()
      expect(() =>
        assertDocumentInput({ projectId: 'p', type: 't', src: 's', metadata: 'x' as any }),
      ).toThrow()
    })
  })

  describe('assertDocumentPatch', () => {
    it('accepts valid patch values', () => {
      expect(() =>
        assertDocumentPatch({ type: 'x', content: 'y', src: null, metadata: null }),
      ).not.toThrow()
    })
    it('rejects invalid patch', () => {
      expect(() => assertDocumentPatch(null as any)).toThrow()
      expect(() => assertDocumentPatch({ projectId: 'nope' } as any)).toThrow()
      expect(() => assertDocumentPatch({ type: 1 as any })).toThrow()
      expect(() => assertDocumentPatch({ content: 123 as any })).toThrow()
      expect(() => assertDocumentPatch({ src: 123 as any })).toThrow()
      expect(() => assertDocumentPatch({ metadata: 1 as any })).toThrow()
    })
  })

  describe('assertEntityInput', () => {
    it('accepts valid entity input', () => {
      expect(() =>
        assertEntityInput({ projectId: 'p', type: 't', content: { a: 1 }, metadata: { k: 'v' } }),
      ).not.toThrow()
      expect(() =>
        assertEntityInput({ projectId: 'p', type: 't', content: [1, 2, 3] }),
      ).not.toThrow()
    })
    it('accepts a string or null externalKey', () => {
      expect(() =>
        assertEntityInput({ projectId: 'p', type: 't', content: {}, externalKey: 'AAPL' }),
      ).not.toThrow()
      expect(() =>
        assertEntityInput({ projectId: 'p', type: 't', content: {}, externalKey: null }),
      ).not.toThrow()
    })
    it('rejects invalid entity input', () => {
      expect(() => assertEntityInput(null as any)).toThrow()
      expect(() => assertEntityInput({} as any)).toThrow()
      expect(() => assertEntityInput({ projectId: '', type: 't', content: {} })).toThrow()
      expect(() => assertEntityInput({ projectId: 'p', type: '', content: {} })).toThrow()
      expect(() =>
        assertEntityInput({ projectId: 'p', type: 't', content: 'nope' as any }),
      ).toThrow()
      expect(() =>
        assertEntityInput({ projectId: 'p', type: 't', content: {}, metadata: 'x' as any }),
      ).toThrow()
      expect(() =>
        assertEntityInput({ projectId: 'p', type: 't', content: {}, externalKey: 42 as any }),
      ).toThrow()
    })
  })

  describe('assertEntityPatch', () => {
    it('accepts valid patches', () => {
      expect(() => assertEntityPatch({ type: 'x', content: null, metadata: null })).not.toThrow()
      expect(() => assertEntityPatch({ content: { a: 1 } })).not.toThrow()
      expect(() => assertEntityPatch({ content: [1, 2] })).not.toThrow()
    })
    it('rejects invalid patches', () => {
      expect(() => assertEntityPatch(null as any)).toThrow()
      expect(() => assertEntityPatch({ projectId: 'nope' } as any)).toThrow()
      expect(() => assertEntityPatch({ type: 1 as any })).toThrow()
      expect(() => assertEntityPatch({ content: 1 as any })).toThrow()
      expect(() => assertEntityPatch({ metadata: 1 as any })).toThrow()
    })
  })

  describe('assertMatchParams', () => {
    it('accepts valid options', () => {
      expect(() => assertMatchParams(undefined)).not.toThrow()
      expect(() =>
        assertMatchParams({ limit: 10, types: ['a'], ids: ['1'], projectIds: ['p'] }),
      ).not.toThrow()
    })
    it('rejects invalid options', () => {
      expect(() => assertMatchParams(null as any)).toThrow()
      expect(() => assertMatchParams({ types: [1] as any })).toThrow()
      expect(() => assertMatchParams({ ids: [1] as any })).toThrow()
      expect(() => assertMatchParams({ projectIds: [1] as any })).toThrow()
    })
  })

  describe('assertSearchParams', () => {
    it('accepts valid search params', () => {
      expect(() => assertSearchParams({ query: 'q' })).not.toThrow()
      expect(() => assertSearchParams({ query: 'q', textWeight: 0.3, limit: 5 })).not.toThrow()
    })
    it('rejects invalid search params', () => {
      expect(() => assertSearchParams({} as any)).toThrow()
      expect(() => assertSearchParams({ query: 1 } as any)).toThrow()
      expect(() => assertSearchParams({ query: 'q', textWeight: '1' } as any)).toThrow()
    })
  })

  describe('assertSearchDocumentsForPathsArgs', () => {
    it('accepts valid args', () => {
      expect(() =>
        assertSearchDocumentsForPathsArgs({ projectIds: ['p'], query: 'file.ts', limit: 10 }),
      ).not.toThrow()
    })
    it('rejects invalid args', () => {
      expect(() => assertSearchDocumentsForPathsArgs(null as any)).toThrow()
      expect(() => assertSearchDocumentsForPathsArgs({} as any)).toThrow()
      expect(() =>
        assertSearchDocumentsForPathsArgs({ projectIds: [], query: 'x' } as any),
      ).toThrow()
      expect(() =>
        assertSearchDocumentsForPathsArgs({ projectIds: ['p'], query: 1 as any } as any),
      ).toThrow()
      expect(() =>
        assertSearchDocumentsForPathsArgs({ projectIds: ['p'], query: 'x', limit: 1.2 } as any),
      ).toThrow()
    })
  })

  describe('assertSearchDocumentsForKeywordsArgs', () => {
    it('accepts valid args', () => {
      expect(() =>
        assertSearchDocumentsForKeywordsArgs({ projectIds: ['p'], keywords: 'a, b' }),
      ).not.toThrow()
      expect(() =>
        assertSearchDocumentsForKeywordsArgs({
          projectIds: ['p'],
          keywords: ['a', 'b'],
          matchMode: 'all',
          limit: 5,
          pathPrefix: 'src',
        }),
      ).not.toThrow()
    })
    it('rejects invalid args', () => {
      expect(() => assertSearchDocumentsForKeywordsArgs(null as any)).toThrow()
      expect(() => assertSearchDocumentsForKeywordsArgs({} as any)).toThrow()
      expect(() =>
        assertSearchDocumentsForKeywordsArgs({ projectIds: [], keywords: 'a' } as any),
      ).toThrow()
      expect(() =>
        assertSearchDocumentsForKeywordsArgs({ projectIds: ['p'], keywords: 1 as any }),
      ).toThrow()
      expect(() =>
        assertSearchDocumentsForKeywordsArgs({
          projectIds: ['p'],
          keywords: 'a',
          matchMode: 'maybe' as any,
        }),
      ).toThrow()
    })
  })

  describe('branch edge cases', () => {
    it('rejects DocumentInput.src that is not a string at all', () => {
      expect(() =>
        assertDocumentInput({ projectId: 'p', type: 't', name: 'n', src: 5 as any, content: 'c' }),
      ).toThrow()
    })

    it('rejects DocumentInput.name that is not a string', () => {
      expect(() =>
        assertDocumentInput({ projectId: 'p', type: 't', name: 5 as any, src: 's', content: 'c' }),
      ).toThrow()
    })

    it('accepts DocumentInput with no metadata field at all', () => {
      expect(() =>
        assertDocumentInput({ projectId: 'p', type: 't', name: 'n', src: 's', content: 'c' }),
      ).not.toThrow()
    })

    it('rejects DocumentInput.metadata that is not a plain object', () => {
      expect(() =>
        assertDocumentInput({
          projectId: 'p',
          type: 't',
          name: 'n',
          src: 's',
          content: 'c',
          metadata: 'oops' as any,
        }),
      ).toThrow(/metadata must be an object/i)
    })

    it('accepts DocumentPatch with name=null and src=null and content=null', () => {
      expect(() =>
        assertDocumentPatch({ name: null as any, src: null as any, content: null as any }),
      ).not.toThrow()
    })

    it('rejects DocumentPatch.name that is neither string nor null', () => {
      expect(() => assertDocumentPatch({ name: 5 as any })).toThrow()
    })

    it('rejects EntityPatch.type that is neither string nor null', () => {
      expect(() => assertEntityPatch({ type: 5 as any })).toThrow()
    })

    it('accepts EntityPatch with type=null', () => {
      expect(() => assertEntityPatch({ type: null as any })).not.toThrow()
    })

    it('rejects EntityPatch.content scalar', () => {
      expect(() => assertEntityPatch({ content: 'nope' as any })).toThrow()
    })

    it('rejects MatchParams.limit that is not an integer', () => {
      expect(() => assertMatchParams({ limit: 1.5 } as any)).toThrow()
    })

    it('throws when SearchParams is undefined or null', () => {
      expect(() => assertSearchParams(undefined as any)).toThrow('Params must be present')
      expect(() => assertSearchParams(null as any)).toThrow()
    })

    it('rejects null args for entity search assertions', () => {
      expect(() => assertSearchEntitiesForKeywordsArgs(null as any)).toThrow()
      expect(() => assertSearchEntitiesForExactArgs(null as any)).toThrow()
    })

    it('accepts assertSearchEntitiesForKeywordsArgs with all optional fields populated', () => {
      expect(() =>
        assertSearchEntitiesForKeywordsArgs({
          projectIds: ['p'],
          keywords: 'a',
          matchMode: 'all',
          limit: 5,
          types: ['t'],
        }),
      ).not.toThrow()
    })

    it('rejects assertSearchEntitiesForKeywordsArgs with non-array types', () => {
      expect(() =>
        assertSearchEntitiesForKeywordsArgs({
          projectIds: ['p'],
          keywords: 'a',
          types: 'bad' as any,
        }),
      ).toThrow()
    })

    it('accepts assertSearchEntitiesForExactArgs with all optional fields populated', () => {
      expect(() =>
        assertSearchEntitiesForExactArgs({
          projectIds: ['p'],
          needles: 'a',
          caseSensitive: false,
          types: ['t'],
        }),
      ).not.toThrow()
    })

    it('rejects assertSearchEntitiesForExactArgs with non-boolean caseSensitive', () => {
      expect(() =>
        assertSearchEntitiesForExactArgs({
          projectIds: ['p'],
          needles: 'a',
          caseSensitive: 'no' as any,
        }),
      ).toThrow()
    })

    it('rejects assertSearchEntitiesForExactArgs with non-array types', () => {
      expect(() =>
        assertSearchEntitiesForExactArgs({
          projectIds: ['p'],
          needles: 'a',
          types: 'bad' as any,
        }),
      ).toThrow()
    })
  })

  describe('assertSearchDocumentsForExactArgs', () => {
    it('accepts valid args', () => {
      expect(() =>
        assertSearchDocumentsForExactArgs({
          projectIds: ['p'],
          needles: ['a'],
          caseSensitive: true,
        }),
      ).not.toThrow()
    })
    it('rejects invalid args', () => {
      expect(() => assertSearchDocumentsForExactArgs(null as any)).toThrow()
      expect(() => assertSearchDocumentsForExactArgs({} as any)).toThrow()
      expect(() =>
        assertSearchDocumentsForExactArgs({ projectIds: [], needles: 'a' } as any),
      ).toThrow()
      expect(() =>
        assertSearchDocumentsForExactArgs({ projectIds: ['p'], needles: 1 as any }),
      ).toThrow()
      expect(() =>
        assertSearchDocumentsForExactArgs({
          projectIds: ['p'],
          needles: 'a',
          matchMode: 'maybe' as any,
        }),
      ).toThrow()
      expect(() =>
        assertSearchDocumentsForExactArgs({
          projectIds: ['p'],
          needles: 'a',
          caseSensitive: 1 as any,
        }),
      ).toThrow()
    })
  })
})
