import { CHUNK_MAX_CHARS, TEXT_CHUNK_OVERLAP_CHARS } from './chunkingConstants.js'
import type { ChunkSpan } from './chunkingTypes.js'
import { windowSpans } from './spans.js'

/** Overlapping line-aligned windows over the whole content. */
export function chunkText(content: string): ChunkSpan[] {
  return windowSpans(content, 0, content.length, CHUNK_MAX_CHARS, TEXT_CHUNK_OVERLAP_CHARS, '')
}
