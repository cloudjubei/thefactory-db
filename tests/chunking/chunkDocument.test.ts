import { describe, expect, it } from 'vitest'

import { chunkDocument } from '../../src/chunking/chunkDocument'
import { summarizeDataFile } from '../../src/chunking/dataSummary'

const kinds = async (src: string, content: string) =>
  new Set((await chunkDocument(src, content)).map((c) => c.kind))

const lineOf = (content: string, offset: number) => content.slice(0, offset).split('\n').length

const logLines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i} of the log file`).join('\n')

const classWithMethods = `export class Calculator {\n${Array.from(
  { length: 12 },
  (_, i) =>
    `  method${i}(input: number): number {\n${'    input += 1\n'.repeat(8)}    return input\n  }`,
).join('\n\n')}\n}\n`

describe('chunkDocument', () => {
  it('chunks a file with a grammar along its syntax', async () => {
    expect(await kinds('src/math.ts', 'export const one = 1\n')).toEqual(new Set(['code']))
  })

  it('chunks a markdown file along its headings, whatever the extension’s case', async () => {
    expect(await kinds('docs/README.MD', '# Title\n\nbody\n')).toEqual(new Set(['markdown']))
  })

  it('chunks a file without a grammar as text', async () => {
    expect(await kinds('app/Main.kt', 'fun main() = println("hi")\n')).toEqual(new Set(['text']))
  })

  it('reads a leading dot as part of the name, not an extension', async () => {
    expect(await kinds('config/.md', '# not markdown\n')).toEqual(new Set(['text']))
  })

  it('heads a chunk with its path alone when it sits in no scope', async () => {
    const [chunk] = await chunkDocument('src/math.ts', 'export const one = 1\n')
    expect(chunk.text).toBe('src/math.ts\nexport const one = 1')
  })

  it('heads a chunk with its path and scope when it sits in one', async () => {
    const chunks = await chunkDocument('src/calc.ts', classWithMethods)
    expect(chunks.at(-1)!.text.split('\n')[0]).toBe('src/calc.ts · Calculator')
  })

  it('numbers chunks in order from zero', async () => {
    const chunks = await chunkDocument('src/calc.ts', classWithMethods)
    expect(chunks.map((c) => c.ord)).toEqual(chunks.map((_, i) => i))
  })

  it('gives each chunk the lines its first and last characters sit on', async () => {
    const content = logLines(300)
    const chunks = await chunkDocument('logs/run.txt', content)
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual(
      chunks.map((c) => [lineOf(content, c.startChar), lineOf(content, c.endChar - 1)]),
    )
  })

  it('gives each chunk the text its offsets cover, after the header', async () => {
    const content = `const turtle = '🐢 żółw'\n${classWithMethods}`
    const chunks = await chunkDocument('src/emoji.ts', content)
    const mismatched = chunks.filter(
      (c) => c.text.slice(c.text.indexOf('\n') + 1) !== content.slice(c.startChar, c.endChar),
    )
    expect(mismatched).toEqual([])
  })

  it('still gives a file of only whitespace one chunk, so its path stays findable', async () => {
    expect(await chunkDocument('src/empty.ts', '  \n')).toEqual([
      {
        ord: 0,
        kind: 'text',
        startChar: 0,
        endChar: 0,
        startLine: 1,
        endLine: 1,
        text: 'src/empty.ts\n',
      },
    ])
  })

  it('gives a data file one summary chunk spanning the whole file', async () => {
    const content = '1,2,3\n4,5,6\n7,8,9\n'
    expect(await chunkDocument('data/grid.csv', content)).toEqual([
      {
        ord: 0,
        kind: 'summary',
        startChar: 0,
        endChar: content.length,
        startLine: 1,
        endLine: 3,
        text: `data/grid.csv\n${summarizeDataFile('csv', content)}`,
      },
    ])
  })
})
