import { describe, it, expect } from 'vitest'
import { stringifyJsonValues } from '../src/utils/json'

describe('stringifyJsonValues', () => {
  it('flattens nested objects and arrays into value-only string', () => {
    const input = { b: 2, a: { z: 'last', y: true }, arr: [1, 'two', false, null] }
    const out = stringifyJsonValues(input)
    // order must be deterministic (keys sorted). Values only, no keys
    // Expected tokens: arr values first? No, object keys sorted: 'a', 'arr', 'b'
    // For 'a': { y: true, z: 'last' } => 'last true' (values visited sorted by keys)
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
})
