import { openDatabase } from '../dist/index.js'

async function main() {
  console.log('RUNNING ExAMPLE')
  const url = process.env.DATABASE_URL || './database-example'
  const db = await openDatabase({ connectionString: url })

  const pool = db.raw()
  const countRes = await pool.query('SELECT COUNT(*)::int AS c FROM entities')
  const count = (countRes.rows[0]?.c as number) || 0
  if (count === 0) {
    await db.addEntity({
      type: 'internal_document',
      content: 'This is a test document about vectors and tokens',
    })
    await db.addEntity({
      type: 'project_file',
      content: 'Another file focusing on full text search using Postgres tsvector',
    })
    await db.addEntity({
      type: 'external_blob',
      content: 'Another file focusing on embedding search using pgvector',
    })
  }

  const results = await db.searchEntities({
    query: 'vectors OR tokens',
    textWeight: 0.6,
    limit: 10,
  })

  console.log('Results:', results)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
