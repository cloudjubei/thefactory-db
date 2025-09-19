import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('js-tiktoken', () => {
  return {
    getEncoding: vi.fn((encoding: string) => {
      // return an encoder object with encode method
      return {
        encode: (text: string) => {
          // simple deterministic behavior: split on space and map to indices length
          const parts = text.split(/\s+/).filter(Boolean)
          return parts.map((_, i) => i + 1)
        },
      }
    }),
  }
})

import { tokenize, toFtsText } from '../src/utils/tokenizer'
import * as jsTiktoken from 'js-tiktoken'

describe('tokenizer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses tiktoken strategy when available', () => {
    const res = tokenize('hello world')
    expect(res.tokens).toEqual([1, 2])
    expect(res.tokenCount).toBe(2)
    expect(res.tokenizedContent).toBe('1 2')
    expect((jsTiktoken as any).getEncoding).toHaveBeenCalled()
  })

  it('falls back to whitespace strategy when tiktoken fails', () => {
    ;(jsTiktoken as any).getEncoding.mockImplementationOnce(() => {
      throw new Error('fail')
    })
    const res = tokenize('Hello, WORLD! 123')
    // words: ['hello', 'world', '123'] -> hashes positive ints
    expect(res.tokenCount).toBe(3)
    expect(res.tokens.every((t: number) => Number.isInteger(t) && t >= 0)).toBe(true)
  })

  it('toFtsText normalizes text', () => {
    const out = toFtsText('Hello, WORLD!\nTabs\tand-punct? 123')
    expect(out).toBe('hello world tabs and punct 123')
  })
})
