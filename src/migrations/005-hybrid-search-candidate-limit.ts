import type { Migration } from './types.js'
import { HYBRID_SEARCH_DOCUMENTS_FUNCTION, HYBRID_SEARCH_ENTITIES_FUNCTION } from '../sql.js'

/**
 * Makes the hybrid-search per-lane candidate ceiling a PARAMETER.
 *
 * Both ranked lanes were hardcoded to `LEAST(match_count, 30) * 2` — 60 rows however many the caller asked
 * for — while the literal-substring lane was uncapped. Past 60 rows per signal the ordering was therefore
 * carried by raw substring count alone, with no semantic or full-text contribution, which silently capped
 * recall for any collection larger than that.
 *
 * The functions gain a trailing `candidate_limit integer DEFAULT 100`, clamped in SQL to
 * [1, HYBRID_CANDIDATE_LIMIT_MAX] so a `raw()` caller is bounded exactly like the typed API.
 *
 * Both definitions are imported from `src/sql.ts` rather than copied here: migration 003 was edited in place
 * and drifted from its runtime copy, which is the whole reason migration 004 exists. One source of truth
 * makes that class of bug impossible. Each constant begins with its own `DROP FUNCTION IF EXISTS` for the
 * OLD signature — `CREATE OR REPLACE` cannot change a function's argument list, so replacing without the
 * drop would leave the old overload resolvable and the new parameter unreachable.
 */
export const migration005: Migration = {
  version: 5,
  id: '005-hybrid-search-candidate-limit',
  up: async ({ client }) => {
    await client.query(HYBRID_SEARCH_DOCUMENTS_FUNCTION)
    await client.query(HYBRID_SEARCH_ENTITIES_FUNCTION)
  },
}
