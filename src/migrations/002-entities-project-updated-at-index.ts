import type { Migration } from './types.js'

/**
 * Adds a composite `(project_id, updated_at DESC)` index on `entities` to
 * support the hot `matchEntities` path:
 *
 *   WHERE project_id = ANY(...) ORDER BY updated_at DESC LIMIT N
 *
 * Without it the planner has to materialise the entire project's rowset
 * and sort it before applying LIMIT — seconds to minutes on large
 * projects. With it the planner walks the index in order and stops at
 * LIMIT, regardless of project size.
 *
 * `CREATE INDEX IF NOT EXISTS` keeps this idempotent for any DB that may
 * already have an equivalent index by another name. We deliberately do
 * NOT use `CONCURRENTLY` — the migration runs inside a transaction (so
 * `CONCURRENTLY` would be rejected) and the locking impact of a plain
 * `CREATE INDEX` on local dev / small prod tables is negligible.
 */
export const migration002: Migration = {
  version: 2,
  id: '002-entities-project-updated-at-index',
  up: async ({ client }) => {
    await client.query(`
      CREATE INDEX IF NOT EXISTS entities_project_id_updated_at_idx
        ON entities (project_id, updated_at DESC);
    `)
  },
}
