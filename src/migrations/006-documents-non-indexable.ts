import type { Migration } from './types.js'
import { DOCUMENT_CONTENT_HASH_FUNCTION } from '../sql.js'

/**
 * Lets a document Postgres cannot index be stored flagged rather than failing its whole batch.
 *
 * The generated `fts` column feeds the full content to `to_tsvector`, which raises
 * `program_limit_exceeded` once a document's lexemes pass 1 MB — a large data file did, and its
 * rollback dropped the 99 documents it was batched with on every ingestion. Such a document is now
 * written with no content and no embedding and `non_indexable_reason` set; the index itself is
 * unchanged.
 *
 * The content-hash trigger is replaced so a flagged row keeps the hash of the content it was given:
 * without that, an unchanged file would look changed and be embedded and rejected again each run.
 * The definition is imported from `src/sql.ts`, the single source of truth (see migration 005).
 */
export const migration006: Migration = {
  version: 6,
  id: '006-documents-non-indexable',
  up: async ({ client }) => {
    await client.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS non_indexable_reason text;`)
    await client.query(DOCUMENT_CONTENT_HASH_FUNCTION)
  },
}
