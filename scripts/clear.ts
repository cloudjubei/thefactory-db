import path from 'node:path'
import { openDatabase } from '../dist/index.js'

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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const rootArg = (args.root as string) || process.cwd()
  const root = path.resolve(rootArg)
  const url = (args.url as string) || process.env.DATABASE_URL

  if (!url) {
    console.error('[thefactory-db] Error: Database URL is required. Use --url or set DATABASE_URL')
    process.exit(1)
  }

  const db = await openDatabase({ connectionString: url })

  const pool = db.raw()
  await pool.query('TRUNCATE TABLE documents, entities RESTART IDENTITY')
  console.log('[thefactory-db] Truncated tables: documents, entities')
}

main().catch((err) => {
  console.error('[thefactory-db] Error:', err)
  process.exit(1)
})
