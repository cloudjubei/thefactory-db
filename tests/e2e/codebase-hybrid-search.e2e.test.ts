import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

// Recursive file collector for project files, ignoring heavy dirs
function collectProjectFiles(root: string): string[] {
  const ignore = new Set([
    'node_modules',
    '.git',
    'dist',
    'coverage',
    '.stories',
    'tests',
    '.DS_Store',
  ])
  const out: string[] = []
  function walk(p: string) {
    const entries = fs.readdirSync(p, { withFileTypes: true })
    for (const e of entries) {
      if (ignore.has(e.name)) continue
      const full = path.join(p, e.name)
      const rel = path.relative(root, full)
      if (e.isDirectory()) {
        // Skip ALL dot-directories, not just an enumerated few: `.git`, `.factory` (overseer's knowledge
        // palace) and `.pytest_cache` are tooling artifacts, never project source, and their transient
        // contents (lancedb `.txn` files, cache node-ids) otherwise leak into the corpus and reorder the
        // rankings below non-deterministically. Dot-FILES stay in scope — the goldens include `.prettierignore`.
        if (e.name.startsWith('.')) continue
        walk(full)
      } else {
        // Skip binary likely files by extension and other non-source files
        if (/\.(png|jpg|jpeg|gif|webp|ico|lock|json|svg|tgz|tar|gz|zip)$/.test(e.name)) continue
        if (e.name === 'package-lock.json') continue
        out.push(rel)
      }
    }
  }
  walk(root)
  return out
}

// NOTE: the expected arrays below are ORDER-EXACT snapshots of the ranking over THIS repo's own source
// tree, so they legitimately change whenever a file that matches the query is added, removed or edited — not
// only when ranking logic changes. Regenerate by logging `srcs` and pasting, after confirming the new order
// is sensible (relevant files, stable top result). The `collectProjectFiles` walker skips dot-DIRECTORIES so
// tooling artifacts (`.factory`, `.pytest_cache`, …) cannot leak in and make the order non-deterministic.
;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: Codebase Hybrid Search (real DB)', () => {
  const projectId = `e2e-codebase-${Date.now()}`
  let db: Awaited<ReturnType<typeof openDatabase>>

  beforeAll(async () => {
    db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
    await db.clearDocuments([projectId])

    const root = process.cwd()
    const files = collectProjectFiles(root)

    for (const rel of files) {
      const full = path.join(root, rel)
      try {
        const content = fs.readFileSync(full, 'utf8')
        // Skip empty or very large files
        if (!content.trim() || content.length > 200000) continue
        await db.addDocument({
          projectId,
          type: path.extname(rel).slice(1) || 'txt',
          src: rel,
          name: path.basename(rel),
          content,
        })
      } catch (err: any) {
        if (err.code !== 'ENOENT') {
          // ignore read errors for binary files etc
        }
      }
    }
  }, 120000) // Increase timeout for ingestion

  afterAll(async () => {
    try {
      await db.clearDocuments([projectId])
    } finally {
      await db.close()
    }
  })

  async function run(query: string, w: number, limit = 10) {
    return db.searchDocuments({ query, projectIds: [projectId], textWeight: w, limit })
  }

  it('w=1 (text-only): "hybrid search function" should return SQL and source files', async () => {
    const res = await run('hybrid search function', 1)
    const srcs = res.map((r) => r.src)
    expect(srcs).toEqual([
      'docs/SEARCH_IMPROVED.md',
      'src/migrations/005-hybrid-search-candidate-limit.ts',
      'src/sql.ts',
      'src/client/documents.ts',
      'src/validation.ts',
      'src/client/entities.ts',
      'docs/FILE_ORGANISATION.md',
      'src/types.ts',
      'src/migrations/001-init.ts',
      'README.md',
    ])
  })

  it('w=0 (semantic-only): "hybrid search function" should prioritize semantically relevant files', async () => {
    const res = await run('hybrid search function', 0)
    const srcs = res.map((r) => r.src)
    expect(srcs).toEqual([
      'docs/SEARCH_IMPROVED.md',
      'src/migrations/005-hybrid-search-candidate-limit.ts',
      'src/migrations/003-entities-external-key.ts',
      'src/migrations/001-init.ts',
      'scripts/example.ts',
      'scripts/test.ts',
      'src/validation.ts',
      'src/client/types.ts',
      'docs/CODE_STANDARD.md',
      'src/migrations/index.ts',
    ])
  })

  it('w=0.5 (balanced): "hybrid search function" results should be a mix', async () => {
    const res = await run('hybrid search function', 0.5)
    const srcs = res.map((r) => r.src)
    expect(srcs).toEqual([
      'docs/SEARCH_IMPROVED.md',
      'src/migrations/005-hybrid-search-candidate-limit.ts',
      'src/validation.ts',
      'src/migrations/001-init.ts',
      'src/migrations/003-entities-external-key.ts',
      'scripts/example.ts',
      'src/types.ts',
      'src/client/types.ts',
      'docs/FILE_ORGANISATION.md',
      'src/sql.ts',
    ])
  })

  it('w=1 (text-only): "pgvector" should return md files, tests and scripts', async () => {
    const res = await run('pgvector', 1)
    const srcs = res.map((r) => r.src)
    expect(srcs).toEqual([
      'README.md',
      'docs/FILE_ORGANISATION.md',
      'docs/TESTING_E2E.md',
      'src/runtime.ts',
      'docs/CODE_STANDARD.md',
      'scripts/example.ts',
      'docker-compose.yml',
      'docker-compose.e2e.yml',
      'src/migrations/001-init.ts',
      'src/connection.ts',
    ])
  })
  it('w=0 (semantic-only): "pgvector" should find files related to vector databases', async () => {
    const res = await run('pgvector', 0)
    const srcs = res.map((r) => r.src)
    expect(srcs).toEqual([
      'README.md',
      'docker-compose.yml',
      'src/migrations/001-init.ts',
      'docker-compose.e2e.yml',
      'src/connection.ts',
      'scripts/example.ts',
      '.prettierignore',
      'docs/FILE_ORGANISATION.md',
      'docs/TESTING_E2E.md',
      'docs/CODE_STANDARD.md',
    ])
  })
})
