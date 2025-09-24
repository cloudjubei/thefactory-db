import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

// Recursive file collector for project files, ignoring heavy dirs
function collectProjectFiles(root: string): string[] {
  const ignore = new Set(['node_modules', '.git', 'dist', 'coverage', '.stories'])
  const out: string[] = []
  function walk(p: string) {
    const entries = fs.readdirSync(p, { withFileTypes: true })
    for (const e of entries) {
      if (ignore.has(e.name)) continue
      const full = path.join(p, e.name)
      const rel = path.relative(root, full)
      if (e.isDirectory()) {
        walk(full)
      } else {
        // Skip binary likely files by extension and other non-source files
        if (/\.(png|jpg|jpeg|gif|webp|ico|lock|json|svg)$/.test(e.name)) continue
        if (e.name === 'package-lock.json') continue
        out.push(rel)
      }
    }
  }
  walk(root)
  return out
}

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
      'tests/e2e/codebase-hybrid-search.e2e.test.ts',
      'src/index.ts',
      'src/utils.ts',
      'tests/hybrid-search-advanced.test.ts',
      'docs/FILE_ORGANISATION.md',
      'tests/e2e/entities-hybrid-advanced.e2e.test.ts',
      'tests/e2e/entities-hybrid.e2e.test.ts',
      'docs/HYBRIDSEARCH.md',
      'src/validation.ts',
      'scripts/example.ts',
    ])
  })

  it('w=0 (semantic-only): "hybrid search function" should prioritize semantically relevant files', async () => {
    const res = await run('hybrid search function', 0)
    const srcs = res.map((r) => r.src)
    expect(srcs).toEqual([
      'docs/HYBRIDSEARCH.md',
      'tests/e2e/entities-hybrid.e2e.test.ts',
      'scripts/example.ts',
      'tests/tokenizer.test.ts',
      'src/index.ts',
      'tests/hybrid-search-advanced.test.ts',
      'scripts/test.ts',
      'tests/utils.test.ts',
      'src/utils/json.ts',
      'tests/e2e/documents-hybrid.e2e.test.ts',
    ])
  })

  it('w=0.5 (balanced): "hybrid search function" results should be a mix', async () => {
    const res = await run('hybrid search function', 0.5)
    const srcs = res.map((r) => r.src)
    expect(srcs).toEqual([
      'src/index.ts',
      'docs/HYBRIDSEARCH.md',
      'tests/e2e/entities-hybrid.e2e.test.ts',
      'tests/hybrid-search-advanced.test.ts',
      'tests/e2e/codebase-hybrid-search.e2e.test.ts',
      'scripts/example.ts',
      'tests/e2e/entities-hybrid-advanced.e2e.test.ts',
      'docs/FILE_ORGANISATION.md',
      'scripts/test.ts',
      'src/types.ts',
    ])
  })

  it('w=1 (text-only): "pgvector" should return md files, tests and scripts', async () => {
    const res = await run('pgvector', 1)
    const srcs = res.map((r) => r.src)
    expect(srcs).toEqual([
      'README.md',
      'tests/e2e/codebase-hybrid-search.e2e.test.ts',
      'docs/FILE_ORGANISATION.md',
      'src/index.ts',
      'docs/TESTING_E2E.md',
      'docs/CODE_STANDARD.md',
      'scripts/example.ts',
      'tests/hybrid-search-advanced.test.ts',
      'docs/HYBRIDSEARCH.md',
      'scripts/clear.ts',
    ])
  })
  it('w=0 (semantic-only): "pgvector" should find files related to vector databases', async () => {
    const res = await run('pgvector', 0)
    const srcs = res.map((r) => r.src)
    expect(srcs).toEqual([
      'tests/hybrid-search-advanced.test.ts',
      'docker-compose.yml',
      'README.md',
      'docs/HYBRIDSEARCH.md',
      'docker-compose.e2e.yml',
      'src/connection.ts',
      'src/index.ts',
      'tests/embeddings.test.ts',
      'src/utils/json.ts',
      'tests/connection.test.ts',
    ])
  })
})
