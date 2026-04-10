import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import * as XLSX from 'xlsx'
import confetti from 'canvas-confetti'
import {
  ArrowLeftIcon,
  ArrowDownTrayIcon,
  ArrowsUpDownIcon,
  ChartBarIcon,
  TableCellsIcon,
  AdjustmentsHorizontalIcon,
  EyeSlashIcon,
  EyeIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
  ArrowTopRightOnSquareIcon,
  ClipboardDocumentIcon,
  BookmarkIcon,
  BookmarkSlashIcon,
  ScaleIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline'
import { useAppStore } from '../store/appStore'
import ResultsCharts from '../components/ResultsCharts'
import toast from 'react-hot-toast'

const METRIC_COLS = ['R2', 'RMSE', 'MSE', 'MAE', 'RPD', 'Explained_Var']

// Metric column descriptions for header tooltips
const METRIC_TOOLTIPS = {
  R2:           'R² (coefficient of determination): proportion of variance explained. 0–1, higher is better.',
  RMSE:         'Root Mean Square Error: std dev of prediction errors. Lower is better.',
  MSE:          'Mean Square Error: average squared residuals. Lower is better.',
  MAE:          'Mean Absolute Error: average absolute residuals. Lower is better.',
  RPD:          'Ratio of Performance to Deviation: RMSE / std(y). >2 is good, >3 is excellent.',
  Explained_Var:'Explained Variance Score: 1 − Var(y − ŷ) / Var(y). 0–1, higher is better.',
}

// ── R² quality badge ──────────────────────────────────────────────────────────
function r2QualityLabel(r2) {
  if (r2 == null) return null
  if (r2 >= 0.9) return { label: 'Excellent', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' }
  if (r2 >= 0.7) return { label: 'Good',      cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' }
  if (r2 >= 0.5) return { label: 'Fair',      cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' }
  return           { label: 'Poor',      cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' }
}

// ── Model identifier — pick the first non-metric column value ─────────────────
function modelId(row, columns) {
  const key = columns.find((c) => !METRIC_COLS.includes(c) && c !== 'Rank_Pct')
  return row[key] ?? row.Index ?? row.Descriptor ?? row.index ?? row.descriptor ?? 'Model'
}

export default function Step4Results() {
  const { results, resultColumns, setStep, job, encoding, setEncoding, jobHistory } = useAppStore()

  // ── Tab navigation ────────────────────────────────────────────────────────
  const [tab, setTab] = useState('table')

  // ── Table state ───────────────────────────────────────────────────────────
  const [sortCol, setSortCol]       = useState('R2')
  const [sortDir, setSortDir]       = useState('desc')
  const [filterText, setFilterText] = useState('')
  const [page, setPage]             = useState(0)
  const PAGE_SIZE = 50

  // ── Threshold filters — per metric ───────────────────────────────────────
  const [thresholds, setThresholds] = useState({})
  const [showFilters, setShowFilters] = useState(false)

  // ── Column visibility ─────────────────────────────────────────────────────
  const [hiddenCols, setHiddenCols]   = useState(new Set())
  const [showColPicker, setShowColPicker] = useState(false)

  // ── Pinned / compare rows ─────────────────────────────────────────────────
  const [pinnedKeys, setPinnedKeys] = useState(new Set()) // Set of model id strings

  // ── Row detail drawer ─────────────────────────────────────────────────────
  const [detailRow, setDetailRow] = useState(null)

  // ── Stats panel ───────────────────────────────────────────────────────────
  const [showStats, setShowStats] = useState(false)

  // ── Visible columns (excluding hidden) ───────────────────────────────────
  const visibleCols = useMemo(
    () => (resultColumns ?? []).filter((c) => !hiddenCols.has(c)),
    [resultColumns, hiddenCols]
  )

  // ── Sorted + filtered + threshold rows ───────────────────────────────────
  const rows = useMemo(() => {
    if (!results) return []
    let data = [...results]

    // Text filter
    if (filterText.trim()) {
      const q = filterText.toLowerCase()
      data = data.filter((r) =>
        Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q))
      )
    }

    // Threshold filters (min/max per metric)
    METRIC_COLS.forEach((m) => {
      const { min, max } = thresholds[m] ?? {}
      if (min !== undefined && min !== '') data = data.filter((r) => (r[m] ?? 0) >= parseFloat(min))
      if (max !== undefined && max !== '') data = data.filter((r) => (r[m] ?? 0) <= parseFloat(max))
    })

    // Sort
    data.sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol]
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av
      }
      return sortDir === 'asc'
        ? String(av ?? '').localeCompare(String(bv ?? ''))
        : String(bv ?? '').localeCompare(String(av ?? ''))
    })

    return data
  }, [results, sortCol, sortDir, filterText, thresholds])

  // ── Rows with rank percentile column injected ─────────────────────────────
  const rowsWithRank = useMemo(() => {
    const n = rows.length
    return rows.map((r, i) => ({ ...r, Rank_Pct: n > 1 ? Math.round(((n - 1 - i) / (n - 1)) * 100) : 100 }))
  }, [rows])

  // ── Paginated slice ───────────────────────────────────────────────────────
  const pageRows = useMemo(
    () => rowsWithRank.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [rowsWithRank, page]
  )
  const totalPages = Math.ceil(rowsWithRank.length / PAGE_SIZE)

  // ── Summary stats (describe-style) ────────────────────────────────────────
  const statsTable = useMemo(() => {
    if (!results?.length) return []
    return METRIC_COLS.filter((m) => resultColumns?.includes(m)).map((m) => {
      const vals = results.map((r) => r[m]).filter((v) => typeof v === 'number')
      if (!vals.length) return null
      const sorted = [...vals].sort((a, b) => a - b)
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length
      const std  = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length)
      return {
        metric: m,
        count: vals.length,
        mean: mean.toFixed(4),
        std:  std.toFixed(4),
        min:  sorted[0].toFixed(4),
        p25:  sorted[Math.floor(vals.length * 0.25)].toFixed(4),
        median: sorted[Math.floor(vals.length * 0.5)].toFixed(4),
        p75:  sorted[Math.floor(vals.length * 0.75)].toFixed(4),
        max:  sorted[sorted.length - 1].toFixed(4),
      }
    }).filter(Boolean)
  }, [results, resultColumns])

  // ── Pinned compare rows ───────────────────────────────────────────────────
  const pinnedRows = useMemo(
    () => rowsWithRank.filter((r) => pinnedKeys.has(modelId(r, resultColumns ?? []))),
    [rowsWithRank, pinnedKeys, resultColumns]
  )

  function togglePin(row) {
    const id = modelId(row, resultColumns ?? [])
    setPinnedKeys((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // ── Summary cards ─────────────────────────────────────────────────────────
  const best = rows[0]
  const summary = best
    ? [
        { label: 'Best R²',   value: best.R2?.toFixed(4)   ?? '—', color: 'text-green-600 dark:text-green-400' },
        { label: 'Best RMSE', value: best.RMSE?.toFixed(4) ?? '—', color: 'text-indigo-600 dark:text-indigo-400' },
        { label: 'Best MAE',  value: best.MAE?.toFixed(4)  ?? '—', color: 'text-amber-600 dark:text-amber-400' },
        { label: 'Models',    value: results?.length ?? 0,          color: 'text-gray-700 dark:text-gray-200' },
        { label: 'Algorithm', value: job?.algorithm ?? '—',         color: 'text-gray-700 dark:text-gray-200' },
        { label: 'Strategy',  value: job?.strategy  ?? '—',         color: 'text-gray-700 dark:text-gray-200' },
      ]
    : []

  // ── Exports ───────────────────────────────────────────────────────────────
  function handleExport() {
    if (!results?.length || !resultColumns?.length) return
    const header = resultColumns.join(',')
    const csvRows = results.map((r) =>
      resultColumns.map((c) => JSON.stringify(r[c] ?? '')).join(',')
    )
    downloadBlob([header, ...csvRows].join('\n'), 'text/csv', 'pysar_results.csv')
  }

  function handleExportExcel() {
    if (!results?.length || !resultColumns?.length) return
    const ws = XLSX.utils.json_to_sheet(results, { header: resultColumns })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'pySAR Results')
    XLSX.writeFile(wb, 'pysar_results.xlsx')
  }

  function handleExportJSON() {
    if (!results?.length) return
    const payload = { job_id: job?.job_id, strategy: job?.strategy, algorithm: job?.algorithm, results }
    downloadBlob(JSON.stringify(payload, null, 2), 'application/json', 'pysar_results.json')
  }

  // ── "Use this model" — pre-fills Step 3 with sole this index/descriptor ───
  function useThisModel(row) {
    const id    = modelId(row, resultColumns ?? [])
    const strat = job?.strategy ?? encoding.strategy
    if (strat === 'aai' || strat === 'aai_descriptor') {
      setEncoding({ strategy: 'aai', aai_indices: [id] })
    } else {
      setEncoding({ strategy: 'descriptor', selected_descriptors: [id] })
    }
    setStep(3)
    toast.success(`Pre-filled Step 3 with "${id}"`)
  }

  function toggleSort(col) {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortCol(col)
      setSortDir(METRIC_COLS.includes(col) ? 'desc' : 'asc')
    }
    setPage(0)
  }

  // ── Run-over-run comparison ───────────────────────────────────────────────
  const completedHistory = useMemo(
    () => (jobHistory ?? []).filter((e) => e.status === 'completed' && e.best_r2 != null),
    [jobHistory]
  )

  // ── Confetti on excellent R² (fires once per new result set) ─────────────
  const confettiFired = useRef(false)
  useEffect(() => {
    if (confettiFired.current || !best?.R2 || best.R2 < 0.9) return
    confettiFired.current = true
    confetti({ particleCount: 120, spread: 70, origin: { y: 0.6 }, colors: ['#6366f1', '#10b981', '#f59e0b'] })
  }, [best?.R2])

  if (!results) {
    return (
      <div className="text-center py-20 text-gray-400 dark:text-gray-500">
        <ChartBarIcon className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p>No results yet — run an encoding job first.</p>
        <button className="btn-secondary mt-4" onClick={() => setStep(3)}>
          <ArrowLeftIcon className="w-4 h-4" /> Back to Encoding
        </button>
      </div>
    )
  }

  const qualityBadge = r2QualityLabel(best?.R2)

  return (
    <div className="max-w-6xl mx-auto space-y-5">

      {/* ── Summary cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {summary.map(({ label, value, color }) => (
          <div key={label} className="card p-3 text-center">
            <p className={`text-lg font-bold ${color}`}>{value}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {/* ── Best model highlight ── */}
      {best && (
        <div className="card p-4 bg-gradient-to-r from-indigo-50 to-white dark:from-indigo-900/20 dark:to-gray-800">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-indigo-500 mb-1">Top model</p>
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-lg font-bold text-gray-900 dark:text-white">
                  {modelId(best, resultColumns ?? [])}
                </p>
                {best.Category && <span className="badge-indigo">{best.Category}</span>}
              </div>
              <div className="flex flex-wrap gap-4 mt-2 text-sm text-gray-600 dark:text-gray-300">
                {METRIC_COLS.map((m) => best[m] != null && (
                  <span key={m}><span className="font-medium">{m}:</span> {typeof best[m] === 'number' ? best[m].toFixed(4) : best[m]}</span>
                ))}
              </div>
            </div>
            {/* Use this model CTA */}
            <button
              onClick={() => useThisModel(best)}
              className="flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-700 border border-indigo-300 rounded-lg px-3 py-2 shrink-0"
              title="Pre-fill Step 3 with this model's index/descriptor"
            >
              <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" /> Use this model
            </button>
          </div>
        </div>
      )}

      {/* ── Pinned comparison panel ── */}
      {pinnedRows.length > 0 && (
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Comparing {pinnedRows.length} pinned model{pinnedRows.length !== 1 ? 's' : ''}
              <span className="ml-2 font-normal text-gray-400 normal-case">(Δ vs best overall)</span>
            </p>
            <button
              type="button"
              className="text-xs text-gray-400 hover:text-red-500"
              onClick={() => setPinnedKeys(new Set())}
              aria-label="Clear all pinned models"
            >
              Clear all
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 text-left">
                  <th className="pb-1 pr-3 font-medium">Model</th>
                  {METRIC_COLS.filter((m) => resultColumns?.includes(m)).map((m) => (
                    <th key={m} className="pb-1 pr-3 font-medium" title={METRIC_TOOLTIPS[m]}>{m}</th>
                  ))}
                  <th className="pb-1 font-medium">Rank%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {pinnedRows.map((row, i) => (
                  <tr key={i}>
                    <td className="py-1.5 pr-3 font-mono text-gray-700 dark:text-gray-300 max-w-[200px] truncate">
                      {modelId(row, resultColumns ?? [])}
                    </td>
                    {METRIC_COLS.filter((m) => resultColumns?.includes(m)).map((m) => {
                      const val = typeof row[m] === 'number' ? row[m] : null
                      const bestVal = typeof best?.[m] === 'number' ? best[m] : null
                      // Positive delta is good for R2/RPD/Explained_Var, bad for RMSE/MSE/MAE
                      const goodHigh = ['R2', 'RPD', 'Explained_Var'].includes(m)
                      const delta = val != null && bestVal != null ? val - bestVal : null
                      const deltaGood = delta != null ? (goodHigh ? delta >= 0 : delta <= 0) : null
                      return (
                        <td key={m} className="py-1.5 pr-3 tabular-nums text-gray-700 dark:text-gray-300">
                          {val != null ? val.toFixed(4) : '—'}
                          {delta != null && Math.abs(delta) > 0.00001 && (
                            <span className={`ml-1 text-[10px] font-medium ${deltaGood ? 'text-emerald-600' : 'text-red-500'}`}>
                              {delta > 0 ? '+' : ''}{delta.toFixed(4)}
                            </span>
                          )}
                        </td>
                      )
                    })}
                    <td className="py-1.5 tabular-nums font-medium text-indigo-600">{row.Rank_Pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Tab bar ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-1 p-1 bg-gray-100 dark:bg-gray-800 rounded-lg w-fit">
          {[
            { id: 'table',   Icon: TableCellsIcon, label: 'Table' },
            { id: 'charts',  Icon: ChartBarIcon,   label: 'Charts' },
            { id: 'stats',   Icon: ScaleIcon,      label: 'Statistics' },
            ...(completedHistory.length >= 2
              ? [{ id: 'history', Icon: ArrowPathIcon, label: 'Run History' }]
              : []),
          ].map(({ id, Icon, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={tab === id ? 'tab-btn-active flex items-center gap-1.5' : 'tab-btn-inactive flex items-center gap-1.5'}
            >
              <Icon className="w-4 h-4" />{label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button className="btn-secondary text-xs" onClick={handleExport}>
            <ArrowDownTrayIcon className="w-3.5 h-3.5" /> CSV
          </button>
          <button className="btn-secondary text-xs" onClick={handleExportExcel}>
            <ArrowDownTrayIcon className="w-3.5 h-3.5" /> Excel
          </button>
          <button className="btn-secondary text-xs" onClick={handleExportJSON}>
            <ArrowDownTrayIcon className="w-3.5 h-3.5" /> JSON
          </button>

        </div>
      </div>

      {/* ── Table tab ── */}
      {tab === 'table' && (
        <div className="card overflow-hidden">
          {/* Filter / controls row */}
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              {/* Text search */}
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                <input
                  className="input text-xs w-56 pl-7"
                  placeholder="Filter results…"
                  value={filterText}
                  onChange={(e) => { setFilterText(e.target.value); setPage(0) }}
                />
                {filterText && (
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500"
                    onClick={() => setFilterText('')}
                  >
                    <XMarkIcon className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <span className="text-xs text-gray-400">{rowsWithRank.length} rows</span>

              {/* Threshold toggles button */}
              <button
                type="button"
                onClick={() => setShowFilters((p) => !p)}
                className={`flex items-center gap-1 text-xs border rounded px-2 py-1 transition-colors ${showFilters ? 'border-indigo-400 text-indigo-600 bg-indigo-50' : 'border-gray-300 text-gray-500 hover:border-gray-400'}`}
              >
                <AdjustmentsHorizontalIcon className="w-3.5 h-3.5" /> Thresholds
              </button>

              {/* Column picker button */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowColPicker((p) => !p)}
                  className={`flex items-center gap-1 text-xs border rounded px-2 py-1 transition-colors ${hiddenCols.size > 0 ? 'border-indigo-400 text-indigo-600 bg-indigo-50' : 'border-gray-300 text-gray-500 hover:border-gray-400'}`}
                >
                  {hiddenCols.size > 0 ? <EyeSlashIcon className="w-3.5 h-3.5" /> : <EyeIcon className="w-3.5 h-3.5" />}
                  Columns{hiddenCols.size > 0 ? ` (${hiddenCols.size} hidden)` : ''}
                </button>
                {showColPicker && (
                  <div className="absolute z-50 top-full mt-1 left-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 min-w-[180px]">
                    <p className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Show / hide</p>
                    <div className="space-y-1.5">
                      {(resultColumns ?? []).map((col) => (
                        <label key={col} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={!hiddenCols.has(col)}
                            onChange={() => setHiddenCols((prev) => {
                              const next = new Set(prev)
                              next.has(col) ? next.delete(col) : next.add(col)
                              return next
                            })}
                            className="accent-indigo-600 w-3.5 h-3.5"
                          />
                          <span className="text-xs text-gray-700 dark:text-gray-300">{col}</span>
                        </label>
                      ))}
                    </div>
                    <button type="button" className="mt-2 text-xs text-indigo-500 hover:underline" onClick={() => setHiddenCols(new Set())}>
                      Show all
                    </button>
                  </div>
                )}
              </div>

              {/* Active filter count badge */}
              {Object.values(thresholds).some((t) => t?.min || t?.max) && (
                <button
                  type="button"
                  className="text-xs text-amber-600 hover:text-red-500 border border-amber-300 rounded px-2 py-1"
                  onClick={() => setThresholds({})}
                >
                  Clear thresholds
                </button>
              )}
            </div>

            {/* Threshold sliders row */}
            {showFilters && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 pt-1">
                {METRIC_COLS.filter((m) => resultColumns?.includes(m)).map((m) => {
                  const vals = (results ?? []).map((r) => r[m]).filter((v) => typeof v === 'number')
                  const domain_min = vals.length ? Math.min(...vals) : 0
                  const domain_max = vals.length ? Math.max(...vals) : 1
                  return (
                    <div key={m} className="space-y-1">
                      <p className="text-xs font-semibold text-gray-500">{m}</p>
                      <div className="flex gap-1">
                        <input
                          type="number"
                          className="input text-xs w-full p-1"
                          placeholder={`≥${domain_min.toFixed(2)}`}
                          step="0.01"
                          value={thresholds[m]?.min ?? ''}
                          onChange={(e) => {
                            setThresholds((p) => ({ ...p, [m]: { ...p[m], min: e.target.value } }))
                            setPage(0)
                          }}
                        />
                        <input
                          type="number"
                          className="input text-xs w-full p-1"
                          placeholder={`≤${domain_max.toFixed(2)}`}
                          step="0.01"
                          value={thresholds[m]?.max ?? ''}
                          onChange={(e) => {
                            setThresholds((p) => ({ ...p, [m]: { ...p[m], max: e.target.value } }))
                            setPage(0)
                          }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-xs">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  {/* Pin column */}
                  <th className="px-2 py-2.5 w-6" />
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase">#</th>
                  {/* Rank percentile */}
                  <th
                    onClick={() => toggleSort('Rank_Pct')}
                    className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-300"
                  >
                    <span className="flex items-center gap-1">
                      Rank%
                      {sortCol === 'Rank_Pct' && <ArrowsUpDownIcon className={`w-3 h-3 ${sortDir === 'asc' ? 'rotate-180' : ''}`} />}
                    </span>
                  </th>
                  {visibleCols.map((col) => (
                    <th
                      key={col}
                      onClick={() => toggleSort(col)}
                      title={METRIC_TOOLTIPS[col]}
                      className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-300"
                    >
                      <span className="flex items-center gap-1">
                        {col}
                        {sortCol === col && <ArrowsUpDownIcon className={`w-3 h-3 ${sortDir === 'asc' ? 'rotate-180' : ''}`} />}
                      </span>
                    </th>
                  ))}
                  {/* Actions column */}
                  <th className="px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {pageRows.length === 0 && (
                  <tr>
                    <td colSpan={visibleCols.length + 4} className="py-16 text-center">
                      <p className="text-sm font-semibold text-gray-500 dark:text-gray-400">No models match your current filters</p>
                      <button
                        type="button"
                        className="mt-2 text-xs text-indigo-500 hover:underline"
                        onClick={() => { setFilterText(''); setThresholds({}); setPage(0) }}
                      >
                        Clear all filters
                      </button>
                    </td>
                  </tr>
                )}
                {pageRows.map((row, i) => {
                  const absIdx = page * PAGE_SIZE + i
                  const id = modelId(row, resultColumns ?? [])
                  const isPinned = pinnedKeys.has(id)
                  const q = r2QualityLabel(row.R2)
                  return (
                    <tr
                      key={absIdx}
                      className={[
                        absIdx === 0 ? 'bg-indigo-50/40 dark:bg-indigo-900/10' : 'hover:bg-gray-50 dark:hover:bg-gray-800/40',
                        isPinned ? 'ring-1 ring-inset ring-indigo-300 dark:ring-indigo-700' : '',
                      ].join(' ')}
                    >
                      {/* Pin toggle */}
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          onClick={() => togglePin(row)}
                          className={`${isPinned ? 'text-indigo-600' : 'text-gray-300 hover:text-gray-500'}`}
                          aria-label={isPinned ? 'Unpin model from comparison' : 'Pin model for comparison'}
                          title={isPinned ? 'Unpin' : 'Pin for comparison'}
                        >
                          {isPinned ? <BookmarkSlashIcon className="w-3.5 h-3.5" /> : <BookmarkIcon className="w-3.5 h-3.5" />}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-gray-400">{absIdx + 1}</td>
                      {/* Rank% */}
                      <td className="px-3 py-2 tabular-nums font-medium text-indigo-500 dark:text-indigo-400">
                        {row.Rank_Pct}%
                      </td>
                      {visibleCols.map((col, ci) => (
                        <td key={col} className="px-3 py-2 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                          {METRIC_COLS.includes(col) && typeof row[col] === 'number' ? (
                            <span className="flex items-center gap-1.5">
                              <MetricCell col={col} value={row[col]} all={rows} />
                              {/* Quality badge only on R2 column */}
                              {col === 'R2' && q && (
                                <span className={`text-xs px-1.5 py-0.5 rounded-full font-semibold ${q.cls}`}>
                                  {q.label}
                                </span>
                              )}
                            </span>
                          ) : (
                            String(row[col] ?? '')
                          )}
                        </td>
                      ))}
                      {/* Actions */}
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setDetailRow(row)}
                            className="text-gray-400 hover:text-indigo-600"
                            aria-label="View model details"
                            title="View detail"
                          >
                            <MagnifyingGlassIcon className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => { navigator.clipboard.writeText(id); toast.success('Copied') }}
                            className="text-gray-400 hover:text-gray-600"
                            aria-label="Copy model identifier"
                            title="Copy identifier"
                          >
                            <ClipboardDocumentIcon className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => useThisModel(row)}
                            className="text-gray-400 hover:text-indigo-600"
                            aria-label="Use this model in Step 3"
                            title="Use this model in Step 3"
                          >
                            <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-4 py-2.5 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between text-xs text-gray-500">
              <span>
                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, rowsWithRank.length)} of {rowsWithRank.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                  className="px-3 py-1 rounded border border-gray-200 dark:border-gray-700 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  ← Prev
                </button>
                <span>{page + 1} / {totalPages}</span>
                <button
                  disabled={page === totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                  className="px-3 py-1 rounded border border-gray-200 dark:border-gray-700 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Charts tab ── */}
      {tab === 'charts' && <ResultsCharts rows={rows} columns={resultColumns} />}

      {/* ── Statistics tab ── */}
      {tab === 'stats' && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">Descriptive statistics</p>
            <p className="text-xs text-gray-400 mt-0.5">Summary across all {results?.length} models</p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-xs">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  {['Metric', 'Count', 'Mean', 'Std', 'Min', 'P25', 'Median', 'P75', 'Max'].map((h) => (
                    <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {statsTable.map((s) => (
                  <tr key={s.metric} className="hover:bg-gray-50 dark:hover:bg-gray-800/40">
                    <td className="px-3 py-2 font-semibold text-indigo-600 dark:text-indigo-400">{s.metric}</td>
                    {['count', 'mean', 'std', 'min', 'p25', 'median', 'p75', 'max'].map((k) => (
                      <td key={k} className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">{s[k]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Run history tab ── */}
      {tab === 'history' && completedHistory.length >= 2 && (
        <div className="card p-4 space-y-4">
          <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">Best R² per completed run</p>
          <div className="space-y-2">
            {completedHistory.map((entry, i) => {
              const q = r2QualityLabel(entry.best_r2)
              return (
                <div key={entry.job_id} className="flex items-center gap-3 text-xs">
                  <span className="text-gray-400 w-5 shrink-0 text-right">{i + 1}</span>
                  {/* Bar */}
                  <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-4 relative overflow-hidden">
                    <div
                      className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                      style={{ width: `${Math.max(0, Math.min(100, (entry.best_r2 ?? 0) * 100))}%` }}
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-white font-bold text-xs tabular-nums">
                      {entry.best_r2?.toFixed(4)}
                    </span>
                  </div>
                  <span className="font-mono text-gray-600 dark:text-gray-300 shrink-0 w-20 truncate">
                    {entry.strategy}
                  </span>
                  {q && (
                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-semibold shrink-0 ${q.cls}`}>
                      {q.label}
                    </span>
                  )}
                  <span className="text-gray-400 shrink-0">
                    {new Date(entry.submitted_at).toLocaleDateString()}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Row detail drawer ── */}
      {detailRow && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/40" onClick={() => setDetailRow(null)} />
          <div className="relative bg-white dark:bg-gray-900 rounded-t-2xl sm:rounded-2xl shadow-2xl max-w-lg w-full mx-4 p-6 space-y-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-indigo-500 uppercase tracking-wide mb-0.5">Model detail</p>
                <p className="text-sm font-bold text-gray-900 dark:text-white break-all">
                  {modelId(detailRow, resultColumns ?? [])}
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => useThisModel(detailRow)}
                  className="flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-700 border border-indigo-300 rounded-lg px-2.5 py-1.5"
                >
                  <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" /> Use
                </button>
                <button onClick={() => setDetailRow(null)} className="text-gray-400 hover:text-gray-600">
                  <XMarkIcon className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* All metrics */}
            <div className="grid grid-cols-2 gap-3">
              {(resultColumns ?? []).map((col) => {
                const val = detailRow[col]
                const q   = col === 'R2' ? r2QualityLabel(val) : null
                return (
                  <div key={col} className="rounded-lg border border-gray-100 dark:border-gray-700 p-3">
                    <p className="text-xs text-gray-400 font-medium mb-0.5">{col}</p>
                    <p className="text-sm font-bold text-gray-800 dark:text-gray-100 break-all">
                      {typeof val === 'number' ? val.toFixed(6) : (val ?? '—')}
                    </p>
                    {q && (
                      <span className={`text-xs px-1.5 py-0.5 rounded-full font-semibold mt-1 inline-block ${q.cls}`}>
                        {q.label}
                      </span>
                    )}
                  </div>
                )
              })}
              {/* Rank */}
              <div className="rounded-lg border border-indigo-100 dark:border-indigo-800 p-3">
                <p className="text-xs text-gray-400 font-medium mb-0.5">Rank%</p>
                <p className="text-sm font-bold text-indigo-600 dark:text-indigo-400">{detailRow.Rank_Pct ?? '—'}%</p>
              </div>
            </div>

            <button
              type="button"
              className="w-full flex items-center justify-center gap-2 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 dark:border-gray-700 rounded-lg py-2"
              onClick={() => {
                navigator.clipboard.writeText(JSON.stringify(detailRow, null, 2))
                toast.success('Copied JSON')
              }}
            >
              <ClipboardDocumentIcon className="w-3.5 h-3.5" /> Copy as JSON
            </button>
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="flex justify-between">
        <button className="btn-secondary" onClick={() => setStep(3)}>
          <ArrowLeftIcon className="w-4 h-4" /> Back
        </button>
      </div>
    </div>
  )
}

// ── Colour-coded metric cell ───────────────────────────────────────────────────
function MetricCell({ col, value, all }) {
  const vals = all.map((r) => r[col]).filter((v) => typeof v === 'number')
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const pct = max === min ? 0.5 : (value - min) / (max - min)
  const goodHigh = ['R2', 'RPD', 'Explained_Var'].includes(col)
  const intensity = goodHigh ? pct : 1 - pct
  const bg = intensity > 0.66
    ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-200'
    : intensity > 0.33
    ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200'
    : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
  return <span className={`inline-block rounded px-1.5 py-0.5 font-mono ${bg}`}>{value.toFixed(4)}</span>
}

// ── Download helper ────────────────────────────────────────────────────────────
function downloadBlob(content, type, filename) {
  const blob = new Blob([content], { type })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

