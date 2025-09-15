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

  const mainDocuments = await db.matchDocuments({ projectIds: ['main'], limit: 1000 })
  console.log('Documents count main: ', mainDocuments.length)
  const toolsDocuments = await db.matchDocuments({ projectIds: ['thefactory-tools'], limit: 1000 })
  console.log('Documents count thefactory-tools: ', toolsDocuments.length)
  const dbDocuments = await db.matchDocuments({ projectIds: ['thefactory-db'], limit: 1000 })
  console.log('Documents count thefactory-db: ', dbDocuments.length)
  const knowledgeDocuments = await db.matchDocuments({
    projectIds: ['thefactory-knowledge'],
    limit: 1000,
  })
  console.log('Documents count thefactory-knowledge: ', knowledgeDocuments.length)

  const docResults = await db.searchDocuments({
    query: 'ipc',
    textWeight: 0.6,
    limit: 20,
    projectIds: ['main'],
  })
  console.log('\nDocument search results:')
  for (const r of docResults) {
    console.log({ id: r.id, type: r.type, src: r.src, score: r.total_score.toFixed(4) })
  }

  const docResults2 = await db.searchDocuments({
    query: 'console.log',
    textWeight: 0.9,
    limit: 20,
    projectIds: ['main'],
  })
  console.log('\nDocument search results2:')
  for (const r of docResults2) {
    console.log({ id: r.id, type: r.type, src: r.src, score: r.total_score.toFixed(4) })
  }
}

main().catch((err) => {
  console.error('[thefactory-db] Error:', err)
  process.exit(1)
})
