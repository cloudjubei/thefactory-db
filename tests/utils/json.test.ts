import { describe, it, expect } from 'vitest'
import { stringifyJsonValues } from '../../src/utils/json'

describe('stringifyJsonValues', () => {
  it('flattens nested objects and arrays into value-only string', () => {
    const input = { b: 2, a: { z: 'last', y: true }, arr: [1, 'two', false, null] }
    const out = stringifyJsonValues(input)
    // order must be deterministic (keys sorted). Values only, no keys
    // Expected tokens: object keys sorted: 'a', 'arr', 'b'
    // For 'a': { y: true, z: 'last' } => 'true last' (values visited sorted by keys)
    // For 'arr': [1,'two',false,null] => '1 two false null'
    // For 'b': 2
    expect(out).toBe('true last 1 two false null 2')
  })

  it('handles primitive values', () => {
    expect(stringifyJsonValues('hello')).toBe('hello')
    expect(stringifyJsonValues(123)).toBe('123')
    expect(stringifyJsonValues(true)).toBe('true')
    expect(stringifyJsonValues(null)).toBe('null')
    // undefined is ignored, results in empty string
    expect(stringifyJsonValues(undefined)).toBe('')
  })

  it('ignores functions and symbols and non-finite numbers', () => {
    const input: any = {
      a: Symbol('x'),
      b: () => {},
      c: NaN,
      d: Infinity,
      e: -Infinity,
      f: 0,
    }
    // Only finite number 0 remains
    expect(stringifyJsonValues(input)).toBe('0')
  })

  it('handles cycles gracefully', () => {
    const a: any = { x: 1 }
    const b: any = { a }
    a.b = b // cycle
    const out = stringifyJsonValues(a)
    // Should include both numbers exactly once without throwing
    expect(out).toBe('1')
  })

  it('stable ordering regardless of original insertion order', () => {
    const one = { b: 2, a: 1 }
    const two = { a: 1, b: 2 }
    expect(stringifyJsonValues(one)).toBe(stringifyJsonValues(two))
  })

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

  it('omits empty strings from output', () => {
    const input = { a: '', b: 'x' }
    // Should only include 'x' because empty string tokens are filtered out
    expect(stringifyJsonValues(input)).toBe('x')
  })
})
