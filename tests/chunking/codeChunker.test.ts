import { describe, expect, it } from 'vitest'

import { CHUNK_MAX_CHARS } from '../../src/chunking/chunkingConstants'
import type { ChunkSpan } from '../../src/chunking/chunkingTypes'
import { chunkCode } from '../../src/chunking/codeChunker'

function methods(n: number, bodyLines: number, indent = '  '): string {
  return Array.from({ length: n }, (_, i) =>
    [
      `${indent}method${i}(input: number): number {`,
      ...Array.from(
        { length: bodyLines },
        (_, j) => `${indent}  const v${j} = input * ${j} + ${i}`,
      ),
      `${indent}  return input`,
      `${indent}}`,
    ].join('\n'),
  ).join('\n\n')
}

/** The non-whitespace characters no span covers. */
function uncovered(content: string, spans: ChunkSpan[]): string {
  const covered = new Uint8Array(content.length)
  for (const s of spans) covered.fill(1, s.start, s.end)
  return [...content].filter((ch, i) => !covered[i] && ch.trim()).join('')
}

const longest = (spans: ChunkSpan[]) => Math.max(...spans.map((s) => s.end - s.start))

const calculator = `import { x } from './x'\n\nexport class Calculator {\n${methods(12, 6)}\n}\n`

describe('chunkCode', () => {
  it('resolves undefined for an extension without a grammar', async () => {
    expect(await chunkCode('fun main() = println("hi")', 'kt')).toBeUndefined()
  })

  it('keeps a small file whole in one span without a scope', async () => {
    const content = 'export function add(a: number, b: number) {\n  return a + b\n}\n'
    expect(await chunkCode(content, 'ts')).toEqual([
      { start: 0, end: content.trimEnd().length, context: '' },
    ])
  })

  it('keeps every span of a large class within the chunk limit', async () => {
    expect(longest((await chunkCode(calculator, 'ts'))!)).toBeLessThanOrEqual(CHUNK_MAX_CHARS)
  })

  it('heads the spans inside a class with the class name', async () => {
    const spans = (await chunkCode(calculator, 'ts'))!
    const inner = spans.filter((s) => calculator.slice(s.start, s.end).startsWith('method'))
    expect(inner.length).toBeGreaterThan(1)
    expect(new Set(inner.map((s) => s.context))).toEqual(new Set(['Calculator']))
  })

  it('carries a declaration’s opening line into the span of its first member', async () => {
    const spans = (await chunkCode(calculator, 'ts'))!
    const opening = spans.find((s) => calculator.slice(s.start, s.end).includes('class Calculator'))
    expect(calculator.slice(opening!.start, opening!.end)).toContain('method0(')
  })

  it('cuts no method in two while whole methods fit', async () => {
    const spans = (await chunkCode(calculator, 'ts'))!
    const count = (body: string, pattern: RegExp) => (body.match(pattern) ?? []).length
    const split = spans
      .map((s) => calculator.slice(s.start, s.end))
      .filter((b) => count(b, /method\d+\(/g) !== count(b, /^ {2}\}$/gm))
    expect(split).toEqual([])
  })

  it('names every enclosing scope, outermost first', async () => {
    const content = `class Outer {\n  build() {\n    return class Inner {\n${methods(8, 6, '      ')}\n    }\n  }\n}\n`
    const spans = (await chunkCode(content, 'js'))!
    const deep = spans.find((s) => content.slice(s.start, s.end).includes('method5('))
    expect(deep?.context).toBe('Outer › build › Inner')
  })

  it('cuts a function too large for one chunk without losing any of it', async () => {
    const body = Array.from({ length: 120 }, (_, i) => `  total += values[${i}] * ${i}`).join('\n')
    const content = `def score(values):\n  total = 0\n${body}\n  return total\n`
    const spans = (await chunkCode(content, 'py'))!
    expect(longest(spans)).toBeLessThanOrEqual(CHUNK_MAX_CHARS)
    expect(uncovered(content, spans)).toBe('')
  })

  it('cuts a syntax leaf too large for one chunk into windows headed by its scope', async () => {
    const comment = Array.from({ length: 60 }, (_, i) => `   * note ${i} about the method`).join(
      '\n',
    )
    const content = `class Notes {\n  run() {\n  /**\n${comment}\n   */\n  }\n}\n`
    const spans = (await chunkCode(content, 'ts'))!
    const windows = spans.filter((s) => content.slice(s.start, s.end).includes('* note'))
    expect(windows.length).toBeGreaterThan(1)
    expect(new Set(windows.map((s) => s.context))).toEqual(new Set(['Notes › run']))
  })

  it('returns spans in the order their code appears', async () => {
    const comment = Array.from({ length: 100 }, (_, i) => `   * note ${i}`).join('\n')
    const content = `class Notes {\n  run() {\n    const a = 1\n  /**\n${comment}\n   */\n  }\n}\n`
    const starts = (await chunkCode(content, 'ts'))!.map((s) => s.start)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
  })

  it('reads JSX in a TSX file', async () => {
    const content = `export function App() {\n  return <div className="x">{items.map((i) => <Row key={i} />)}</div>\n}\n`
    expect(await chunkCode(content, 'tsx')).toEqual([
      { start: 0, end: content.trimEnd().length, context: '' },
    ])
  })

  it('gives offsets in UTF-16 units around characters outside the basic plane', async () => {
    const content = `const turtle = '🐢 żółw'\n`
    const [span] = (await chunkCode(content, 'ts'))!
    expect(content.slice(span.start, span.end)).toBe(`const turtle = '🐢 żółw'`)
  })
})
