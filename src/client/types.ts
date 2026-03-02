import type { DB } from '../connection.js'
import type {
  Document,
  DocumentInput,
  DocumentPatch,
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
  getEntityById(id: string): Promise<Entity | undefined>
  updateEntity(id: string, patch: EntityPatch): Promise<Entity | undefined>
  deleteEntity(id: string): Promise<boolean>
  searchEntities(params: SearchParams): Promise<EntityWithScore[]>
  matchEntities(criteria: any | undefined, options?: MatchParams): Promise<Entity[]>
  clearEntities(projectIds?: string[]): Promise<void>

  searchEntitiesForKeywords(args: SearchEntitiesForKeywordsArgs): Promise<string[]>
  searchEntitiesForExact(args: SearchEntitiesForExactArgs): Promise<string[]>

  addDocument(d: DocumentInput): Promise<Document>
  getDocumentById(id: string): Promise<Document | undefined>
  getDocumentBySrc(projectId: string, src: string): Promise<Document | undefined>
  upsertDocuments(inputs: DocumentUpsertInput[]): Promise<Document[]>
  upsertDocument(input: DocumentUpsertInput): Promise<Document | undefined>
  updateDocument(id: string, patch: DocumentPatch): Promise<Document | undefined>
  deleteDocument(id: string): Promise<boolean>
  matchDocuments(options: MatchParams): Promise<Document[]>
  clearDocuments(projectIds?: string[]): Promise<void>

  searchDocuments(params: SearchParams): Promise<DocumentWithScore[]>
  searchDocumentsForPaths(args: SearchDocumentsForPathsArgs): Promise<string[]>
  searchDocumentsForKeywords(args: SearchDocumentsForKeywordsArgs): Promise<string[]>
  searchDocumentsForExact(args: SearchDocumentsForExactArgs): Promise<string[]>

  close(): Promise<void>
  raw(): DB
}
