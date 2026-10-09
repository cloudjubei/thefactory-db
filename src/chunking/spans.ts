import type { ChunkSpan } from './chunkingTypes.js'

const isSpace = (ch: string) => /\s/.test(ch)

/** The span shrunk to its non-whitespace extent, or `undefined` when nothing but whitespace is left. */
export function trimSpan(content: string, span: ChunkSpan): ChunkSpan | undefined {
  let { start, end } = span
  while (start < end && isSpace(content[start])) start++
  while (end > start && isSpace(content[end - 1])) end--
  return end > start ? { ...span, start, end } : undefined
}

/**
 * Windows of at most `max` characters over `[start, end)`, ending at a line break where one falls in
 * the window and cut mid-line otherwise. With `overlap`, each window after the first starts at the
 * beginning of the line `overlap` characters before the previous window's end.
 */
export function windowSpans(
  content: string,
  start: number,
  end: number,
  max: number,
  overlap: number,
  context: string,
): ChunkSpan[] {
  const spans: ChunkSpan[] = []
  let pos = start
  while (pos < end) {
    let limit = Math.min(end, pos + max)
    if (limit < end) {
      const lineEnd = content.lastIndexOf('\n', limit - 1)
      if (lineEnd >= pos) limit = lineEnd + 1
    }
    const span = trimSpan(content, { start: pos, end: limit, context })
    if (span) spans.push(span)
    if (limit >= end) break
    let next = limit
    if (overlap > 0) {
      const lineStart = content.lastIndexOf('\n', limit - overlap - 1) + 1
      if (lineStart > pos && lineStart < limit) next = lineStart
    }
    pos = next
  }
  return spans
}

/**
 * Greedy packing of consecutive spans into groups of at most `max` characters (first start to last
 * end); a group takes the context of its first span. Spans already over `max` stay alone.
 */
export function packSpans(spans: ChunkSpan[], max: number): ChunkSpan[] {
  const packed: ChunkSpan[] = []
  for (const span of spans) {
    const last = packed.at(-1)
    if (last && span.end - last.start <= max) last.end = span.end
    else packed.push({ ...span })
  }
  return packed
}
