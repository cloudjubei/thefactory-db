export { SQL } from './sql.js'

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

export function buildEmbeddingTextForDoc(
  type: string,
  content: string,
  name?: string,
  src?: string,
): string {
  return [type, name, src, content].filter(Boolean).join('\n')
}

export function toVectorLiteral(vec: ArrayLike<number>): string {
  const arr = Array.from(vec as any)
  return `[${arr.join(',')}]`
}
