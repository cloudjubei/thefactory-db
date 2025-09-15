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
  const url = (args.url as string) || process.env.DATABASE_URL
  if (!url) {
    console.error('[thefactory-db] Error: Database URL is required. Use --url or set DATABASE_URL')
    process.exit(1)
  }

  const db = await openDatabase({ connectionString: url })

  // Seed a couple of documents (text content)
  const d1 = await db.addDocument({
    projectId: 'project1',
    type: 'note',
    content: 'This is a test document about vectors and tokens',
    src: 'file://test',
    metadata: JSON.stringify({ author: 'alice' }),
  })
  const d2 = await db.addDocument({
    projectId: 'project1',
    type: 'note',
    content: 'Another file focusing on full text search using Postgres tsvector',
    src: 'www.example.com',
    metadata: JSON.stringify({ author: 'bob' }),
  })

  // Seed a couple of entities (JSON content)
  const e1 = await db.addEntity({
    projectId: 'project2',
    type: 'note_meta',
    content: {
      info: { category: 'text', tags: ['pgvector', 'fts'] },
      title: 'Hybrid search intro',
      author: 'carol',
    },
    metadata: JSON.stringify({ source: 'example' }),
  })
  const e2 = await db.addEntity({
    projectId: 'project2',
    type: 'note_meta',
    content: {
      info: { category: 'howto', tags: ['entities', 'json'] },
      title: 'Working with JSON entities',
      author: 'dave',
    },
    metadata: JSON.stringify({ source: 'example' }),
  })

  console.log('Inserted:')
  console.log({ d1: d1.id, d2: d2.id, e1: e1.id, e2: e2.id })

  // Run document search
  const docResults = await db.searchDocuments({
    query: 'vectors OR tokens',
    textWeight: 0.6,
    limit: 10,
    types: ['note'],
  })
  console.log('\nDocument search results:')
  for (const r of docResults) {
    console.log({ id: r.id, type: r.type, score: r.total_score.toFixed(4) })
  }

  // Run entity search (hybrid search over JSON values)
  const entResults = await db.searchEntities({
    query: 'json',
    textWeight: 0.5,
    limit: 10,
    types: ['note_meta'],
  })
  console.log('\nEntity search results:')
  for (const r of entResults) {
    console.log({ id: r.id, type: r.type, score: r.total_score?.toFixed?.(4) ?? r.total_score })
  }

  // JSON match demonstration
  const matched = await db.matchEntities({ info: { category: 'text' } }, { types: ['note_meta'] })
  console.log('\nEntity match (content @> { info: { category: "text" } }):')
  for (const r of matched) {
    console.log({ id: r.id, type: r.type })
  }
}

main().catch((err) => {
  console.error('[thefactory-db] Error:', err)
  process.exit(1)
})
