import type { DB } from '../connection.js'
import type {
  Document,
  DocumentInput,
  DocumentPatch,
  DocumentSourceFingerprint,
  FindStaleDocumentsOptions,
  DocumentUpsertInput,
  DocumentWithScore,
  Entity,
  EntityInput,
  EntityPatch,
  EntityWithScore,
  MatchParams,
  SearchDocumentsForExactArgs,
  SearchDocumentsForKeywordsArgs,
  SearchDocumentsForPathsArgs,
  SearchEntitiesForExactArgs,
  SearchEntitiesForKeywordsArgs,
  SearchParams,
} from '../types.js'

export interface TheFactoryDb {
  addEntity(e: EntityInput): Promise<Entity>
  upsertEntity(e: EntityInput): Promise<Entity>
  getEntityById(id: string): Promise<Entity | undefined>
  getEntityByExternalKey(
    projectId: string,
    type: string,
    externalKey: string,
  ): Promise<Entity | undefined>
  updateEntity(id: string, patch: EntityPatch): Promise<Entity | undefined>
  deleteEntity(id: string): Promise<boolean>
  searchEntities(params: SearchParams): Promise<EntityWithScore[]>
  matchEntities(
    criteria: Record<string, unknown> | undefined,
    options?: MatchParams,
  ): Promise<Entity[]>
  countEntities(
    criteria: Record<string, unknown> | undefined,
    options?: MatchParams,
  ): Promise<number>
  clearEntities(filter: { projectIds: string[]; types?: string[] }): Promise<void>

  searchEntitiesForKeywords(args: SearchEntitiesForKeywordsArgs): Promise<string[]>
  searchEntitiesForExact(args: SearchEntitiesForExactArgs): Promise<string[]>

  addDocument(d: DocumentInput): Promise<Document>
  getDocumentById(id: string): Promise<Document | undefined>
  getDocumentBySrc(projectId: string, src: string): Promise<Document | undefined>
  /**
   * Upsert a batch. With `includeOutdatedChunks: false`, a document whose content is unchanged is
   * not rewritten for an older chunk version (only its fingerprint is recorded), so a quick pass
   * leaves re-chunking to a later full one.
   */
  upsertDocuments(
    inputs: DocumentUpsertInput[],
    options?: FindStaleDocumentsOptions,
  ): Promise<Document[]>
  upsertDocument(input: DocumentUpsertInput): Promise<Document | undefined>
  updateDocument(id: string, patch: DocumentPatch): Promise<Document | undefined>
  deleteDocument(id: string): Promise<boolean>
  /** Every `src` stored for the project — the cheap listing a re-sync diffs against the tree on disk. */
  listDocumentSrcs(projectId: string): Promise<string[]>
  /**
   * The `src`s among `sources` that are not stored or were stored under another fingerprint: the only
   * sources a re-sync needs to read.
   */
  findStaleDocumentSrcs(
    projectId: string,
    sources: DocumentSourceFingerprint[],
    options?: FindStaleDocumentsOptions,
  ): Promise<string[]>
  /** Delete the project's documents at these `src`s; returns the number removed. */
  deleteDocumentsBySrc(projectId: string, srcs: string[]): Promise<number>
  matchDocuments(options: MatchParams): Promise<Document[]>
  clearDocuments(projectIds?: string[]): Promise<void>

  searchDocuments(params: SearchParams): Promise<DocumentWithScore[]>
  searchDocumentsForPaths(args: SearchDocumentsForPathsArgs): Promise<string[]>
  searchDocumentsForKeywords(args: SearchDocumentsForKeywordsArgs): Promise<string[]>
  searchDocumentsForExact(args: SearchDocumentsForExactArgs): Promise<string[]>

  close(): Promise<void>
  raw(): DB
}
