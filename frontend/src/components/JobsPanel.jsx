import { useState, useMemo } from 'react'
import {
  TrashIcon,
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  ChartBarIcon,
  DocumentTextIcon,
  MagnifyingGlassIcon,
  FunnelIcon,
  ArrowDownTrayIcon,
  StarIcon,
  ClipboardDocumentIcon,
  ArrowsRightLeftIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { StarIcon as StarSolidIcon } from '@heroicons/react/24/solid'
import toast from 'react-hot-toast'
import { useAppStore } from '../store/appStore'

// ── Constants ─────────────────────────────────────────────────────────────────
const PAGE_SIZE = 20

const STRATEGY_META = {
  aai:            { label: 'AAI Encoding',     colour: 'bg-indigo-100 text-indigo-700' },
  descriptor:     { label: 'Descriptor',       colour: 'bg-violet-100 text-violet-700' },
  aai_descriptor: { label: 'AAI + Descriptor', colour: 'bg-emerald-100 text-emerald-700' },
}

const STATUS_META = {
  pending:   { label: 'In progress', colour: 'bg-yellow-100 text-yellow-700' },
  running:   { label: 'Running',     colour: 'bg-blue-100 text-blue-700' },
  completed: { label: 'Completed',   colour: 'bg-green-100 text-green-700' },
  failed:    { label: 'Failed',      colour: 'bg-red-100 text-red-700' },
  cancelled: { label: 'Cancelled',   colour: 'bg-gray-100 text-gray-500' },
}

const SORT_OPTIONS = [
  { value: 'date-desc', label: 'Newest first' },
  { value: 'date-asc',  label: 'Oldest first' },
  { value: 'r2-desc',   label: 'Best R² first' },
  { value: 'r2-asc',    label: 'Worst R² first' },
  { value: 'algo-asc',  label: 'Algorithm A→Z' },
]

// ── Sparkline SVG ─────────────────────────────────────────────────────────────
function Sparkline({ values, width = 140, height = 36 }) {
  if (!values || values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width
      const y = height - ((v - min) / range) * (height - 4) - 2
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const lastX = width
  const lastY = height - ((values[values.length - 1] - min) / range) * (height - 4) - 2
  return (
    <svg width={width} height={height} className="overflow-visible shrink-0">
      <polyline fill="none" stroke="#6366f1" strokeWidth="1.5" strokeLinejoin="round" points={pts} />
      <circle cx={lastX.toFixed(1)} cy={lastY.toFixed(1)} r="2.5" fill="#6366f1" />
    </svg>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function relativeTime(isoString) {
  const diff = Math.floor((Date.now() - new Date(isoString)) / 1000)
  if (diff < 60)   return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return new Date(isoString).toLocaleDateString()
}

// Format duration in ms to human-readable string
function formatDuration(ms) {
  if (ms == null) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

// Copy text to clipboard with toast feedback
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(
    () => toast.success('Copied to clipboard'),
    () => toast.error('Copy failed'),
  )
}

// ── Export helpers ─────────────────────────────────────────────────────────────
function exportJSON(jobs) {
  const blob = new Blob([JSON.stringify(jobs, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `pysar_jobs_${new Date().toISOString().slice(0, 10)}.json`
  a.click(); URL.revokeObjectURL(url)
}

function exportCSV(jobs) {
  const cols = ['job_id', 'submitted_at', 'status', 'strategy', 'algorithm', 'best_r2', 'duration_ms', 'dataset_filename']
  const header = cols.join(',')
  const rows = jobs.map((j) => cols.map((c) => JSON.stringify(j[c] ?? '')).join(','))
  const blob = new Blob([header + '\n' + rows.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `pysar_jobs_${new Date().toISOString().slice(0, 10)}.csv`
  a.click(); URL.revokeObjectURL(url)
}

// ── Main component ────────────────────────────────────────────────────────────
export default function JobsPanel() {
  const {
    jobHistory, removeJobFromHistory, clearJobHistory, toggleJobPin,
    rerunJob, dataset, job, results, setShowJobs, setStep,
  } = useAppStore()

  // ── Local UI state ──
  const [expanded, setExpanded]         = useState(null)
  const [search, setSearch]             = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [strategyFilter, setStrategyFilter] = useState('all')
  const [sortBy, setSortBy]             = useState('date-desc')
  const [showFilters, setShowFilters]   = useState(false)
  const [page, setPage]                 = useState(0)
  const [selected, setSelected]         = useState(new Set())   // bulk-select ids
  const [comparing, setComparing]       = useState([])          // max 2 job ids for compare
  const [confirmBulkDel, setConfirmBulkDel] = useState(false)  // inline confirm for bulk delete
  const [confirmClear, setConfirmClear]     = useState(false)  // inline confirm for clear all

  function toggleExpand(id) { setExpanded((prev) => (prev === id ? null : id)) }

  // Navigate to results if still cached
  function goToResults(entry) {
    if (results && job?.job_id === entry.job_id) { setShowJobs(false); setStep(4) }
    else toast('Results are not cached — rerun the job to see results.')
  }

  // ── Bulk-select helpers ──
  function toggleSelect(id) {
    setSelected((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  }
  function selectAll(ids) { setSelected(new Set(ids)) }
  function clearSelection() { setSelected(new Set()) }

  function bulkDelete() {
    selected.forEach((id) => removeJobFromHistory(id))
    clearSelection()
    setConfirmBulkDel(false)
  }

  function bulkRerun() {
    if (!dataset) { toast.error('Upload a dataset first'); return }
    const entries = jobHistory.filter((e) => selected.has(e.id))
    entries.forEach((e) => rerunJob(e))
    clearSelection()
    toast.success(`Rerunning ${entries.length} job(s)`)
  }

  // ── Compare helpers ──
  function toggleCompare(id) {
    setComparing((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= 2) return [prev[1], id] // replace oldest
      return [...prev, id]
    })
  }

  // ── Filtering, sorting, pagination (memoised) ──
  const filtered = useMemo(() => {
    let list = [...jobHistory]
    // Text search across key fields
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter((e) =>
        (e.algorithm ?? '').toLowerCase().includes(q) ||
        (e.strategy ?? '').toLowerCase().includes(q) ||
        (e.dataset_filename ?? '').toLowerCase().includes(q) ||
        (e.job_id ?? '').toLowerCase().includes(q)
      )
    }
    // Status filter
    if (statusFilter !== 'all') list = list.filter((e) => e.status === statusFilter)
    // Strategy filter
    if (strategyFilter !== 'all') list = list.filter((e) => e.strategy === strategyFilter)
    // Sort by selected criterion
    list.sort((a, b) => {
      switch (sortBy) {
        case 'date-asc':  return new Date(a.submitted_at) - new Date(b.submitted_at)
        case 'r2-desc':   return (b.best_r2 ?? -Infinity) - (a.best_r2 ?? -Infinity)
        case 'r2-asc':    return (a.best_r2 ?? -Infinity) - (b.best_r2 ?? -Infinity)
        case 'algo-asc':  return (a.algorithm ?? '').localeCompare(b.algorithm ?? '')
        default:          return new Date(b.submitted_at) - new Date(a.submitted_at)
      }
    })
    // Pinned jobs always float to top
    list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
    return list
  }, [jobHistory, search, statusFilter, strategyFilter, sortBy])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage   = Math.min(page, totalPages - 1)
  const pageJobs   = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)
  const pageIds    = pageJobs.map((e) => e.id)

  // ── Status summary counts (across full history) ──
  const statusCounts = useMemo(() => {
    const counts = { completed: 0, failed: 0, pending: 0, running: 0, cancelled: 0 }
    jobHistory.forEach((e) => { if (counts[e.status] !== undefined) counts[e.status]++ })
    return counts
  }, [jobHistory])

  // R² trend sparkline data (oldest → newest, last 20)
  const r2Trend = useMemo(
    () => jobHistory.filter((e) => e.status === 'completed' && e.best_r2 != null).slice(0, 20).reverse().map((e) => e.best_r2),
    [jobHistory],
  )

  // Resolve compare entries
  const compareEntries = comparing.map((id) => jobHistory.find((e) => e.id === id)).filter(Boolean)

  // ── Empty state ──
  if (jobHistory.length === 0) {
    return (
      <div className="max-w-3xl mx-auto flex flex-col items-center justify-center py-24 text-center gap-4">
        <span className="flex items-center justify-center w-16 h-16 rounded-full bg-gray-100 dark:bg-gray-800">
          <ClockIcon className="w-8 h-8 text-gray-400" />
        </span>
        <div>
          <p className="font-semibold text-gray-700 dark:text-gray-200 text-base">No encoding jobs yet</p>
          <p className="text-sm text-gray-400 mt-1">Jobs appear here after you run an encoding from Step 3.<br />Results are stored locally in your browser.</p>
        </div>
        <button
          onClick={() => { setShowJobs(false); setStep(3) }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors"
        >
          Go to Encode &amp; Train
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto space-y-3">

      {/* ── 10. Status summary bar (clickable counts) ── */}
      <div className="flex flex-wrap items-center gap-2">
        {Object.entries(statusCounts).filter(([, c]) => c > 0).map(([st, c]) => {
          const meta = STATUS_META[st] ?? STATUS_META.pending
          const active = statusFilter === st
          return (
            <button
              key={st}
              type="button"
              onClick={() => { setStatusFilter(active ? 'all' : st); setPage(0) }}
              className={`text-xs font-medium px-2.5 py-1 rounded-full transition-colors ${active ? meta.colour + ' ring-2 ring-offset-1 ring-indigo-400' : meta.colour + ' opacity-70 hover:opacity-100'}`}
            >
              {c} {meta.label}
            </button>
          )
        })}
        {statusFilter !== 'all' && (
          <button type="button" onClick={() => { setStatusFilter('all'); setPage(0) }} className="text-xs text-gray-400 hover:text-gray-600">
            Clear filter
          </button>
        )}
        <span className="text-xs text-gray-400 ml-auto">{jobHistory.length} total</span>
      </div>

      {/* ── 4. Search bar + 1. Filter toggle + 2. Export + clear-all toolbar ── */}
      <div className="flex items-center gap-2">
        {/* Search input */}
        <div className="relative flex-1">
          <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Search algorithm, strategy, dataset…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0) }}
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-gray-200 bg-white focus:border-indigo-400 focus:ring-1 focus:ring-indigo-200 outline-none"
          />
        </div>
        {/* Filter toggle */}
        <button
          type="button" title="Filters & sort"
          onClick={() => setShowFilters((v) => !v)}
          className={`p-1.5 rounded-lg border text-gray-500 hover:text-indigo-600 transition-colors ${showFilters ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200 bg-white'}`}
        >
          <FunnelIcon className="w-4 h-4" />
        </button>
        {/* Export dropdown */}
        <div className="relative group">
          <button type="button" title="Export" className="p-1.5 rounded-lg border border-gray-200 bg-white text-gray-500 hover:text-indigo-600 transition-colors">
            <ArrowDownTrayIcon className="w-4 h-4" />
          </button>
          <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-20 hidden group-hover:block min-w-[120px]">
            <button type="button" onClick={() => exportJSON(jobHistory)} className="block w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50">Export JSON</button>
            <button type="button" onClick={() => exportCSV(jobHistory)}  className="block w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50">Export CSV</button>
          </div>
        </div>
        {/* Remove all — with inline confirmation */}
        {confirmClear ? (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-red-600 font-medium whitespace-nowrap">Remove all?</span>
            <button type="button" onClick={() => { clearJobHistory(); setConfirmClear(false) }} className="text-xs font-semibold text-red-600 underline hover:text-red-700">Yes</button>
            <button type="button" onClick={() => setConfirmClear(false)} className="text-xs text-gray-500 underline hover:text-gray-700">No</button>
          </div>
        ) : (
          <button
            type="button" title="Remove all jobs"
            onClick={() => setConfirmClear(true)}
            className="p-1.5 rounded-lg border border-gray-200 bg-white text-gray-400 hover:text-red-500 transition-colors"
          >
            <TrashIcon className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* ── 1. Filter & sort controls (collapsible) ── */}
      {showFilters && (
        <div className="card px-4 py-3 flex flex-wrap items-center gap-3 text-xs">
          <div>
            <label className="text-gray-400 font-medium mr-1">Strategy:</label>
            <select
              value={strategyFilter}
              onChange={(e) => { setStrategyFilter(e.target.value); setPage(0) }}
              className="rounded border border-gray-200 px-2 py-1 text-xs bg-white"
            >
              <option value="all">All</option>
              {Object.entries(STRATEGY_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-gray-400 font-medium mr-1">Sort:</label>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="rounded border border-gray-200 px-2 py-1 text-xs bg-white"
            >
              {SORT_OPTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
        </div>
      )}

        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div className="card px-4 py-2.5 flex items-center gap-3 bg-indigo-50 border-indigo-200">
            <span className="text-xs font-semibold text-indigo-700">{selected.size} selected</span>
            {confirmBulkDel ? (
              <span className="flex items-center gap-1.5 text-xs">
                <span className="text-red-700 font-medium">Remove {selected.size} job(s)?</span>
                <button type="button" onClick={bulkDelete} className="font-semibold text-red-600 hover:text-red-700 underline">Yes</button>
                <button type="button" onClick={() => setConfirmBulkDel(false)} className="text-gray-500 hover:text-gray-700 underline">Cancel</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmBulkDel(true)} className="text-xs font-medium text-red-600 hover:text-red-700 flex items-center gap-1">
                <TrashIcon className="w-3.5 h-3.5" /> Delete
              </button>
            )}
            <button type="button" onClick={bulkRerun} disabled={!dataset} className="text-xs font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-40 flex items-center gap-1">
              <ArrowPathIcon className="w-3.5 h-3.5" /> Rerun
            </button>
          <button type="button" onClick={clearSelection} className="text-xs text-gray-400 hover:text-gray-600 ml-auto">
            Clear selection
          </button>
        </div>
      )}

      {/* ── 3. Compare panel (side-by-side) ── */}
      {compareEntries.length === 2 && (
        <ComparePanel entries={compareEntries} onClose={() => setComparing([])} />
      )}
      {comparing.length > 0 && comparing.length < 2 && (
        <div className="card px-4 py-2 bg-amber-50 border-amber-200 text-xs text-amber-700 flex items-center gap-2">
          <ArrowsRightLeftIcon className="w-4 h-4" />
          Select one more job to compare
          <button type="button" onClick={() => setComparing([])} className="ml-auto text-amber-500 hover:text-amber-700"><XMarkIcon className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* ── R² trend sparkline ── */}
      {r2Trend.length >= 2 && (
        <div className="card px-4 py-3 flex items-center gap-4">
          <div>
            <p className="text-xs font-semibold text-gray-500">R² trend</p>
            <p className="text-xs text-gray-400">{r2Trend.length} completed jobs</p>
          </div>
          <Sparkline values={r2Trend} />
          <div className="ml-auto text-right">
            <p className="text-xs text-gray-400">Best R²</p>
            <p className="text-sm font-bold text-indigo-600">{Math.max(...r2Trend).toFixed(4)}</p>
          </div>
        </div>
      )}

      {/* ── Select-all toggle for current page ── */}
      <div className="flex items-center gap-2 px-1">
        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            className="rounded border-gray-300 text-indigo-600"
            checked={pageIds.length > 0 && pageIds.every((id) => selected.has(id))}
            onChange={(e) => e.target.checked ? selectAll([...selected, ...pageIds]) : setSelected((prev) => { const next = new Set(prev); pageIds.forEach((id) => next.delete(id)); return next })}
          />
          Select page
        </label>
        <span className="text-xs text-gray-300">
          {filtered.length} job{filtered.length !== 1 ? 's' : ''} {filtered.length !== jobHistory.length ? `(of ${jobHistory.length})` : ''}
        </span>
      </div>

      {/* ── Job cards ── */}
      {pageJobs.map((entry) => {
        const strat   = STRATEGY_META[entry.strategy] ?? STRATEGY_META.aai
        const status  = STATUS_META[entry.status] ?? STATUS_META.pending
        const isOpen  = expanded === entry.id
        const isPinned = !!entry.pinned
        const isSelected = selected.has(entry.id)
        const isComparing = comparing.includes(entry.id)
        const duration = formatDuration(entry.duration_ms)

        return (
          <div key={entry.id} className={`card overflow-hidden transition-shadow ${isSelected ? 'ring-2 ring-indigo-300' : ''} ${isComparing ? 'ring-2 ring-amber-300' : ''}`}>
            {/* ── Summary row ── */}
            <div className="flex items-center gap-2 px-4 py-3">
              {/* 6. Bulk checkbox */}
              <input
                type="checkbox" className="rounded border-gray-300 text-indigo-600 shrink-0"
                checked={isSelected}
                onChange={() => toggleSelect(entry.id)}
              />

              {/* Expand toggle */}
              <button type="button" onClick={() => toggleExpand(entry.id)} className="text-gray-400 hover:text-gray-600 shrink-0">
                {isOpen ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
              </button>

              {/* 7. Pin star */}
              <button type="button" onClick={() => toggleJobPin(entry.id)} className="shrink-0" title={isPinned ? 'Unpin' : 'Pin'}>
                {isPinned
                  ? <StarSolidIcon className="w-4 h-4 text-amber-400" />
                  : <StarIcon className="w-4 h-4 text-gray-300 hover:text-amber-400" />}
              </button>

              {/* Strategy + status badges */}
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full shrink-0 ${strat.colour}`}>{strat.label}</span>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${status.colour}`}>{status.label}</span>

              {/* Algorithm */}
              <span className="text-xs font-mono text-gray-600 shrink-0">{entry.algorithm}</span>

              {/* R² badge */}
              {entry.status === 'completed' && entry.best_r2 != null && (
                <span className="text-xs font-mono bg-green-50 text-green-700 border border-green-200 px-1.5 py-0.5 rounded shrink-0">
                  R²={Number(entry.best_r2).toFixed(3)}
                </span>
              )}

              {/* 5. Duration */}
              {duration && (
                <span className="text-xs text-gray-400 font-mono shrink-0" title={`${entry.duration_ms}ms`}>
                  ⏱ {duration}
                </span>
              )}

              {/* Dataset filename */}
              <span className="text-xs text-gray-400 truncate flex-1 min-w-0" title={entry.dataset_filename}>
                {entry.dataset_filename ?? '—'}
              </span>

              {/* Timestamp */}
              <span className="text-xs text-gray-400 shrink-0 whitespace-nowrap">{relativeTime(entry.submitted_at)}</span>

              {/* 3. Compare toggle */}
              <button
                type="button"
                onClick={() => toggleCompare(entry.id)}
                title={isComparing ? 'Remove from compare' : 'Add to compare'}
                className={`shrink-0 p-1 rounded transition-colors ${isComparing ? 'text-amber-600 bg-amber-50' : 'text-gray-300 hover:text-amber-500'}`}
              >
                <ArrowsRightLeftIcon className="w-3.5 h-3.5" />
              </button>

              {/* Go to results */}
              {entry.status === 'completed' && (
                <button type="button" onClick={() => goToResults(entry)} className="flex items-center gap-1 text-xs text-green-600 hover:text-green-700 font-medium shrink-0">
                  <ChartBarIcon className="w-3.5 h-3.5" /> Results
                </button>
              )}

              {/* Logs for failed */}
              {entry.status === 'failed' && (entry.error || entry.log?.length > 0) && (
                <button type="button" onClick={() => toggleExpand(entry.id)} className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 font-medium shrink-0">
                  <DocumentTextIcon className="w-3.5 h-3.5" /> Logs
                </button>
              )}

              {/* 8. Copy config to clipboard */}
              <button
                type="button"
                onClick={() => copyToClipboard(JSON.stringify(entry.payload ?? {}, null, 2))}
                title="Copy config JSON"
                className="text-gray-300 hover:text-indigo-500 shrink-0"
              >
                <ClipboardDocumentIcon className="w-3.5 h-3.5" />
              </button>

              {/* Rerun */}
              <button
                type="button" onClick={() => rerunJob(entry)} disabled={!dataset}
                title={dataset ? 'Rerun with these parameters' : 'Upload a dataset first'}
                className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              >
                <ArrowPathIcon className="w-3.5 h-3.5" /> Rerun
              </button>

              {/* Delete */}
              <button type="button" onClick={() => removeJobFromHistory(entry.id)} className="text-gray-300 hover:text-red-500 shrink-0" title="Remove">
                <TrashIcon className="w-4 h-4" />
              </button>
            </div>

            {/* ── Expanded detail ── */}
            {isOpen && (
              <div className="border-t border-gray-100 px-4 py-3 bg-gray-50 space-y-2">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Job parameters</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1.5 text-xs">
                  <Detail label="Job ID"     value={entry.job_id} mono />
                  <Detail label="Submitted"  value={new Date(entry.submitted_at).toLocaleString()} />
                  {entry.completed_at && <Detail label="Completed" value={new Date(entry.completed_at).toLocaleString()} />}
                  {duration && <Detail label="Duration" value={duration} />}
                  <Detail label="Strategy"   value={entry.payload?.strategy} />
                  <Detail label="Algorithm"  value={entry.payload?.algorithm} mono />
                  <Detail label="Test split" value={entry.payload?.test_split} />
                  <Detail label="Desc combo" value={entry.payload?.desc_combo} />
                  <Detail label="Sort by"    value={entry.payload?.sort_by} />
                  <Detail label="n_jobs"     value={entry.payload?.n_jobs} />
                  <Detail label="Max models" value={entry.payload?.max_models ?? 'all'} />
                  <Detail label="Sample mode" value={entry.payload?.sample_mode ? 'Yes' : 'No'} />
                  {entry.payload?.aai_indices?.length > 0 && (
                    <div className="col-span-2 sm:col-span-3">
                      <span className="text-gray-400 font-medium">AAI indices: </span>
                      <span className="font-mono text-gray-600">{entry.payload.aai_indices.join(', ')}</span>
                    </div>
                  )}
                  {entry.payload?.selected_descriptors?.length > 0 && (
                    <div className="col-span-2 sm:col-span-3">
                      <span className="text-gray-400 font-medium">Descriptors: </span>
                      <span className="font-mono text-gray-600">{entry.payload.selected_descriptors.join(', ')}</span>
                    </div>
                  )}
                </div>

                {/* Error + log block for failed jobs */}
                {entry.status === 'failed' && (entry.error || entry.log?.length > 0) && (
                  <div className="mt-3 space-y-2">
                    <p className="text-xs font-semibold text-red-500 uppercase tracking-wide">Failure details</p>
                    {entry.error && (
                      <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded px-3 py-2">{entry.error}</p>
                    )}
                    {entry.log?.length > 0 && (
                      <div className="rounded-lg bg-gray-900 text-green-400 font-mono text-xs p-3 max-h-48 overflow-y-auto space-y-0.5">
                        {entry.log.map((line, i) => <div key={i}>{'> '}{line}</div>)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}

      {/* ── 9. Pagination controls ── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <button
            type="button" disabled={safePage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="text-xs font-medium text-gray-500 hover:text-indigo-600 disabled:opacity-30"
          >
            ← Prev
          </button>
          <span className="text-xs text-gray-400">Page {safePage + 1} of {totalPages}</span>
          <button
            type="button" disabled={safePage >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
            className="text-xs font-medium text-gray-500 hover:text-indigo-600 disabled:opacity-30"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}

// ── 3. Side-by-side compare panel ─────────────────────────────────────────────
function ComparePanel({ entries, onClose }) {
  const [a, b] = entries
  const fields = [
    { label: 'Algorithm',   fn: (e) => e.algorithm },
    { label: 'Strategy',    fn: (e) => e.strategy },
    { label: 'Best R²',     fn: (e) => e.best_r2 != null ? Number(e.best_r2).toFixed(4) : '—' },
    { label: 'Status',      fn: (e) => STATUS_META[e.status]?.label ?? e.status },
    { label: 'Duration',    fn: (e) => formatDuration(e.duration_ms) ?? '—' },
    { label: 'Test split',  fn: (e) => e.payload?.test_split ?? '—' },
    { label: 'Desc combo',  fn: (e) => e.payload?.desc_combo ?? '—' },
    { label: 'Sort by',     fn: (e) => e.payload?.sort_by ?? '—' },
    { label: 'n_jobs',      fn: (e) => e.payload?.n_jobs ?? '—' },
    { label: 'Max models',  fn: (e) => e.payload?.max_models ?? 'all' },
    { label: 'Sample mode', fn: (e) => e.payload?.sample_mode ? 'Yes' : 'No' },
    { label: 'Dataset',     fn: (e) => e.dataset_filename ?? '—' },
    { label: 'Submitted',   fn: (e) => e.submitted_at ? new Date(e.submitted_at).toLocaleString() : '—' },
  ]

  return (
    <div className="card p-4 space-y-3 border-amber-200 bg-amber-50/30">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide flex items-center gap-1.5">
          <ArrowsRightLeftIcon className="w-4 h-4 text-amber-500" /> Compare jobs
        </h3>
        <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600"><XMarkIcon className="w-4 h-4" /></button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="text-left py-1.5 pr-4 text-gray-400 font-medium">Parameter</th>
              <th className="text-left py-1.5 pr-4 text-gray-600 font-semibold">Job A</th>
              <th className="text-left py-1.5 text-gray-600 font-semibold">Job B</th>
            </tr>
          </thead>
          <tbody>
            {fields.map(({ label, fn }) => {
              const va = fn(a), vb = fn(b)
              const diff = va !== vb
              return (
                <tr key={label} className={diff ? 'bg-amber-50' : ''}>
                  <td className="py-1 pr-4 text-gray-400 font-medium whitespace-nowrap">{label}</td>
                  <td className={`py-1 pr-4 font-mono ${diff ? 'text-indigo-700 font-semibold' : 'text-gray-600'}`}>{va}</td>
                  <td className={`py-1 font-mono ${diff ? 'text-indigo-700 font-semibold' : 'text-gray-600'}`}>{vb}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Detail key/value pair ─────────────────────────────────────────────────────
function Detail({ label, value, mono = false }) {
  return (
    <div>
      <span className="text-gray-400 font-medium">{label}: </span>
      <span className={mono ? 'font-mono text-gray-700' : 'text-gray-700'}>{value ?? '—'}</span>
    </div>
  )
}
