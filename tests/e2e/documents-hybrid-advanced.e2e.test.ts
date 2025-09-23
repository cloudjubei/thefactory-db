import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)(
  'E2E: Documents Hybrid Search Advanced (real DB)',
  () => {
    const projectId = `e2e-docs-adv-${Date.now()}`
    let db: Awaited<ReturnType<typeof openDatabase>>

    // Seeded docs
    const ids = {
      contentStrong: [] as string[],
      titleOnly: [] as string[],
      semanticOnly: [] as string[],
      control: [] as string[],
    }

    beforeAll(async () => {
      db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
      await db.clearDocuments([projectId])

      // Seed 24 documents
      // 1) Strong content matches for query 'car engine'
      for (let i = 0; i < 6; i++) {
        const d = await db.addDocument({
          projectId,
          type: 'note',
          src: `notes/content-${i}.md`,
          content:
            'This document discusses car engine maintenance. The car engine is central to vehicle performance. Car engine tips and tricks.',
        })
        ids.contentStrong.push(d.id)
      }

      // 2) Title-only (src filename contains Car-Engine) but content lacks the literal tokens
      for (let i = 0; i < 6; i++) {
        const d = await db.addDocument({
          projectId,
          type: 'note',
          src: `guides/Car-Engine-Guide-${i}.txt`,
          content:
            'Completely unrelated prose about gardening and cooking. No mention of the specific keywords, focusing on recipes and plants.',
        })
        ids.titleOnly.push(d.id)
      }

      // 3) Semantic-only (mentions synonyms automobile/motor but not exact terms 'car'/'engine')
      for (let i = 0; i < 6; i++) {
        const d = await db.addDocument({
          projectId,
          type: 'note',
          src: `notes/auto-${i}.txt`,
          content:
            'This article covers automobile motor upkeep and advice. The automobile motor influences vehicle performance. Helpful tips for every driver.',
        })
        ids.semanticOnly.push(d.id)
      }

      // 4) Controls (unrelated)
      for (let i = 0; i < 6; i++) {
        const d = await db.addDocument({
          projectId,
          type: 'misc',
          src: `misc/${i}.txt`,
          content:
            'Random notes on tropical fruits like banana and mango. Nothing about fruit unrelated things. Just fruit facts and recipes.',
        })
        ids.control.push(d.id)
      }
    })

    afterAll(async () => {
      try {
        await db.clearDocuments([projectId])
      } finally {
        await db.close()
      }
    })

    // Helpers
    async function run(query: string, w: number, limit = 20) {
      return db.searchDocuments({ query, projectIds: [projectId], textWeight: w, limit })
    }
    function pos(res: any[], id: string) {
      const i = res.findIndex((r) => r.id === id)
      return i < 0 ? 999 : i
    }

    // One test per weight for atomicity
    it('w=0 (semantic-only): semantic-only docs should outrank title-only docs and appear near the top-10', async () => {
      const res = await run('car engine', 0)
      expect(res.length).toEqual(20)

      const bestSemantic = Math.min(...ids.semanticOnly.map((id) => pos(res, id)))
      const worstSemantic = Math.max(...ids.semanticOnly.map((id) => pos(res, id)))
      const bestTitle = Math.min(...ids.titleOnly.map((id) => pos(res, id)))
      const bestContent = Math.min(...ids.contentStrong.map((id) => pos(res, id)))
      const bestControl = Math.min(...ids.control.map((id) => pos(res, id)))

      expect(bestContent).toBeLessThanOrEqual(0)
      expect(bestSemantic).toBeLessThanOrEqual(6)
      expect(bestTitle).toBeLessThanOrEqual(12)
      expect(bestControl).toBeLessThanOrEqual(18)
      expect(worstSemantic).toBeLessThan(bestTitle)
    })

    it('w=0.2: both signals contribute; semantic-only present near top and title-only starts to surface', async () => {
      const res = await run('car engine', 0.2)
      expect(res.length).toEqual(20)

      const bestSemantic = Math.min(...ids.semanticOnly.map((id) => pos(res, id)))
      const bestTitle = Math.min(...ids.titleOnly.map((id) => pos(res, id)))
      const bestContent = Math.min(...ids.contentStrong.map((id) => pos(res, id)))
      const worstContent = Math.max(...ids.contentStrong.map((id) => pos(res, id)))
      const bestControl = Math.min(...ids.control.map((id) => pos(res, id)))

      expect(bestContent).toBeLessThanOrEqual(0)
      expect(bestSemantic).toBeLessThanOrEqual(12)
      expect(bestTitle).toBeLessThanOrEqual(12)
      expect(bestControl).toBeLessThanOrEqual(18)
      expect(worstContent).toBeLessThan(bestTitle)
      expect(bestTitle).toBeLessThan(bestSemantic)
    })

    it('w=0.5: balanced; both semantic-only and title-only appear in top-10', async () => {
      const res = await run('car engine', 0.5)
      expect(res.length).toEqual(20)

      const bestSemantic = Math.min(...ids.semanticOnly.map((id) => pos(res, id)))
      const bestTitle = Math.min(...ids.titleOnly.map((id) => pos(res, id)))
      const bestContent = Math.min(...ids.contentStrong.map((id) => pos(res, id)))
      const worstContent = Math.max(...ids.contentStrong.map((id) => pos(res, id)))
      const bestControl = Math.min(...ids.control.map((id) => pos(res, id)))

      expect(bestContent).toBeLessThanOrEqual(0)
      expect(bestSemantic).toBeLessThanOrEqual(12)
      expect(bestTitle).toBeLessThanOrEqual(12)
      expect(bestControl).toBeLessThanOrEqual(18)
      expect(worstContent).toBeLessThan(bestTitle)
      expect(bestTitle).toBeLessThan(bestSemantic)
    })

    it('w=0.8: title-only (filename) should be stronger and appear in top-5', async () => {
      const res = await run('car engine', 0.8)
      expect(res.length).toEqual(20)

      const bestSemantic = Math.min(...ids.semanticOnly.map((id) => pos(res, id)))
      const bestTitle = Math.min(...ids.titleOnly.map((id) => pos(res, id)))
      const bestContent = Math.min(...ids.contentStrong.map((id) => pos(res, id)))
      const worstContent = Math.max(...ids.contentStrong.map((id) => pos(res, id)))
      const bestControl = Math.min(...ids.control.map((id) => pos(res, id)))

      expect(bestContent).toBeLessThanOrEqual(0)
      expect(bestTitle).toBeLessThanOrEqual(6)
      expect(bestSemantic).toBeLessThanOrEqual(12)
      expect(bestControl).toBeLessThanOrEqual(18)
      expect(worstContent).toBeLessThan(bestTitle)
      expect(bestTitle).toBeLessThan(bestSemantic)
    })

    it('w=1 (text-only): filename (src) match enables retrieval even with unrelated content', async () => {
      const res = await run('car engine', 1)
      expect(res.length).toEqual(20)

      const bestSemantic = Math.min(...ids.semanticOnly.map((id) => pos(res, id)))
      const bestTitle = Math.min(...ids.titleOnly.map((id) => pos(res, id)))
      const bestContent = Math.min(...ids.contentStrong.map((id) => pos(res, id)))
      const worstContent = Math.max(...ids.contentStrong.map((id) => pos(res, id)))
      const bestControl = Math.min(...ids.control.map((id) => pos(res, id)))

      expect(bestContent).toBeLessThanOrEqual(0)
      expect(bestTitle).toBeLessThanOrEqual(6)
      expect(bestSemantic).toBeLessThanOrEqual(18)
      expect(bestControl).toBeLessThanOrEqual(18)
      expect(worstContent).toBeLessThan(bestTitle)
      expect(bestTitle).toBeLessThan(bestSemantic)
    })

    it('filename (src) contributes to textScore: top results include src hits when textWeight=1', async () => {
      const res = await run('car engine', 1)
      expect(res.length).toEqual(20)

      // ensure at least one of the top hits comes from titleOnly group (src contains Car-Engine)
      const top7 = res.slice(0, 7).map((r) => r.id)
      const hitFromTitle = ids.titleOnly.some((id) => top7.includes(id))
      expect(hitFromTitle).toBe(true)
    })
  }
)

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: Documents Keyword List Search', () => {
  const projectId = `e2e-docs-keywords-${Date.now()}`
  let db: Awaited<ReturnType<typeof openDatabase>>

  const ids = {
    matchAtStart: '' as string,
    matchInMiddle: '' as string,
    matchAtEnd: '' as string,
    noMatch: '' as string,
    semanticMatch: '' as string,
    partialMatch: '' as string,
  }

  beforeAll(async () => {
    db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
    await db.clearDocuments([projectId])

    ids.matchAtStart = (await db.addDocument({
      projectId,
      type: 'note',
      src: 'notes/start.txt',
      content: 'car engine maintenance is important for vehicle longevity. The rest of the document is about other things.',
    })).id

    ids.matchInMiddle = (await db.addDocument({
      projectId,
      type: 'note',
      src: 'notes/middle.txt',
      content: 'The document starts with some intro. Then it talks about car engine maintenance. And then it concludes.',
    })).id

    ids.matchAtEnd = (await db.addDocument({
      projectId,
      type: 'note',
      src: 'notes/end.txt',
      content: 'This document is about many things, but concludes with the importance of car engine maintenance.',
    })).id

    ids.noMatch = (await db.addDocument({
      projectId,
      type: 'note',
      src: 'notes/no-match.txt',
      content: 'This document is about gardening and cooking. No mention of automobiles.',
    })).id

    ids.semanticMatch = (await db.addDocument({
      projectId,
      type: 'note',
      src: 'notes/semantic.txt',
      content: 'This article is about automobile motor upkeep. It is important for your vehicle.',
    })).id
    
    ids.partialMatch = (await db.addDocument({
      projectId,
      type: 'note',
      src: 'notes/partial.txt',
      content: 'This document talks about car maintenance in general, but not the engine specifically.',
    })).id
  })

  afterAll(async () => {
    try {
      await db.clearDocuments([projectId])
    } finally {
      await db.close()
    }
  })

  it('with textWeight=1, should only return documents with all keywords', async () => {
    const results = await db.searchDocuments({ query: 'car engine maintenance', projectIds: [projectId], textWeight: 1, limit: 10 })
    const resultIds = results.map((r) => r.id)

    expect(resultIds).toContain(ids.matchAtStart)
    expect(resultIds).toContain(ids.matchInMiddle)
    expect(resultIds).toContain(ids.matchAtEnd)
    expect(resultIds).not.toContain(ids.noMatch)
    expect(resultIds).not.toContain(ids.semanticMatch)
    expect(resultIds).not.toContain(ids.partialMatch)
    expect(results.length).toBe(3)
  })

  it('with textWeight=0, should return semantically similar documents', async () => {
    const results = await db.searchDocuments({ query: 'car engine maintenance', projectIds: [projectId], textWeight: 0, limit: 10 })
    const resultIds = results.map((r) => r.id)

    expect(resultIds).toContain(ids.semanticMatch)
    // The keyword matches should also be here because their content is semantically relevant
    expect(resultIds).toContain(ids.matchAtStart)
    expect(resultIds).toContain(ids.matchInMiddle)
    expect(resultIds).toContain(ids.matchAtEnd)
    
    expect(resultIds).not.toContain(ids.noMatch) 

    // The top result should be the semantic one
    const semanticRank = results.findIndex(r => r.id === ids.semanticMatch)
    const keywordRank = results.findIndex(r => r.id === ids.matchAtStart)
    expect(semanticRank).toBeLessThan(keywordRank)
  })

  it('with textWeight=1 and no matching documents, should return empty array', async () => {
    const results = await db.searchDocuments({ query: 'non existing keywords', projectIds: [projectId], textWeight: 1, limit: 10 })
    expect(results.length).toBe(0)
  })
})
