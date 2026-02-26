# Improved DB-backed Search APIs

## Summary
This document proposes an improved set of DB-backed search APIs for project documents (files). The goal is to provide multiple explicit search operations (path-only, keyword-in-file, exact-in-file, and a unified search) that API clients can use depending on their needs.

**MVP / first implementation:** All methods may return only file paths.

**Follow-up enhancement:** Add an option or variant that also returns match locations/snippets (line/column + preview text) for content searches and optional scoring metadata for semantic results.

---

## Goals

1. Provide a fast, predictable **path-only** search.
2. Provide a **keyword-in-file** search using `,` and `;` as separators.
3. Provide an **exact substring** search using `,` and `;` as separators.
4. Provide a unified **searchFiles** that combines the above plus existing semantic search.

Non-goals (for now): regex search, AST-aware search, replace/refactor.

---

## Common definitions

### Path format
- Returned paths should be project-relative and normalized to unix separators (e.g. `src/file/FileTools.ts`).

### Tokenization for keywords/needles
When `keywords`/`needles` is provided as a string:
- Split on `/[,;]+/`.
- Trim whitespace for each token.
- Drop empty tokens.

### Optional scoping
Many methods accept `pathPrefix` to restrict results to a project-relative subdirectory.

---

## API proposals (MVP: file paths only)

### 1) `searchFilePaths`
Search only in document path/name metadata.

```ts
searchFilePaths(args: {
  projectIds: string[]
  query: string
  limit?: number
  pathPrefix?: string
}): Promise<string[]>
```

Expected behavior:
- Case-insensitive substring match on stored document `src` and/or `name`.
- No content scanning.

---

### 2) `searchInFilesKeywords`
Search inside document contents for keyword tokens.

```ts
searchInFilesKeywords(args: {
  projectIds: string[]
  keywords: string | string[]
  matchMode?: 'any' | 'all' // default: 'any'
  limit?: number
  pathPrefix?: string
}): Promise<string[]>
```

Expected behavior:
- Tokenization applies when `keywords` is a string.
- Matching is substring-based.
- Default matching should be case-insensitive (implementation may allow adding options later).
- `matchMode: 'any'` returns documents where at least one keyword matches.
- `matchMode: 'all'` returns documents where all keywords match.

---

### 3) `searchInFilesExact`
Search inside document contents for exact (literal) substring needles.

```ts
searchInFilesExact(args: {
  projectIds: string[]
  needles: string | string[]
  matchMode?: 'any' | 'all' // default: 'any'
  caseSensitive?: boolean   // default: true
  limit?: number
  pathPrefix?: string
}): Promise<string[]>
```

Expected behavior:
- Tokenization applies when `needles` is a string.
- Matching must be literal substring (not regex).
- Default `caseSensitive: true`.
- `matchMode: 'any'` returns documents where at least one needle matches.
- `matchMode: 'all'` returns documents where all needles match.

---

### 4) `searchFiles` (unified)
Combine: path search + keyword search + exact search + semantic search.

```ts
searchFiles(args: {
  projectIds: string[]
  query: string
  limit?: number
  pathPrefix?: string

  include?: {
    path?: boolean
    keyword?: boolean
    exact?: boolean
    semantic?: boolean
  }

  semantic?: {
    textWeight?: number
    limit?: number
  }
}): Promise<string[]>
```

Expected behavior:
- Run enabled sub-searches and merge results.
- De-duplicate by `src`.
- Ranking/ordering can be implementation-defined, but should be stable.

---

## Follow-up enhancement (returning match details)

To support richer client experiences, add either:
- parallel methods (e.g. `searchInFilesKeywordsWithMatches`), or
- a flag on existing methods (e.g. `includeMatches: true`).

Suggested return types:

```ts
type TextMatch = {
  needle?: string      // the matched keyword/needle when applicable
  line: number         // 1-based
  column: number       // 1-based, best-effort
  preview: string      // short surrounding snippet
  matchLength?: number // optional
}

type FileSearchHit = {
  projectId: string
  src: string
  kind: 'path' | 'keyword' | 'exact' | 'semantic'
  score?: number       // optional semantic/ranking score
  matches?: TextMatch[]
}
```

Recommended guardrails for match-returning modes:
- `maxMatchesPerFile`
- maximum bytes scanned per document
- maximum total results

---

## Implementation notes

- These APIs can reuse any stored `content` already available for semantic search.
- Exact/keyword matching should be implemented as literal substring search (not regex) for predictable behavior.
