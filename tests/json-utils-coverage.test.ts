import { describe, it, expect } from 'vitest'
import { stringifyJsonValues } from '../src/utils/json'

// Additional coverage-focused tests for stringifyJsonValues

describe('stringifyJsonValues (coverage additions)', () => {
  it('handles bigint primitives by stringifying them', () => {
    // BigInt should be converted to its string representation
    expect(stringifyJsonValues(10n)).toBe('10')
    expect(stringifyJsonValues(9007199254740993n)).toBe('9007199254740993')
  })

  it('ignores properties that throw on access (property getter throws)', () => {
    const obj: any = {}
    Object.defineProperty(obj, 'bad', {
      enumerable: true,
      get() {
        throw new Error('access error')
      },
    })
    Object.defineProperty(obj, 'ok', {
      enumerable: true,
      value: 42,
    })

    // Should not throw, and should include only the good value
    const out = stringifyJsonValues(obj)
    expect(out).toBe('42')
  })

  it('swallows unexpected traversal errors at top level (outer try/catch)', () => {
    // Create a proxy object that throws when Object.keys attempts to list keys
    const throwingOwnKeys = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys failure')
        },
      },
    )

    // Should not throw and should fall back to best-effort (likely empty string)
    const out = stringifyJsonValues(throwingOwnKeys)
    expect(out).toBe('')
  })

  it('omits empty strings from output (string case else branch)', () => {
    const input = { a: '', b: 'x' }
    // Should only include 'x' because empty string tokens are filtered out
    expect(stringifyJsonValues(input)).toBe('x')
  })
})
