import { DOCUMENT_CHUNKS_TABLE, HYBRID_SEARCH_DOCUMENTS_FUNCTION } from '../sql.js'

import type { Migration } from './types.js'

/**
 * Embeds whole documents. One vector per document only ever covered its opening (all-MiniLM-L6-v2
 * reads ~256 word pieces), so text deeper in a file was invisible to semantic search. Documents are
 * now cut into chunks (`src/chunking`), each embedded into `document_chunks`, and the semantic lane
 * of `hybrid_search_documents` ranks a document by its best chunk and returns that chunk's span.
 *
 * `documents.chunk_version` records which chunking a document was cut with; NULL for every existing
 * row, so the next sync re-chunks every document even though none changed.
 */
export const migration008: Migration = {
  version: 8,
  id: '008-document-chunks',
  up: async ({ client }) => {
    await client.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS chunk_version integer;`)
    await client.query(DOCUMENT_CHUNKS_TABLE)
    await client.query(HYBRID_SEARCH_DOCUMENTS_FUNCTION)
  },
}
