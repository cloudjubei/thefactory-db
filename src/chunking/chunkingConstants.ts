import type { CodeGrammar } from './chunkingTypes.js'

/**
 * The most characters a chunk body holds. all-MiniLM-L6-v2 reads ~256 word pieces (its card truncates
 * there); at ~3.5 characters per token for code and prose, 800 characters plus a one-line header fit.
 */
export const CHUNK_MAX_CHARS = 800

/** How far consecutive plain-text windows overlap, so a sentence cut at a boundary stays whole in one. */
export const TEXT_CHUNK_OVERLAP_CHARS = 100

/**
 * Bump whenever chunking changes: a stored document chunked by another version is re-chunked on the
 * next sync, however unchanged its content.
 */
export const CHUNKER_VERSION = 2

/** Extensions that may hold bulk data rather than prose or code. */
export const DATA_FILE_EXTS = new Set(['json', 'jsonl', 'ndjson', 'geojson', 'csv', 'tsv'])

/** A data-extension file at least this long is summarised instead of chunked. */
export const DATA_FILE_MIN_CHARS = 256 * 1024

/** A smaller data-extension file is summarised when more than this share of its opening is digits. */
export const DATA_FILE_DIGIT_RATIO = 0.3

/** How much of a file the digit ratio is measured on. */
export const DATA_FILE_SAMPLE_CHARS = 64 * 1024

/** How long a data summary's sample record may run. */
export const DATA_SAMPLE_MAX_CHARS = 300

/** How deep a JSON structure sketch descends. */
export const DATA_SKETCH_MAX_DEPTH = 4

/** How many `path: type` lines a JSON structure sketch lists. */
export const DATA_SKETCH_MAX_LINES = 30

/** How many records of a line-delimited JSON file the structure sketch reads. */
export const DATA_SKETCH_MAX_RECORDS = 50

/** Syntax nodes whose `name` field names a scope a chunk header lists. */
export const SCOPE_NODE_TYPE =
  /class|function|method|declaration|definition|declarator|interface|enum|module|namespace/

/** Grammar per file extension; files of any other extension are chunked as text. */
export const CODE_GRAMMARS: Record<string, CodeGrammar> = {
  ts: { pkg: 'tree-sitter-typescript', wasm: 'tree-sitter-typescript.wasm' },
  mts: { pkg: 'tree-sitter-typescript', wasm: 'tree-sitter-typescript.wasm' },
  cts: { pkg: 'tree-sitter-typescript', wasm: 'tree-sitter-typescript.wasm' },
  tsx: { pkg: 'tree-sitter-typescript', wasm: 'tree-sitter-tsx.wasm' },
  js: { pkg: 'tree-sitter-javascript', wasm: 'tree-sitter-javascript.wasm' },
  jsx: { pkg: 'tree-sitter-javascript', wasm: 'tree-sitter-javascript.wasm' },
  mjs: { pkg: 'tree-sitter-javascript', wasm: 'tree-sitter-javascript.wasm' },
  cjs: { pkg: 'tree-sitter-javascript', wasm: 'tree-sitter-javascript.wasm' },
  py: { pkg: 'tree-sitter-python', wasm: 'tree-sitter-python.wasm' },
}

/** Extensions chunked along markdown headings. */
export const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown'])
