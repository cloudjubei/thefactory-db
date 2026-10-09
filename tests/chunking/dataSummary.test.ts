import { describe, expect, it } from 'vitest'

import {
  DATA_FILE_MIN_CHARS,
  DATA_SAMPLE_MAX_CHARS,
  DATA_SKETCH_MAX_LINES,
} from '../../src/chunking/chunkingConstants'
import { isDataFile, summarizeDataFile } from '../../src/chunking/dataSummary'

describe('isDataFile', () => {
  it('rejects a file without a data extension, however numeric', () => {
    expect(isDataFile('ts', '1234567890'.repeat(100))).toBe(false)
  })

  it('accepts a data-extension file at the size threshold', () => {
    expect(isDataFile('json', 'a'.repeat(DATA_FILE_MIN_CHARS))).toBe(true)
  })

  it('accepts a small data-extension file that is mostly digits', () => {
    expect(isDataFile('csv', '1,2,3\n4,5,6\n')).toBe(true)
  })

  it('rejects a small data-extension file that is mostly words', () => {
    expect(isDataFile('json', '{"name": "app", "version": "1.0"}')).toBe(false)
  })

  it('rejects an empty data-extension file', () => {
    expect(isDataFile('json', '')).toBe(false)
  })
})

describe('summarizeDataFile — JSON', () => {
  it('sketches every key path with its type and samples the largest array', () => {
    const content = JSON.stringify({
      symbol: 'BTC',
      candles: [
        { t: 1, v: 2 },
        { t: 3, v: 4 },
      ],
      meta: null,
    })
    expect(summarizeDataFile('json', content)).toBe(
      [
        'Data file: JSON',
        '$: object',
        'symbol: string',
        'candles: array(2) of object',
        'candles[]: object',
        'candles[].t: number',
        'candles[].v: number',
        'meta: null',
        'Sample: {"t":1,"v":2}',
      ].join('\n'),
    )
  })

  it('samples the first element of the largest array', () => {
    const content = JSON.stringify({ tags: ['a'], rows: [{ id: 1 }, { id: 2 }] })
    expect(summarizeDataFile('json', content).split('\n').at(-1)).toBe('Sample: {"id":1}')
  })

  it('does not descend into an array of plain values', () => {
    expect(summarizeDataFile('json', '[1,2,3]')).toBe(
      'Data file: JSON\n$: array(3) of number\nSample: 1',
    )
  })

  it('descends into the first row of an array of arrays', () => {
    expect(summarizeDataFile('json', '[[1,2],[3,4],[5,6]]')).toBe(
      'Data file: JSON\n$: array(3) of array\n[]: array(2) of number\nSample: [1,2]',
    )
  })

  it('samples the value itself when its arrays are empty', () => {
    expect(summarizeDataFile('json', '[]')).toBe('Data file: JSON\n$: array(0)\nSample: []')
  })

  it('stops descending at the depth limit', () => {
    const content = JSON.stringify({ a: { b: { c: { d: { e: { f: 1 } } } } } })
    expect(summarizeDataFile('json', content).split('\n').slice(1, -1)).toEqual([
      '$: object',
      'a: object',
      'a.b: object',
      'a.b.c: object',
      'a.b.c.d: object',
    ])
  })

  it('lists at most the line limit of key paths', () => {
    const content = JSON.stringify(
      Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i])),
    )
    expect(summarizeDataFile('json', content).split('\n')).toHaveLength(DATA_SKETCH_MAX_LINES + 2)
  })

  it('clips a long sample', () => {
    const content = JSON.stringify([{ text: 'x'.repeat(DATA_SAMPLE_MAX_CHARS * 2) }])
    const sample = summarizeDataFile('json', content).split('\n').at(-1)!
    expect(sample).toHaveLength('Sample: '.length + DATA_SAMPLE_MAX_CHARS + 1)
  })

  it('shows the opening of a file it cannot parse', () => {
    expect(summarizeDataFile('json', '{"broken": [1,2,')).toBe(
      'Data file: JSON (unparseable)\n{"broken": [1,2,',
    )
  })
})

describe('summarizeDataFile — line-delimited JSON', () => {
  const records = Array.from({ length: 120 }, (_, i) => JSON.stringify({ i })).join('\n')

  it('counts every record and sketches the first ones', () => {
    expect(summarizeDataFile('jsonl', records)).toBe(
      [
        'Data file: JSON, 120 records',
        '$: array(50) of object',
        '[]: object',
        '[].i: number',
        'Sample: {"i":0}',
      ].join('\n'),
    )
  })

  it('reads .ndjson the same way', () => {
    expect(summarizeDataFile('ndjson', records)).toBe(summarizeDataFile('jsonl', records))
  })
})

describe('summarizeDataFile — tables', () => {
  it('describes a CSV file by its row count, columns and first rows', () => {
    expect(summarizeDataFile('csv', 'date, open\n2024,1\n2025,2\n2026,3\n')).toBe(
      'Data file: table, 3 rows\ncolumns: date, open\nSample:\n2024,1\n2025,2',
    )
  })

  it('splits a TSV file on tabs', () => {
    expect(summarizeDataFile('tsv', 'a\tb\n1\t2')).toBe(
      'Data file: table, 1 row\ncolumns: a, b\nSample:\n1\t2',
    )
  })

  it('describes an empty table as having no rows', () => {
    expect(summarizeDataFile('csv', '')).toBe('Data file: table, 0 rows\ncolumns: \nSample:')
  })
})
