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

  it('falls back to whitespace strategy when tiktoken fails (fresh encoding forces getEncoding call)', () => {
    ;(jsTiktoken as any).getEncoding.mockImplementationOnce(() => {
      throw new Error('fail')
    })
    const res = tokenize('Hello, WORLD! 123', { encoding: 'fresh-encoding' })
    // words -> ['hello', 'world', '123'] -> whitespace fallback uses hashing
    expect(res.tokenCount).toBe(3)
    // ensure produced tokens are 31-bit positive integers (clamped)
    expect(res.tokens.every((t: number) => Number.isInteger(t) && t >= 0 && t <= 0x7fffffff)).toBe(true)
  })

  it('explicit whitespace strategy maps identical words to identical token ids', () => {
    const res = tokenize('Foo foo FOO', { strategy: 'whitespace' })
    expect(res.tokenCount).toBe(3)
    // all tokens should be identical because words normalize to same token
    expect(new Set(res.tokens).size).toBe(1)
    expect(res.tokens[0]).toBeGreaterThanOrEqual(0)
    expect(res.tokens[0]).toBeLessThanOrEqual(0x7fffffff)
  })

  it('toFtsText normalizes text', () => {
    const out = toFtsText('Hello, WORLD!\nTabs\tand-punct? 123')
    expect(out).toBe('hello world tabs and punct 123')
  })
})
