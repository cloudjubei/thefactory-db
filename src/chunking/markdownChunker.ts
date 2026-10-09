import { CHUNK_MAX_CHARS } from './chunkingConstants.js'
import type { ChunkSpan } from './chunkingTypes.js'
import { packSpans, trimSpan, windowSpans } from './spans.js'

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE = /^\s*(`{3,}|~{3,})/

/**
 * Sections from one heading to the next, each with its heading path. Lines inside a fenced block
 * are not headings; a fence closes only on a marker of the kind and at least the length it opened with.
 */
function sections(content: string): ChunkSpan[] {
  const out: ChunkSpan[] = []
  const path: string[] = []
  let fence: string | undefined
  let sectionStart = 0
  let context = ''
  let offset = 0
  for (const line of content.split('\n')) {
    const marker = FENCE.exec(line)?.[1]
    if (marker && !fence) fence = marker
    else if (marker && marker[0] === fence?.[0] && marker.length >= fence.length) fence = undefined
    const heading = fence ? null : HEADING.exec(line)
    if (heading) {
      if (offset > sectionStart) out.push({ start: sectionStart, end: offset, context })
      const level = heading[1].length
      path.length = level - 1
      path[level - 1] = heading[2]
      context = path.filter(Boolean).join(' › ')
      sectionStart = offset
    }
    offset += line.length + 1
  }
  out.push({ start: sectionStart, end: content.length, context })
  return out
}

/** Paragraph spans (blank-line separated) of `[start, end)`. */
function paragraphs(content: string, start: number, end: number, context: string): ChunkSpan[] {
  const out: ChunkSpan[] = []
  const blank = /\n[ \t]*\n/g
  blank.lastIndex = start
  let pos = start
  let m: RegExpExecArray | null
  while ((m = blank.exec(content)) && m.index < end) {
    out.push({ start: pos, end: m.index, context })
    pos = m.index + m[0].length
  }
  out.push({ start: pos, end, context })
  return out
}

/**
 * Sections by heading, packed together while small; a section too long splits by paragraphs, and a
 * paragraph too long by windows.
 */
export function chunkMarkdown(content: string): ChunkSpan[] {
  const pieces: ChunkSpan[] = []
  for (const section of sections(content)) {
    const trimmed = trimSpan(content, section)
    if (!trimmed) continue
    if (trimmed.end - trimmed.start <= CHUNK_MAX_CHARS) {
      pieces.push(trimmed)
      continue
    }
    for (const para of paragraphs(content, trimmed.start, trimmed.end, section.context)) {
      const p = trimSpan(content, para)
      if (!p) continue
      if (p.end - p.start <= CHUNK_MAX_CHARS) pieces.push(p)
      else pieces.push(...windowSpans(content, p.start, p.end, CHUNK_MAX_CHARS, 0, p.context))
    }
  }
  return packSpans(pieces, CHUNK_MAX_CHARS)
}
