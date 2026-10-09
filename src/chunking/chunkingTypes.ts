/** How a chunk was cut: along syntax, markdown headings, text windows, or a data file's summary. */
export type ChunkKind = 'code' | 'markdown' | 'text' | 'summary'

/** A character range of a document, with the scope it sits in (e.g. `Calculator › add`). */
export type ChunkSpan = { start: number; end: number; context: string }

/**
 * One embeddable piece of a document. `startChar`/`endChar` index the document's content as a JS
 * string (UTF-16 units); a `summary` spans the whole file. `text` is what gets embedded: a header
 * line (path, then scope) and the body.
 */
export type DocumentChunk = {
  ord: number
  kind: ChunkKind
  startChar: number
  endChar: number
  startLine: number
  endLine: number
  text: string
}

/** A tree-sitter grammar: the npm package shipping it and the prebuilt wasm file inside. */
export type CodeGrammar = { pkg: string; wasm: string }
