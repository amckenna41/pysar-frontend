import { useState } from 'react'
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { getDatasetRows } from '../utils/api'

export default function DatasetPreview({ rows = [], columns = [], seqCol, actCol, fileId, totalRows }) {
  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [allRows, setAllRows] = useState(null)   // fetched lazily
  const [loadingAll, setLoadingAll] = useState(false)
  const [sortCol, setSortCol] = useState('')     // column to sort by
  const [sortDir, setSortDir] = useState('asc')  // 'asc' | 'desc'

  const displayRows = showAll && allRows ? allRows : rows

  // ── Sort ──────────────────────────────────────────────────────────────────
  const sorted = sortCol
    ? [...displayRows].sort((a, b) => {
        const av = a[sortCol] ?? ''
        const bv = b[sortCol] ?? ''
        // Numeric sort if both values are numbers
        const an = parseFloat(av), bn = parseFloat(bv)
        const cmp = !isNaN(an) && !isNaN(bn) ? an - bn : String(av).localeCompare(String(bv))
        return sortDir === 'asc' ? cmp : -cmp
      })
    : displayRows

  const filtered = search
    ? sorted.filter((r) =>
        columns.some((c) => String(r[c] ?? '').toLowerCase().includes(search.toLowerCase())),
      )
    : sorted

  // ── Toggle sort direction or set new column ────────────────────────────────
  function handleSortChange(col) {
    if (col === sortCol) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
  }

  if (rows.length === 0) return null

  // ── Fetch all rows on demand ───────────────────────────────────────────────
  async function handleShowAll() {
    if (!showAll && !allRows && fileId) {
      setLoadingAll(true)
      try {
        const { rows: fetched } = await getDatasetRows(fileId)
        setAllRows(fetched)
      } catch {
        // Fall back to just showing the preview rows
      } finally {
        setLoadingAll(false)
      }
    }
    setShowAll((v) => !v)
  }

  const shownCount  = filtered.length
  const hasMore     = totalRows != null && totalRows > rows.length  // backend has more than 20

  return (
    <div className="card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
            Dataset preview
          </h3>
          <span className="badge-gray">
            {showAll ? `${shownCount} rows` : `${rows.length} of ${totalRows ?? rows.length} rows`}
          </span>
          {/* Show all / Show less toggle */}
          {hasMore && (
            <button
              type="button"
              onClick={handleShowAll}
              disabled={loadingAll}
              className="text-xs text-indigo-600 hover:text-indigo-700 font-medium disabled:opacity-50"
            >
              {loadingAll ? 'Loading…' : showAll ? 'Show less' : `Show all ${totalRows}`}
            </button>
          )}
        </div>
{/* Sort dropdown */}
        <div className="flex items-center gap-2">
          <select
            className="input py-1.5 text-xs pr-6 w-36"
            value={sortCol}
            onChange={(e) => { setSortCol(e.target.value); setSortDir('asc') }}
          >
            <option value="">Sort by…</option>
            {columns.map((col) => (
              <option key={col} value={col}>{col}</option>
            ))}
          </select>
          {/* Asc / Desc toggle — only shown when a column is selected */}
          {sortCol && (
            <button
              type="button"
              onClick={() => setSortDir((d) => d === 'asc' ? 'desc' : 'asc')}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-700 w-10 text-left"
            >
              {sortDir === 'asc' ? '↑ Asc' : '↓ Desc'}
            </button>
          )}
          {/* Search */}
          <div className="relative w-52">
            <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              className="input !pl-8 py-1.5 text-xs"
              placeholder="Filter rows…"
              value={search}
              onChange={(e) => { setSearch(e.target.value) }}
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        {/* Expand height when showing all rows */}
        <div className={showAll ? 'overflow-y-auto max-h-[32rem]' : 'overflow-y-auto max-h-72'}>
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-xs">
            <thead className="bg-gray-50 dark:bg-gray-900/50 sticky top-0 z-10">
              <tr>
                {columns.map((col) => (
                  <th
                    key={col}
                    onClick={() => handleSortChange(col)}
                    className={[
                      'px-3 py-2.5 text-left font-semibold uppercase tracking-wide whitespace-nowrap cursor-pointer select-none hover:bg-gray-100',
                      col === seqCol
                        ? 'text-indigo-600 dark:text-indigo-400'
                        : col === actCol
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-gray-500 dark:text-gray-400',
                    ].join(' ')}
                  >
                    {col}
                    {col === seqCol && <span className="ml-1 badge-indigo">seq</span>}
                    {col === actCol && <span className="ml-1 badge-green">activity</span>}
                    {col === sortCol && (
                      <span className="ml-1 text-gray-400">{sortDir === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {filtered.map((row, i) => (
                <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  {columns.map((col) => (
                    <td
                      key={col}
                      className="px-3 py-2 text-gray-700 dark:text-gray-300 font-mono max-w-xs truncate"
                      title={String(row[col] ?? '')}
                    >
                      {col === seqCol
                        ? <TruncatedSeq seq={String(row[col] ?? '')} />
                        : String(row[col] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function TruncatedSeq({ seq }) {
  const MAX = 30
  return seq.length > MAX
    ? <span title={seq}>{seq.slice(0, MAX)}<span className="text-gray-400">…</span></span>
    : seq
}
