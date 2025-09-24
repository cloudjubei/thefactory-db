// Runtime validation helpers for public API inputs

import { MatchParams, SearchParams } from './types'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

export function assertDocumentInput(input: any): void {
  if (!isRecord(input)) throw new TypeError('DocumentInput must be an object')
  if (typeof input.projectId !== 'string' || input.projectId.length === 0)
    throw new TypeError('DocumentInput.projectId must be a non-empty string')
  if (typeof input.type !== 'string' || input.type.length === 0)
    throw new TypeError('DocumentInput.type must be a non-empty string')
  if (typeof input.name !== 'string' || input.name.length === 0)
    throw new TypeError('DocumentInput.name must be a non-empty string')
  if (typeof input.src !== 'string' || input.src.length === 0)
    throw new TypeError('DocumentInput.src must be a non-empty string')
  if (input.content !== undefined && typeof input.content !== 'string')
    throw new TypeError('DocumentInput.content must be a string if provided')
  if (input.metadata !== undefined && !isPlainObject(input.metadata))
    throw new TypeError('DocumentInput.metadata must be an object if provided')
}

export function assertDocumentPatch(patch: any): void {
  if (!isRecord(patch)) throw new TypeError('Document patch must be an object')
  if (patch.projectId !== undefined) throw new TypeError('Document.projectId cannot be changed')
  if (patch.type !== undefined && typeof patch.type !== 'string')
    throw new TypeError('DocumentPatch.type must be a string if provided')
  if (patch.name !== undefined && typeof patch.name !== 'string' && patch.name !== null)
    throw new TypeError('DocumentPatch.name must be a string or null if provided')
  if (patch.content !== undefined && typeof patch.content !== 'string' && patch.content !== null)
    throw new TypeError('DocumentPatch.content must be a string or null if provided')
  if (patch.src !== undefined && typeof patch.src !== 'string' && patch.src !== null)
    throw new TypeError('DocumentPatch.src must be a string or null if provided')
  if (patch.metadata !== undefined && !isPlainObject(patch.metadata) && patch.metadata !== null)
    throw new TypeError('DocumentPatch.metadata must be an object or null if provided')
}

export function assertEntityInput(input: any): void {
  if (!isRecord(input)) throw new TypeError('EntityInput must be an object')
  if (typeof input.projectId !== 'string' || input.projectId.length === 0)
    throw new TypeError('EntityInput.projectId must be a non-empty string')
  if (typeof input.type !== 'string' || input.type.length === 0)
    throw new TypeError('EntityInput.type must be a non-empty string')
  const c = input.content
  const isObjectOrArray = isRecord(c) || Array.isArray(c)
  if (!isObjectOrArray) throw new TypeError('EntityInput.content must be an object or array')
  if (input.metadata !== undefined && !isPlainObject(input.metadata))
    throw new TypeError('EntityInput.metadata must be an object if provided')
}

export function assertEntityPatch(patch: any): void {
  if (!isRecord(patch)) throw new TypeError('Entity patch must be an object')
  if (patch.projectId !== undefined) throw new TypeError('Entity.projectId cannot be changed')
  if (patch.type !== undefined && typeof patch.type !== 'string' && patch.type !== null)
    throw new TypeError('EntityPatch.type must be a string or null if provided')
  if (patch.content !== undefined) {
    const c = patch.content
    const ok = c === null || isRecord(c) || Array.isArray(c)
    if (!ok) throw new TypeError('EntityPatch.content must be object/array/null if provided')
  }
  if (patch.metadata !== undefined && !isPlainObject(patch.metadata) && patch.metadata !== null)
    throw new TypeError('EntityPatch.metadata must be an object or null if provided')
}

export function assertMatchParams(opts?: MatchParams): void {
  if (opts === undefined) return
  if (!isRecord(opts)) throw new TypeError('Match options must be an object')
  if (opts.limit !== undefined && !Number.isInteger(opts.limit))
    throw new TypeError('Match options.limit must be an integer if provided')
  if (opts.types !== undefined && !isStringArray(opts.types))
    throw new TypeError('Match options.types must be an array of strings if provided')
  if (opts.ids !== undefined && !isStringArray(opts.ids))
    throw new TypeError('Match options.ids must be an array of strings if provided')
  if (opts.projectIds !== undefined && !isStringArray(opts.projectIds))
    throw new TypeError('Match options.projectIds must be an array of strings if provided')
}

export function assertSearchParams(params: SearchParams): void {
  if (params === undefined) throw new TypeError('Params must be present')
  if (!isRecord(params)) throw new TypeError('Search params must be an object')
  if (params.query === undefined || typeof params.query !== 'string')
    throw new TypeError('Search params.query must be a string')
  if (params.textWeight !== undefined && typeof params.textWeight !== 'number')
    throw new TypeError('Search params.textWeight must be a number if provided')
  assertMatchParams(params)
}
