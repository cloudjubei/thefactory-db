import type { DocumentNonIndexableReason } from './types.js'

export { SQL } from './sql.js'

/** Postgres `program_limit_exceeded`, raised when a document's lexemes exceed the 1 MB tsvector limit. */
const PG_PROGRAM_LIMIT_EXCEEDED = '54000'

// ----------------------------
// Query/string helpers
// ----------------------------

export function prepareQuery(query: string): string {
  return String(query ?? '').trim()
}

export function normalizeDocPath(p: string): string {
  if (!p) return p
  return p.replaceAll('\\', '/').replace(/^\.\//, '')
}

export function normalizePathPrefix(prefix?: string): string | undefined {
  if (!prefix) return undefined
  const p = normalizeDocPath(prefix).trim().replace(/^\//, '')
  return p.length ? p : undefined
}

export function escapeLikePattern(s: string): string {
  return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

export function toTokens(input: string | string[]): string[] {
  if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean)
  return String(input)
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// ----------------------------
// Embeddings helpers
// ----------------------------

export function toVectorLiteral(vec: ArrayLike<number>): string {
  const arr = Array.from(vec)
  return `[${arr.join(',')}]`
}

// ----------------------------
// Write-error classification
// ----------------------------

/**
 * Classifies a failed document write: the reason when Postgres rejected the document itself as
 * impossible to index, otherwise undefined.
 */
export function nonIndexableReasonFor(err: unknown): DocumentNonIndexableReason | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  return (err as { code?: unknown }).code === PG_PROGRAM_LIMIT_EXCEEDED ? 'too-large' : undefined
}
