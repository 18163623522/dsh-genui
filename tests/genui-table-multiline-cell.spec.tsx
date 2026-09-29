// @vitest-environment jsdom
// Regression: a table cell carrying a pasted code block lost its line breaks
// AND its leading indentation. `.table td` sets `white-space: nowrap` (the
// table's data voice), which collapses runs of spaces — so a Python snippet in
// a cell arrived as one run-on line and could no longer be copied out and run.
//
// The fix marks only cells that actually contain a line break with
// `.tdMultiline` (white-space: pre-wrap), leaving single-line cells on
// `nowrap`. This spec pins the marker; the CSS rule itself lives in
// GenuiBlock.module.css and is asserted by the role/shape below.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { GenuiBlock } from '../src/client/GenuiBlock.tsx'
import { normalizeGenuiSpec } from '../src/client/genui-runtime/normalize.ts'

afterEach(cleanup)

/** A cell exactly as the model writes one: fenced python with indentation. */
const CODE_CELL = '```python\nif a:\n    run(a)\n```'

describe('multi-line table cells keep their indentation', () => {
  it('marks a code-block cell as pre-wrap and leaves single-line cells alone', () => {
    const { container } = render(<GenuiBlock spec={{
      items: [{
        type: 'table',
        columns: ['场景', '复现命令'],
        rows: [
          ['正常', CODE_CELL],
          ['单行', 'ls -la'],
        ],
      }],
    }} />)

    const multiline = container.querySelectorAll('td[class*="tdMultiline"]')
    expect(multiline).toHaveLength(1)
    // The markup survives verbatim: fence markers and indentation included.
    const text = multiline[0]!.textContent ?? ''
    expect(text).toContain('```python')
    expect(text).toContain('    run(a)')
    expect(text).toContain('\n')
    // A plain single-line cell keeps the nowrap data voice (no marker).
    const cells = [...container.querySelectorAll('td')]
    const single = cells.find(cell => cell.textContent === 'ls -la')
    expect(single?.className).not.toContain('tdMultiline')
  })

  it('marks a multi-line header too', () => {
    const { container } = render(<GenuiBlock spec={{
      items: [{ type: 'table', columns: ['A\nB', 'C'], rows: [['1', '2']] }],
    }} />)
    expect(container.querySelectorAll('th[class*="tdMultiline"]')).toHaveLength(1)
  })

  it('pins the stylesheet rule that makes the marker effective', () => {
    // jsdom does not compute CSS-module styles, so the contract is asserted on
    // the stylesheet source: the marker must map to pre-wrap, and the default
    // cell must stay nowrap (a regression here would silently re-collapse the
    // indentation this fix preserves).
    const css = readFileSync(join(process.cwd(), 'src/client/GenuiBlock.module.css'), 'utf8')
    expect(css).toMatch(/\.table th\.tdMultiline,\s*\.table td\.tdMultiline\s*\{[^}]*white-space:\s*pre-wrap/)
    expect(css).toMatch(/\.table td\s*\{[^}]*white-space:\s*nowrap/)
  })

  it('does not treat a normalised string cell as multi-line', () => {
    const spec = normalizeGenuiSpec({
      items: [{ type: 'table', columns: ['x'], rows: [['值']] }],
    }).value as { items: Array<{ rows: string[][] }> }
    expect(spec.items[0]!.rows[0]![0]).toBe('值')
  })
})
