import { describe, expect, it } from 'vitest'

import { packSpans, trimSpan, windowSpans } from '../../src/chunking/spans'

const slices = (content: string, spans: Array<{ start: number; end: number }>) =>
  spans.map((s) => content.slice(s.start, s.end))

describe('trimSpan', () => {
  it('shrinks a span to its non-whitespace extent and keeps its context', () => {
    const content = '  \n body \n\t'
    expect(trimSpan(content, { start: 0, end: content.length, context: 'Foo' })).toEqual({
      start: 4,
      end: 8,
      context: 'Foo',
    })
  })

  it('returns undefined for a span of only whitespace', () => {
    expect(trimSpan('a \n\t b', { start: 1, end: 5, context: '' })).toBeUndefined()
  })

  it('returns undefined for an empty span', () => {
    expect(trimSpan('abc', { start: 2, end: 2, context: '' })).toBeUndefined()
  })
})

describe('windowSpans', () => {
  it('returns the whole range as one window when it fits', () => {
    expect(windowSpans('one\ntwo', 0, 7, 10, 0, 'Ctx')).toEqual([
      { start: 0, end: 7, context: 'Ctx' },
    ])
  })

  it('ends each window at the last line break inside it', () => {
    const content = 'aaaa\nbbbb\ncccc\n'
    expect(slices(content, windowSpans(content, 0, content.length, 12, 0, ''))).toEqual([
      'aaaa\nbbbb',
      'cccc',
    ])
  })

  it('cuts mid-line when a window holds no line break', () => {
    const content = 'abcdefghij'
    expect(slices(content, windowSpans(content, 0, content.length, 4, 0, ''))).toEqual([
      'abcd',
      'efgh',
      'ij',
    ])
  })

  it('starts each later window at the start of the line `overlap` characters before the last end', () => {
    const content = 'aaaa\nbbbb\ncccc\ndddd\n'
    expect(slices(content, windowSpans(content, 0, content.length, 10, 3, ''))).toEqual([
      'aaaa\nbbbb',
      'bbbb\ncccc',
      'cccc\ndddd',
    ])
  })

  it('moves on without overlap when no line starts inside the overlap', () => {
    const content = 'abcdefghij'
    expect(slices(content, windowSpans(content, 0, content.length, 4, 2, ''))).toEqual([
      'abcd',
      'efgh',
      'ij',
    ])
  })

  it('drops windows of only whitespace', () => {
    const content = 'aaaa\n    \n    \nbbbb'
    expect(slices(content, windowSpans(content, 0, content.length, 5, 0, ''))).toEqual([
      'aaaa',
      'bbbb',
    ])
  })

  it('windows only the given range', () => {
    const content = 'skip|keep this|skip'
    expect(slices(content, windowSpans(content, 5, 14, 100, 0, ''))).toEqual(['keep this'])
  })
})

describe('packSpans', () => {
  it('joins consecutive spans while the group stays within the limit', () => {
    const spans = [
      { start: 0, end: 3, context: 'A' },
      { start: 4, end: 7, context: 'B' },
      { start: 8, end: 12, context: 'C' },
    ]
    expect(packSpans(spans, 8)).toEqual([
      { start: 0, end: 7, context: 'A' },
      { start: 8, end: 12, context: 'C' },
    ])
  })

  it('keeps a span already over the limit alone', () => {
    const spans = [
      { start: 0, end: 2, context: '' },
      { start: 3, end: 20, context: '' },
      { start: 21, end: 23, context: '' },
    ]
    expect(packSpans(spans, 5)).toEqual(spans)
  })

  it('leaves the spans it was given unchanged', () => {
    const spans = [
      { start: 0, end: 3, context: '' },
      { start: 4, end: 7, context: '' },
    ]
    packSpans(spans, 100)
    expect(spans[0]).toEqual({ start: 0, end: 3, context: '' })
  })
})
