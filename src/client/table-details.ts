import { GENUI_LIMITS } from './genui-runtime/index.ts'

export interface TableDetailSource {
  columns?: unknown
  rows?: unknown
  types?: unknown
}

/** Return the table rows available to detail rendering after row limits and header promotion. */
export function tableRowsForDetails<Row = unknown>(table: TableDetailSource): Row[] {
  if (!Array.isArray(table.rows)) return []
  const rows = table.rows.slice(0, GENUI_LIMITS.maxTableRows) as Row[]
  if (Array.isArray(table.columns) && table.columns.length > 0) return rows

  const header = rows[0]
  if (!Array.isArray(header) || header.length === 0) return rows
  const body = rows.slice(1)
  if (body.length === 0) return []
  return body.every(row => Array.isArray(row) && row.length === header.length) ? body : rows
}

/** Identify a group heading row using the same rule as the table renderer. */
export function isTableGroupHeaderRow(row: unknown, types: unknown): boolean {
  if (!Array.isArray(row) || !Array.isArray(types) || types[0] !== 'group') return false
  return String(row[0] ?? '').trim() !== ''
    && row.slice(1).every(cell => String(cell ?? '').trim() === '')
}

/** Decide whether a detail index belongs to a rendered, expandable table row. */
export function isTableDetailReachable(table: TableDetailSource, rowIndex: number): boolean {
  const rows = tableRowsForDetails(table)
  return rowIndex >= 0
    && rowIndex < rows.length
    && !isTableGroupHeaderRow(rows[rowIndex], table.types)
}
