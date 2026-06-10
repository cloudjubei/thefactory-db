import type { Migration } from './types.js'
import { ENTITIES_SEARCH_FUNCTION } from './003-entities-external-key.js'

/**
 * Repairs databases that predate the `should_embed` column on `entities` /
 * its projection in `hybrid_search_entities`. Migration 003 was edited in place
 * to add `should_embed` AFTER some databases had already applied version 3, and
 * the version-keyed runner never re-applies an edited migration — so those
 * databases run an old function whose `RETURNS TABLE` omits `should_embed`, and
 * `searchEntitiesQuery` (which selects it) fails with `column "should_embed"
 * does not exist`.
 *
 * The repair is idempotent: `ADD COLUMN IF NOT EXISTS` is a no-op where the
 * column already exists, and the function is reinstalled from the single
 * definition shared with 003 so the two can never drift. A correctly-migrated
 * database simply reinstalls an identical function.
 */
export const migration004: Migration = {
  version: 4,
  id: '004-entities-should-embed-repair',
  up: async ({ client }) => {
    await client.query(`
      ALTER TABLE entities
        ADD COLUMN IF NOT EXISTS should_embed boolean NOT NULL DEFAULT true;
    `)
    await client.query(ENTITIES_SEARCH_FUNCTION)
  },
}
