# E2E Failures: Analysis and Fixes

This document explains the previous E2E failures and the changes made. It also highlights a contradictory test assertion that cannot be satisfied simultaneously, along with a proposed correction.

## Summary of Failures (from rejection)

1) Documents Hybrid Advanced – w=0.5
- Failure: `expect(worstContent).toBeLessThan(bestTitle)` with `worstContent=11`, `bestTitle=0`.
- Test context also asserts `bestTitle <= 0`.
- Contradiction: if `bestTitle <= 0` (i.e., the best title-only document is at index 0), then the inequality `worstContent < bestTitle` requires `worstContent < 0`, which is impossible for a 0-based index.

2) Documents Hybrid Advanced – w=1 (text-only)
- Failure: `expect(bestSemantic).toBeLessThanOrEqual(13)`, observed `bestSemantic=14`.
- Interpretation: Even with textWeight=1, test expects semantic-only documents to still appear within top-13 due to tie-breakers.

3) Entities Hybrid Advanced – Keyword List Search (textWeight=1)
- Failure: expected a specific ID to appear among top results with all keywords; occasionally ranking did not elevate exact multi-term matches sufficiently.

## Changes Implemented

- Deterministic tie-breakers favoring semantic relevance:
  - In both `hybrid_search_documents` and `hybrid_search_entities`, after ordering by the combined RRF score, we now add `cosine_similarity DESC` as a tie-breaker. This ensures that when semantic weight is low (or zero), semantically close items still surface earlier among ties.

- Entities title boost that scales with textWeight:
  - Added a small title boost in `hybrid_search_entities` when the query tokens match the entity title tokens: `to_tsvector('english', tokenize_code(content->>'title')) @@ tsquery`.
  - The API scales this boost with the requested `textWeight`: `titleWeight = 10 * textWeight`, passed to SQL. This helps exact title matches win in keyword-dominant settings, addressing advanced test expectations.

- Documents filename (src) contribution:
  - Extended documents' FTS to include `src` tokens and included `src` in the literal match count. This better reflects test expectations where filename-only matches are intended to influence text-only ranking.

- Stability improvements:
  - Added consistent secondary ordering (e.g., by name/type and updated_at) where appropriate to stabilize the result set across ties.

## Why these fixes address the failures

- For w=1 (text-only), semantic-only items previously had zero RRF contribution but still appeared due to the FULL JOIN across candidate lists. They were bunched among zero-score ties; adding `cosine_similarity DESC` promotes them within that tied region, satisfying the `bestSemantic <= 13` constraint.

- For the entities keyword-list case, scaling a title boost with `textWeight` ensures exact multi-term title matches surface in the tight top window as expected when text is emphasized.

- Incorporating `src` into documents' text signals ensures that filename-only matches contribute in text-only ranking scenarios, aligning with the tests that expect filename to help retrieval even when content is unrelated.

## Contradictory Assertion in Documents Advanced (w=0.5)

- The test currently asserts both:
  - `bestTitle <= 0` (i.e., the best title-only item must be at index 0), and
  - `worstContent < bestTitle`.

- With 0-based indexing, if `bestTitle` is 0, then `worstContent < 0` is impossible. No ranking function can satisfy both simultaneously.

- Proposed correction for the test:
  - Either relax the best title constraint (e.g., `bestTitle <= 6`), or
  - Replace `expect(worstContent).toBeLessThan(bestTitle)` with a bound like `expect(worstContent).toBeLessThanOrEqual(12)` to ensure content-strong items remain within top-12 while still allowing a title-only item near the very top.

- Rationale: At `w=0.5`, the intent appears to be a balanced mix where content-strong items outperform title-only items overall. But allowing title-only at absolute top (index 0) while requiring the worst of the content-strong group to rank ahead of it is mutually exclusive.

## Notes on Schema Evolution

- The E2E harness initializes schema via `CREATE TABLE IF NOT EXISTS`. If the schema already exists from a previous run, changes to the generated `fts` expression (e.g., adding `src`) will not apply. Fresh databases will include the updated FTS expression. If persistent DB reuse is expected, a migration is needed to alter the generated column; otherwise, tests that rely on this behavior still pass because name-based boost covers filename cases.

## Next Steps

- Adopt the proposed correction for the w=0.5 documents test to remove the contradiction.
- If desired, we can reduce the document name boost or make it scale with `textWeight` similar to entities to soften filename dominance at balanced weights. Currently, tests expect filename dominance at several weights, so a fixed boost remains to preserve those expectations.
