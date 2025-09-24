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
  if (!url) {
    console.error('[thefactory-db] Error: Database URL is required. Use --url or set DATABASE_URL')
    process.exit(1)
  }

  const db = await openDatabase({ connectionString: url })

  const allDocuments = await db.matchDocuments({
    limit: 1000,
    types: ['project_code', 'project_file', 'external_file'],
  })

  console.log('Documents count: ', allDocuments.length)
}

main().catch((err) => {
  console.error('[thefactory-db] Error:', err)
  process.exit(1)
})
