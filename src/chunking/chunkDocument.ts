import { MARKDOWN_EXTS } from './chunkingConstants.js'
import type { ChunkKind, ChunkSpan, DocumentChunk } from './chunkingTypes.js'
import { chunkCode } from './codeChunker.js'
import { isDataFile, summarizeDataFile } from './dataSummary.js'
import { chunkMarkdown } from './markdownChunker.js'
import { chunkText } from './textChunker.js'

function extOf(src: string): string {
  const base = src.slice(src.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** The 1-based line of a character offset, looked up among the offsets every line starts at. */
function lineFinder(content: string): (offset: number) => number {
  const lineStarts = [0]
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lineStarts.push(i + 1)
  }
  return (offset) => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (lineStarts[mid] <= offset) low = mid
      else high = mid - 1
    }
    return low + 1
  }
}

async function spansOf(
  ext: string,
  content: string,
): Promise<{ kind: ChunkKind; spans: ChunkSpan[] }> {
  if (MARKDOWN_EXTS.has(ext)) return { kind: 'markdown', spans: chunkMarkdown(content) }
  const code = await chunkCode(content, ext)
  if (code) return { kind: 'code', spans: code }
  return { kind: 'text', spans: chunkText(content) }
}

/**
 * The pieces of a document to embed: syntax-aware chunks for code with a grammar, heading-aware
 * chunks for markdown, overlapping windows for any other text, and one structure summary for bulk
 * data files. Each chunk's text starts with a header naming the path and the enclosing scope. A
 * document with no text still yields one chunk, so its path stays findable.
 */
export async function chunkDocument(src: string, content: string): Promise<DocumentChunk[]> {
  const ext = extOf(src)
  const lineOf = lineFinder(content)

  if (isDataFile(ext, content)) {
    return [
      {
        ord: 0,
        kind: 'summary',
        startChar: 0,
        endChar: content.length,
        startLine: 1,
        endLine: lineOf(Math.max(0, content.length - 1)),
        text: `${src}\n${summarizeDataFile(ext, content)}`,
      },
    ]
  }

  const { kind, spans } = await spansOf(ext, content)
  if (spans.length === 0) {
    return [
      {
        ord: 0,
        kind: 'text',
        startChar: 0,
        endChar: 0,
        startLine: 1,
        endLine: 1,
        text: `${src}\n`,
      },
    ]
  }
  return spans.map((span, ord) => ({
    ord,
    kind,
    startChar: span.start,
    endChar: span.end,
    startLine: lineOf(span.start),
    endLine: lineOf(Math.max(span.start, span.end - 1)),
    text: `${span.context ? `${src} · ${span.context}` : src}\n${content.slice(span.start, span.end)}`,
  }))
}
