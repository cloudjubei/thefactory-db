
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

  const db = await openDatabase({ connectionString: url })

  const pool = db.raw()
  const res = await pool.query('TRUNCATE TABLE entities')
  console.log(res)
}

main().catch((err) => {
  console.error('[thefactory-db] Error:', err)
  process.exit(1)
})

