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
  const url = args.url as string
  const projectId = args.p as string

  if (!url) {
    console.error('[thefactory-db] Error: Database URL is required. Use --url')
    process.exit(1)
  }

  const db = await openDatabase({ connectionString: url })
  const projectIds = projectId ? [projectId] : undefined
  await db.clearEntities(projectIds)
  await db.clearDocuments(projectIds)
  console.log('[thefactory-db] Cleared')
}

main().catch((err) => {
  console.error('[thefactory-db] Error:', err)
  process.exit(1)
})
