import type { DB } from '../connection.js'
import type { Logger } from '../types.js'
import type { EmbeddingProvider } from '../utils/embeddings.js'
import { SQL } from '../sql.js'
import { stringifyJsonValues } from '../utils/json.js'
import {
  assertEntityInput,
  assertEntityPatch,
  assertMatchParams,
  assertSearchEntitiesForExactArgs,
  assertSearchEntitiesForKeywordsArgs,
  assertSearchParams,
} from '../validation.js'
import { prepareQuery, toTokens, toVectorLiteral } from '../utils.js'
import type {
  Entity,
  EntityInput,
  EntityPatch,
  EntityWithScore,
  MatchParams,
  SearchEntitiesForExactArgs,
  SearchEntitiesForKeywordsArgs,
  SearchParams,
} from '../types.js'

export function createEntityApi({
  db,
  logger,
  embeddingProvider,
}: {
  db: DB
  logger: Logger
  embeddingProvider: EmbeddingProvider
}) {
  async function addEntity(e: EntityInput): Promise<Entity> {
    assertEntityInput(e)
    logger.info('addEntity', { projectId: e.projectId, type: e.type })
    const stringContent = stringifyJsonValues(e.content)
    const shouldEmbed = e.shouldEmbed ?? true
    const embedding = shouldEmbed ? await embeddingProvider.embed(stringContent) : null
    const embeddingLiteral = embedding ? toVectorLiteral(embedding) : null

    const out = await db.query(SQL.insertEntity, [
      e.projectId,
      e.type,
      e.content,
      shouldEmbed,
      stringContent,
      embeddingLiteral,
      e.metadata ?? null,
    ])
    return out.rows[0]
  }

  async function getEntityById(id: string): Promise<Entity | undefined> {
    logger.info('getEntityById', { id })
    const r = await db.query(SQL.getEntityById, [id])
    const row = r.rows[0]
    if (!row) return undefined
    return row
  }

  async function updateEntity(id: string, patch: EntityPatch): Promise<Entity | undefined> {
    assertEntityPatch(patch)
    logger.info('updateEntity', { id, keys: Object.keys(patch) })
    const exists = await getEntityById(id)
    if (!exists) return

    let embeddingLiteral = null
    let newContent = null
    let newContentString = null
    let shouldEmbed = patch.shouldEmbed

    if (patch.content !== undefined) {
      newContent = patch.content
      newContentString = stringifyJsonValues(patch.content)

      const effectiveShouldEmbed = shouldEmbed ?? exists.shouldEmbed
      if (effectiveShouldEmbed) {
        const emb = await embeddingProvider.embed(newContentString)
        embeddingLiteral = toVectorLiteral(emb)
      }
    } else {
      // Content didn't change.
      // If shouldEmbed changed to true, we need to embed the EXISTING content.
      if (shouldEmbed === true && exists.shouldEmbed === false) {
        // We need to re-embed existing content
        const contentStr = stringifyJsonValues(exists.content as any)
        const emb = await embeddingProvider.embed(contentStr)
        embeddingLiteral = toVectorLiteral(emb)
      }
      // If shouldEmbed changed to false, embeddingLiteral is null (default) and SQL handles clearing it.
    }

    const r = await db.query(SQL.updateEntity, [
      id,
      patch.type ?? null,
      newContent,
      shouldEmbed ?? null,
      newContentString,
      embeddingLiteral,
      patch.metadata ?? null,
    ])
    const row = r.rows[0]
    if (!row) return undefined
    return row
  }

  async function deleteEntity(id: string): Promise<boolean> {
    logger.info('deleteEntity', { id })
    const r = await db.query(SQL.deleteEntity, [id])
    return (r.rowCount ?? 0) > 0
  }

  async function searchEntities(params: SearchParams): Promise<EntityWithScore[]> {
    assertSearchParams(params)
    logger.info('searchEntities', params)
    const rawQuery = (params.query ?? '').trim()
    if (rawQuery.length <= 0) return []

    const query = prepareQuery(rawQuery)
    const qvecArr = await embeddingProvider.embed(query)
    const qvec = toVectorLiteral(qvecArr)
    const textWeight = Math.min(1, Math.max(0, params.textWeight ?? 0.5)) / 2
    const keywordWeight = textWeight
    const semWeight = 1 - (textWeight + keywordWeight)
    const limit = Math.max(1, params.limit ?? 20)

    const filter: { types?: string[]; ids?: string[]; projectIds?: string[] } = {}
    if (params.types && params.types.length > 0) filter.types = params.types
    if (params.ids && params.ids.length > 0) filter.ids = params.ids
    if (params.projectIds && params.projectIds.length > 0) filter.projectIds = params.projectIds

    const r = await db.query(SQL.searchEntitiesQuery, [
      query,
      qvec,
      limit,
      Object.keys(filter).length ? JSON.stringify(filter) : JSON.stringify({}),
      textWeight,
      keywordWeight,
      semWeight,
      50,
    ])
    return r.rows
  }

  async function matchEntities(
    criteria: any | undefined,
    options?: MatchParams,
  ): Promise<Entity[]> {
    assertMatchParams(options)
    logger.info('matchEntities', {
      criteria,
      options,
    })

    const filter: { types?: string[]; ids?: string[]; projectIds?: string[] } = {}
    if (options?.types && options.types.length > 0) filter.types = options.types
    if (options?.ids && options.ids.length > 0) filter.ids = options.ids
    if (options?.projectIds && options.projectIds.length > 0) filter.projectIds = options.projectIds

    const limit = Math.max(1, options?.limit ?? 20)
    const r = await db.query(SQL.matchEntities, [
      JSON.stringify(criteria ?? {}),
      Object.keys(filter).length ? JSON.stringify(filter) : null,
      limit,
    ])
    return r.rows
  }

  async function clearEntities(projectIds?: string[]): Promise<void> {
    logger.info('clearEntities', { count: projectIds?.length || 0 })
    if (projectIds && projectIds.length > 0) {
      await db.query(SQL.clearEntitiesByProject, [projectIds])
    } else {
      await db.query(SQL.clearEntities)
    }
  }

  async function searchEntitiesForKeywords(args: SearchEntitiesForKeywordsArgs): Promise<string[]> {
    assertSearchEntitiesForKeywordsArgs(args)
    logger.info('searchEntitiesForKeywords', {
      projectIdsCount: args.projectIds.length,
      matchMode: args.matchMode,
      typesCount: args.types?.length ?? 0,
      limit: args.limit,
    })

    const tokens = toTokens(args.keywords)
    if (tokens.length === 0) return []
    const matchMode = args.matchMode ?? 'any'
    const limit = Math.max(1, args.limit ?? 20)
    const r = await db.query(SQL.searchEntitiesForKeywords, [
      args.projectIds,
      tokens,
      matchMode,
      args.types && args.types.length > 0 ? args.types : null,
      limit,
    ])
    return (r.rows || []).map((x: any) => x.id as string)
  }

  async function searchEntitiesForExact(args: SearchEntitiesForExactArgs): Promise<string[]> {
    assertSearchEntitiesForExactArgs(args)
    logger.info('searchEntitiesForExact', {
      projectIdsCount: args.projectIds.length,
      matchMode: args.matchMode,
      caseSensitive: args.caseSensitive,
      typesCount: args.types?.length ?? 0,
      limit: args.limit,
    })

    const tokens = toTokens(args.needles)
    if (tokens.length === 0) return []
    const matchMode = args.matchMode ?? 'any'
    const caseSensitive = args.caseSensitive ?? true
    const limit = Math.max(1, args.limit ?? 20)
    const r = await db.query(SQL.searchEntitiesForExact, [
      args.projectIds,
      tokens,
      matchMode,
      caseSensitive,
      args.types && args.types.length > 0 ? args.types : null,
      limit,
    ])
    return (r.rows || []).map((x: any) => x.id as string)
  }

  return {
    addEntity,
    getEntityById,
    updateEntity,
    deleteEntity,
    searchEntities,
    matchEntities,
    clearEntities,
    searchEntitiesForKeywords,
    searchEntitiesForExact,
  }
}
