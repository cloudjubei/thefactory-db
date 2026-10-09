import { describe, expect, it } from 'vitest'

import { CHUNK_MAX_CHARS, TEXT_CHUNK_OVERLAP_CHARS } from '../../src/chunking/chunkingConstants'
import { chunkText } from '../../src/chunking/textChunker'

const logLines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i} of the log file`).join('\n')

describe('chunkText', () => {
  it('returns no spans for text of only whitespace', () => {
    expect(chunkText(' \n\t\n')).toEqual([])
  })

  it('keeps short text whole in one span without a scope', () => {
    expect(chunkText('hello\nworld\n')).toEqual([{ start: 0, end: 11, context: '' }])
  })

  it('keeps every window within the chunk limit', () => {
    const spans = chunkText(logLines(300))
    expect(Math.max(...spans.map((s) => s.end - s.start))).toBeLessThanOrEqual(CHUNK_MAX_CHARS)
  })

  it('starts each later window on a line, overlapping the window before it', () => {
    const content = logLines(300)
    const spans = chunkText(content)
    const longestLine = Math.max(...content.split('\n').map((l) => l.length + 1))
    const overlaps = spans.slice(1).map((s, i) => spans[i].end - s.start)
    expect(spans.slice(1).every((s) => content[s.start - 1] === '\n')).toBe(true)
    expect(Math.min(...overlaps)).toBeGreaterThan(0)
    expect(Math.max(...overlaps)).toBeLessThanOrEqual(TEXT_CHUNK_OVERLAP_CHARS + longestLine)
  })
})
