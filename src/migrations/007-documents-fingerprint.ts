import type { Migration } from './types.js'

/**
 * Adds `documents.fingerprint`: a cheap, caller-defined identity of a document's source (a file's size
 * and modification time, say). `findStaleDocumentSrcs` compares it so a sync reads and hashes only the
 * sources that changed, instead of every file of every project on each pass.
 */
export const migration007: Migration = {
  version: 7,
  id: '007-documents-fingerprint',
  up: async ({ client }) => {
    await client.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS fingerprint text;`)
  },
}
