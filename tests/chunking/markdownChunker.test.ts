import { describe, expect, it } from 'vitest'

import { CHUNK_MAX_CHARS } from '../../src/chunking/chunkingConstants'
import { chunkMarkdown } from '../../src/chunking/markdownChunker'

/** A paragraph of about `chars` characters, longer than half a chunk so two never pack together. */
const para = (word: string, chars = 500) =>
  Array.from({ length: Math.ceil(chars / (word.length + 4)) }, (_, i) => `${word} ${i}.`).join(' ')

const contexts = (content: string) => chunkMarkdown(content).map((s) => s.context)

describe('chunkMarkdown', () => {
  it('heads each section with the path of headings it sits under', () => {
    const content = [
      '# Guide',
      para('Intro'),
      '## Install',
      para('Install'),
      '### Docker',
      para('Docker'),
      '## Usage',
      para('Usage'),
    ].join('\n\n')
    expect(contexts(content)).toEqual([
      'Guide',
      'Guide › Install',
      'Guide › Install › Docker',
      'Guide › Usage',
    ])
  })

  it('leaves a skipped heading level out of the path', () => {
    expect(contexts(['# Top', para('A'), '### Deep', para('B')].join('\n\n'))).toEqual([
      'Top',
      'Top › Deep',
    ])
  })

  it('packs small sections together under the first one’s path', () => {
    expect(chunkMarkdown('# A\nshort\n\n# B\nshort too\n')).toEqual([
      { start: 0, end: 24, context: 'A' },
    ])
  })

  it('skips whitespace before the first heading', () => {
    expect(chunkMarkdown('\n\n  \n# Title\nbody')).toEqual([
      { start: 5, end: 17, context: 'Title' },
    ])
  })

  it('does not read a # line inside a code fence as a heading', () => {
    const content = ['# Real', para('Before'), '```bash\n# not a heading\n```', para('After')].join(
      '\n\n',
    )
    expect(new Set(contexts(content))).toEqual(new Set(['Real']))
  })

  it('keeps a fence open across a line fenced with the other marker', () => {
    const content = [
      '# Real',
      para('Before'),
      '~~~md\n```\n# not a heading\n~~~',
      para('After'),
    ].join('\n\n')
    expect(new Set(contexts(content))).toEqual(new Set(['Real']))
  })

  it('keeps a fence open across a shorter marker of the same kind', () => {
    const content = [
      '# Real',
      para('Before'),
      '````md\n```\n# not a heading\n````',
      para('After'),
    ].join('\n\n')
    expect(new Set(contexts(content))).toEqual(new Set(['Real']))
  })

  it('splits a section too long for one chunk along its paragraphs', () => {
    const paragraphs = [para('One'), para('Two'), para('Three')]
    const content = ['# Notes', ...paragraphs].join('\n\n')
    const bodies = chunkMarkdown(content).map((s) => content.slice(s.start, s.end))
    expect(bodies).toEqual([`# Notes\n\n${paragraphs[0]}`, paragraphs[1], paragraphs[2]])
  })

  it('cuts a paragraph too long for one chunk into windows', () => {
    const content = `# Log\n\n${para('Entry', CHUNK_MAX_CHARS * 3)}`
    const spans = chunkMarkdown(content)
    expect(spans.length).toBeGreaterThan(3)
    expect(Math.max(...spans.map((s) => s.end - s.start))).toBeLessThanOrEqual(CHUNK_MAX_CHARS)
  })

  it('leaves no empty piece for a run of blank lines between paragraphs', () => {
    const content = ['# Notes', para('One'), '', '', para('Two')].join('\n\n')
    const bodies = chunkMarkdown(content).map((s) => content.slice(s.start, s.end).trim())
    expect(bodies.every((b) => b.length > 0)).toBe(true)
  })
})
