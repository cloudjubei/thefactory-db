/*
  Populate and test script for thefactory-db (PostgreSQL)
  - Initializes/opens a Postgres DB using a provided connection string.
  - Scans the given project root for src/ and docs/ files
  - Computes embeddings locally
  - Inserts into entities table
  - Runs a sample hybrid search

  Usage examples:
    DATABASE_URL="postgres://user:pass@localhost:5432/thefactory" node dist/scripts/populate.js --root . --textWeight 0.6 --reset
    node dist/scripts/populate.js --root . --url "postgres://user:pass@localhost:5432/thefactory"
*/

import path from 'node:path'
import fs from 'node:fs'
import { openDatabase } from '../dist/index.js'
import type { EntityType } from '../dist/types.js'

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const nxt = argv[i + 1]
      if (nxt && !nxt.startsWith('--')) {
        out[key] = nxt
        i++
      } else {
        out[key] = true
      }
    }
  }
  return out
}

function walkFiles(dir: string, ignoreDirs: Set<string>): string[] {
  const results: string[] = []
  function walk(current: string) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const e of entries) {
      const p = path.join(current, e.name)
      if (e.isDirectory()) {
        const base = path.basename(p)
        if (ignoreDirs.has(base)) continue
        walk(p)
      } else if (e.isFile()) {
        results.push(p)
      }
    }
  }
  walk(dir)
  return results
}

function inferType(root: string, filePath: string): EntityType | null {
  const rel = path.relative(root, filePath).replace(/\\/g, '/')
  if (rel.startsWith('src/')) return 'project_file'
  if (rel.startsWith('docs/')) return 'internal_document'
  return null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const rootArg = (args.root as string) || process.cwd()
  const root = path.resolve(rootArg)
  const url = (args.url as string) || process.env.DATABASE_URL
  const textWeight = Math.max(0, Math.min(1, Number(args.textWeight ?? 0.6)))
  const reset = Boolean(args.reset)

  if (!url) {
    console.error('[thefactory-db] Error: Database URL is required.')
    console.error(
      '[thefactory-db] Please provide it via the --url flag or DATABASE_URL environment variable.',
    )
    process.exit(1)
  }

  console.log(`[thefactory-db] Root: ${root}`)
  console.log(`[thefactory-db] URL:  ${url}`)
  const db = await openDatabase({ connectionString: url })

  if (reset) {
    console.log('[thefactory-db] Resetting entities table...')
    await db.raw().query('TRUNCATE TABLE entities RESTART IDENTITY')
  }

  const targets = [path.join(root, 'src'), path.join(root, 'docs')]
  const ignore = new Set(['.git', 'node_modules', 'dist', 'build', '.turbo', '.next', '.cache'])
  let files: string[] = []
  for (const t of targets) {
    if (fs.existsSync(t) && fs.statSync(t).isDirectory()) {
      files = files.concat(walkFiles(t, ignore))
    }
  }

  const MAX_SIZE = 1 * 1024 * 1024
  let inserted = 0

  console.log(`[thefactory-db] Found ${files.length} files. Processing...`)

  for (const file of files) {
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile()) continue
      if (stat.size > MAX_SIZE) continue
      const type = inferType(root, file)
      if (!type) continue

      const content = fs.readFileSync(file, 'utf8')
      const rel = path.relative(root, file).replace(/\\/g, '/')
      const metadata = {
        path: rel,
        size: stat.size,
        ext: path.extname(file),
      }

      await db.addEntity({
        type,
        content,
        metadata: JSON.stringify(metadata),
      })
      inserted++
    } catch (err) {
      console.warn(`[thefactory-db] Skipped ${file}: ${(err as Error).message}`)
    }
  }

  console.log(`[thefactory-db] Inserted ${inserted} entities.`)

  const sampleQuery = 'database vector hybrid search'
  console.log(
    `[thefactory-db] Running sample search: \"${sampleQuery}\" (textWeight=${textWeight})`,
  )
  const results = await db.searchEntities({
    query: sampleQuery,
    textWeight,
    limit: 10,
    types: ['project_file', 'internal_document'],
  })

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    let metaPath = ''
    try {
      if (r.metadata) {
        const obj = JSON.parse(r.metadata as string)
        metaPath = obj?.path || ''
      }
    } catch {}
    console.log(
      `${String(i + 1).padStart(2, ' ')}. score=${r.total_score.toFixed(4)} type=${r.type} path=${metaPath} id=${r.id}`,
    )
  }

  console.log('[thefactory-db] Done.')
}

main().catch((err) => {
  console.error('[thefactory-db] Error:', err)
  process.exit(1)
})
