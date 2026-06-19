import { ENTITY_SELECT_COLUMNS } from '../sql.js'
import type { EntityFieldPredicate, EntityFilter, EntitySort, MatchParams } from '../types.js'

/** A compiled SQL statement: parameterised text plus its positional bind values. */
export type BuiltQuery = { text: string; params: unknown[] }

const NUMERIC_OPS = new Set(['<', '<=', '>=', '>'])
const KNOWN_OPS = new Set(['<', '<=', '=', '!=', '>=', '>', 'contains', 'exists'])
// A content dot-path is split on '.'; each segment must be a plain identifier so the path can never
// inject SQL (it is also sent as a bound param, this is belt-and-braces + a clear error).
const FIELD_SEGMENT = /^[A-Za-z0-9_]+$/

function fieldPath(field: string): string[] {
  const segs = String(field).split('.').filter(Boolean)
  if (segs.length === 0) throw new Error(`entity filter: empty field path`)
  for (const seg of segs) {
    if (!FIELD_SEGMENT.test(seg)) throw new Error(`entity filter: unsafe field segment "${seg}"`)
  }
  return segs
}

function isFieldPredicate(filter: EntityFilter): filter is EntityFieldPredicate {
  return typeof (filter as EntityFieldPredicate).field === 'string'
}

/** Accumulates bind params and hands back the `$n` placeholder for each. */
class Params {
  readonly values: unknown[] = []
  add(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
}

function compilePredicate(pred: EntityFieldPredicate, params: Params): string {
  if (!KNOWN_OPS.has(pred.op)) throw new Error(`entity filter: unknown operator "${pred.op}"`)
  const path = params.add(fieldPath(pred.field))
  if (pred.op === 'exists') return `(content #> ${path}::text[]) IS NOT NULL`
  if (pred.op === 'contains') {
    const v = params.add(String(pred.value ?? ''))
    return `(content #>> ${path}::text[]) ILIKE '%' || ${v} || '%'`
  }
  const numeric = NUMERIC_OPS.has(pred.op) || typeof pred.value === 'number'
  if (numeric) {
    const v = params.add(Number(pred.value))
    const cmp = pred.op === '=' ? '=' : pred.op === '!=' ? '<>' : pred.op
    return `(jsonb_typeof(content #> ${path}::text[]) = 'number' AND (content #>> ${path}::text[])::numeric ${cmp} ${v}::numeric)`
  }
  const v = params.add(typeof pred.value === 'boolean' ? String(pred.value) : pred.value)
  if (pred.op === '=') return `(content #>> ${path}::text[]) = ${v}`
  if (pred.op === '!=')
    return `((content #>> ${path}::text[]) IS NOT NULL AND (content #>> ${path}::text[]) <> ${v})`
  throw new Error(`entity filter: operator "${pred.op}" needs a numeric value`)
}

function compileFilter(filter: EntityFilter, params: Params): string {
  if (isFieldPredicate(filter)) return compilePredicate(filter, params)
  if ('and' in filter) {
    if (!filter.and.length) return '(TRUE)'
    return `(${filter.and.map((f) => compileFilter(f, params)).join(' AND ')})`
  }
  if ('or' in filter) {
    if (!filter.or.length) return '(FALSE)'
    return `(${filter.or.map((f) => compileFilter(f, params)).join(' OR ')})`
  }
  if ('not' in filter) return `(NOT ${compileFilter(filter.not, params)})`
  throw new Error('entity filter: node is neither a predicate nor and/or/not')
}

// The WHERE conditions shared by the match + count queries, in a fixed param order:
// projectIds, types, ids, jsonb-containment criteria, then the composable `where` predicate.
function buildConditions(
  criteria: unknown,
  options: MatchParams | undefined,
  params: Params,
): string[] {
  const conds: string[] = []
  if (options?.projectIds?.length)
    conds.push(`project_id = ANY(${params.add(options.projectIds)}::text[])`)
  if (options?.types?.length) conds.push(`type = ANY(${params.add(options.types)}::text[])`)
  if (options?.ids?.length) conds.push(`id = ANY(${params.add(options.ids)}::uuid[])`)
  const hasCriteria =
    criteria !== undefined &&
    criteria !== null &&
    typeof criteria === 'object' &&
    Object.keys(criteria as object).length > 0
  if (hasCriteria) conds.push(`content @> ${params.add(JSON.stringify(criteria))}::jsonb`)
  if (options?.where) conds.push(compileFilter(options.where, params))
  return conds
}

function orderByClause(orderBy: EntitySort[] | undefined, params: Params): string {
  const terms: string[] = []
  for (const sort of orderBy ?? []) {
    const path = params.add(fieldPath(sort.field))
    const dir = sort.direction === 'asc' ? 'ASC' : 'DESC'
    const expr = sort.numeric
      ? `(CASE WHEN jsonb_typeof(content #> ${path}::text[]) = 'number' THEN (content #>> ${path}::text[])::numeric END)`
      : `(content #>> ${path}::text[])`
    terms.push(`${expr} ${dir} NULLS LAST`)
  }
  // A stable tiebreak so pagination never repeats or drops a row between pages.
  terms.push('updated_at DESC', 'id ASC')
  return terms.join(', ')
}

/**
 * Compile a parameterised entity-match query from composable filters, content-field ordering, and
 * limit/offset pagination. Field paths and values are always bound parameters — never interpolated.
 */
export function buildEntityMatchQuery(criteria: unknown, options?: MatchParams): BuiltQuery {
  const params = new Params()
  const conds = buildConditions(criteria, options, params)
  const where = conds.length ? `\nWHERE ${conds.join('\n  AND ')}` : ''
  const orderBy = orderByClause(options?.orderBy, params)
  const limit = Math.max(1, options?.limit ?? 100)
  let tail = `\nLIMIT ${params.add(limit)}`
  if (options?.offset && options.offset > 0)
    tail += ` OFFSET ${params.add(Math.floor(options.offset))}`
  const text = `SELECT${ENTITY_SELECT_COLUMNS}\nFROM entities${where}\nORDER BY ${orderBy}${tail};`
  return { text, params: params.values }
}

/**
 * Compile a COUNT over the same conditions as {@link buildEntityMatchQuery} (no order/limit/offset)
 * so a caller can report the total matching rows for pagination.
 */
export function buildEntityCountQuery(criteria: unknown, options?: MatchParams): BuiltQuery {
  const params = new Params()
  const conds = buildConditions(criteria, options, params)
  const where = conds.length ? `\nWHERE ${conds.join('\n  AND ')}` : ''
  return { text: `SELECT count(*)::int AS count FROM entities${where};`, params: params.values }
}
