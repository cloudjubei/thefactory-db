import { describe, it, expect } from 'vitest'
import { tokenize, toFtsText } from '../../src/utils/tokenizer'

const RUN = process.env.RUN_E2E === '1'

;(RUN ? describe : describe.skip)('E2E: Tokenizer utilities (real runtime)', () => {
  it('tokenize() produces tokens and counts', () => {
    const res = tokenize('Hello, world! This is a test.')
    expect(res.tokenCount).toBeGreaterThan(0)
    expect(res.tokens.length).toBe(res.tokenCount)
    expect(typeof res.tokenizedContent).toBe('string')
  })

  it('toFtsText() normalizes text', () => {
    const out = toFtsText('Hello, WORLD!\nTabs\tand-punct? 123')
    expect(out).toBe('hello world tabs and punct 123')
  })
})
