import { Fragment, useEffect, useState, useMemo } from 'react'
import { MagnifyingGlassIcon, TagIcon, ChevronDownIcon, ChevronUpIcon, XMarkIcon, CodeBracketIcon, CubeIcon, CheckIcon, PlusIcon } from '@heroicons/react/24/outline'
import { getAaiIndicesFull } from '../utils/api'
import { SkeletonTable } from './Skeleton'
import { useAppStore } from '../store/appStore'

// Colour palette cycled across unique categories
const CATEGORY_COLOURS = [
  'bg-indigo-100 text-indigo-700',
  'bg-green-100 text-green-700',
  'bg-amber-100 text-amber-700',
  'bg-red-100 text-red-700',
  'bg-sky-100 text-sky-700',
  'bg-purple-100 text-purple-700',
  'bg-pink-100 text-pink-700',
  'bg-teal-100 text-teal-700',
  'bg-orange-100 text-orange-700',
  'bg-lime-100 text-lime-700',
]

export default function AaiExplorer() {
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [retryCount, setRetryCount] = useState(0)
  const [search, setSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('All')
  const [expandedCode, setExpandedCode] = useState(null)
  // Pagination state
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(50)

  // Read and update the encoding selection from global store
  const { encoding, setEncoding } = useAppStore()
  const selectedIndices = encoding.aai_indices ?? []

  // Toggle a single index in/out of the selection
  function toggleIndex(code, e) {
    e.stopPropagation()
    const next = selectedIndices.includes(code)
      ? selectedIndices.filter((c) => c !== code)
      : [...selectedIndices, code]
    setEncoding({ aai_indices: next })
  }

  // Add all currently visible (filtered) indices to the selection
  function selectAllVisible() {
    const codes = filtered.map((r) => r.code)
    const merged = Array.from(new Set([...selectedIndices, ...codes]))
    setEncoding({ aai_indices: merged })
  }

  // Clear entire selection (empty = use all)
  function clearSelection() {
    setEncoding({ aai_indices: [] })
  }

  // Fetch full index list on mount; timeout after 5 s if no response
  useEffect(() => {
    setLoading(true)
    setLoadError(null)
    const tid = setTimeout(() => setLoadError('Failed to load — please retry'), 5000)
    getAaiIndicesFull()
      .then(d => { setRecords(d); clearTimeout(tid) })
      .catch(() => { clearTimeout(tid); setLoadError('Failed to load — please retry') })
      .finally(() => setLoading(false))
    return () => clearTimeout(tid)
  }, [retryCount])

  // Unique sorted categories derived from data
  const categories = useMemo(() => {
    const set = new Set(records.map((r) => r.category || 'other'))
    return ['All', ...Array.from(set).sort()]
  }, [records])

  // Stable category → colour map
  const categoryColour = useMemo(() => {
    const map = {}
    categories.filter((c) => c !== 'All').forEach((c, i) => {
      map[c] = CATEGORY_COLOURS[i % CATEGORY_COLOURS.length]
    })
    return map
  }, [categories])

  // Filtered records: search across code, title, and category
  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return records.filter((r) => {
      const matchSearch =
        !q ||
        r.code.toLowerCase().includes(q) ||
        r.title.toLowerCase().includes(q) ||
        (r.category || '').toLowerCase().includes(q)
      const cat = r.category || 'other'
      const matchCategory = selectedCategory === 'All' || cat === selectedCategory
      return matchSearch && matchCategory
    })
  }, [records, search, selectedCategory])

  // Reset to page 0 when filters change
  useEffect(() => { setPage(0) }, [search, selectedCategory, pageSize])

  // Paginated slice of filtered records
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const paginated = filtered.slice(page * pageSize, (page + 1) * pageSize)

  // Toggle row expansion; collapse if already open
  const toggleExpand = (code) =>
    setExpandedCode((prev) => (prev === code ? null : code))

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div>
        <h2 className="text-lg font-bold text-gray-900">AAIndex Explorer</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Browse all {records.length} amino acid indices from the AAIndex1 database. Click a row to view its category, PMID and full reference.
        </p>
      </div>

      {/* Selection banner — shown when indices are actively chosen */}
      {selectedIndices.length > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm">
          <div className="flex items-center gap-2">
            <CheckIcon className="w-4 h-4 text-indigo-600 shrink-0" />
            <span className="font-medium text-indigo-800">
              {selectedIndices.length} {selectedIndices.length === 1 ? 'index' : 'indices'} selected
            </span>
            <span className="text-indigo-500 text-xs">— will be used in Step 3 encoding</span>
          </div>
          <button
            onClick={clearSelection}
            className="text-xs text-indigo-600 hover:text-indigo-800 font-medium underline underline-offset-2 shrink-0"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Search + category filter + select-all-visible */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <MagnifyingGlassIcon className="absolute left-3 top-2.5 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            className="input pl-9 pr-8"
            placeholder="Search by code, description, or category…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {/* Clear button — only visible when there is text */}
          {search && (
            <button
              className="absolute right-2.5 top-2.5 text-gray-400 hover:text-gray-600 transition-colors"
              onClick={() => setSearch('')}
              aria-label="Clear search"
            >
              <XMarkIcon className="w-4 h-4" />
            </button>
          )}
        </div>
        <select
          className="input w-full sm:w-52"
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
        >
          {categories.map((c) => (
            <option key={c} value={c}>
              {c === 'All' ? `All categories (${records.length})` : c}
            </option>
          ))}
        </select>
        {/* Select all visible rows */}
        {!loading && filtered.length > 0 && (
          <button
            onClick={selectAllVisible}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-xs font-medium text-gray-600 hover:border-indigo-400 hover:text-indigo-700 bg-white transition-colors whitespace-nowrap"
            aria-label="Select all visible indices"
          >
            <PlusIcon className="w-3.5 h-3.5" /> Select all visible
          </button>
        )}
      </div>

      {/* Results count */}
      <p className="text-xs text-gray-400">
        Showing {filtered.length} of {records.length} indices
      </p>

      {/* Table */}
      {loading ? (
        <SkeletonTable cols={3} rowCount={12} />
      ) : loadError ? (
        <div className="card p-8 text-center text-gray-500 space-y-3">
          <CodeBracketIcon className="w-8 h-8 mx-auto text-red-400" />
          <p className="text-sm text-red-600">{loadError}</p>
          <button
            type="button"
            onClick={() => setRetryCount((n) => n + 1)}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 transition-colors"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase w-36">Code</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase w-32">Category</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase">Description</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase w-24">Use</th>
                  <th className="px-4 py-2.5 w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {paginated.map((rec) => {
                  const cat = rec.category || 'other'
                  const isExpanded = expandedCode === rec.code
                  const isSelected = selectedIndices.includes(rec.code)
                  return (
                    <Fragment key={rec.code}>
                      {/* Main row — click to toggle detail */}
                      <tr
                        role="button"
                        tabIndex={0}
                        aria-expanded={isExpanded}
                        aria-label={`${rec.code}: ${rec.title || 'AAI index'}. ${isExpanded ? 'Collapse' : 'Expand'} details`}
                        className={`hover:bg-indigo-50/40 transition-colors cursor-pointer ${isSelected ? 'bg-indigo-50/60' : ''}`}
                        onClick={() => toggleExpand(rec.code)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(rec.code) } }}
                      >
                        <td className="px-4 py-2 font-mono text-xs text-indigo-700 font-semibold whitespace-nowrap">
                          {rec.code}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${categoryColour[cat] ?? 'bg-gray-100 text-gray-600'}`}>
                            {cat}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-gray-600 text-xs leading-snug">
                          {rec.title || '—'}
                        </td>
                        {/* Select / deselect button */}
                        <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={(e) => toggleIndex(rec.code, e)}
                            aria-label={isSelected ? `Deselect ${rec.code}` : `Select ${rec.code}`}
                            className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded font-medium transition-colors ${
                              isSelected
                                ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                                : 'border border-gray-200 text-gray-500 hover:border-indigo-400 hover:text-indigo-600 bg-white'
                            }`}
                          >
                            {isSelected
                              ? <><CheckIcon className="w-3 h-3" /> Selected</>
                              : <><PlusIcon className="w-3 h-3" /> Use</>}
                          </button>
                        </td>
                        <td className="px-4 py-2 text-gray-400">
                          {isExpanded
                            ? <ChevronUpIcon className="w-3.5 h-3.5" />
                            : <ChevronDownIcon className="w-3.5 h-3.5" />}
                        </td>
                      </tr>

                      {/* Expanded detail row */}
                      {isExpanded && (
                        <tr className="bg-indigo-50/30">
                          <td colSpan={5} className="px-5 pt-3 pb-4">
                            <div className="space-y-2 text-xs text-gray-700">
                              {rec.pmid && (
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold text-gray-500 w-20 shrink-0">PMID</span>
                                  {/* Opens the PubMed record in a new tab */}
                                  <a
                                    href={`https://pubmed.ncbi.nlm.nih.gov/${rec.pmid}/`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-indigo-600 hover:underline font-mono"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {rec.pmid}
                                  </a>
                                </div>
                              )}
                              {rec.references && (
                                <div className="flex gap-2">
                                  <span className="font-semibold text-gray-500 w-20 shrink-0">Reference</span>
                                  <span className="text-gray-600 leading-relaxed">{rec.references}</span>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <p className="text-center py-8 text-gray-400 text-sm">No indices match your search.</p>
            )}
          </div>

          {/* Pagination controls */}
          {filtered.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 mt-3 text-xs text-gray-500">
              {/* Page size selector */}
              <div className="flex items-center gap-2">
                <span>Rows per page:</span>
                <select
                  className="border border-gray-200 rounded px-2 py-1 text-xs bg-white"
                  value={pageSize}
                  onChange={(e) => setPageSize(e.target.value === 'All' ? Infinity : Number(e.target.value))}
                >
                  {[25, 50, 100, 'All'].map((n) => (
                    <option key={n} value={n === 'All' ? 'All' : n}>{n}</option>
                  ))}
                </select>
              </div>

              {/* Showing X–Y of Z */}
              <span>
                {pageSize === Infinity
                  ? `All ${filtered.length} indices`
                  : `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, filtered.length)} of ${filtered.length}`
                }
              </span>

              {/* Prev / Next */}
              {pageSize !== Infinity && (
                <div className="flex items-center gap-1">
                  <button
                    className="px-2.5 py-1 rounded border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    ← Prev
                  </button>
                  <span className="px-2">{page + 1} / {totalPages}</span>
                  <button
                    className="px-2.5 py-1 rounded border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next →
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* aaindex package attribution */}
      <div className="card p-5 border border-indigo-100 bg-indigo-50/40">
        <p className="text-xs font-semibold text-indigo-700 uppercase tracking-wide mb-3">
          Powered by the aaindex Python package
        </p>
        <p className="text-sm text-gray-600 mb-4">
          This explorer is built on top of <span className="font-semibold text-gray-800">aaindex</span> — a
          custom Python package providing a simple interface for accessing all 566 physicochemical
          and biochemical indices in the AAIndex1 database.
        </p>
        <div className="flex flex-wrap gap-3 mb-5">
          {/* PyPI link */}
          <a
            href="https://pypi.org/project/aaindex/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white border border-gray-200 text-sm font-medium text-gray-700 hover:border-indigo-400 hover:text-indigo-700 transition-colors shadow-sm"
          >
            <CubeIcon className="w-4 h-4 text-indigo-500" />
            PyPI — aaindex
          </a>
          {/* GitHub link */}
          <a
            href="https://github.com/amckenna41/aaindex"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white border border-gray-200 text-sm font-medium text-gray-700 hover:border-indigo-400 hover:text-indigo-700 transition-colors shadow-sm"
          >
            <CodeBracketIcon className="w-4 h-4 text-indigo-500" />
            GitHub — amckenna41/aaindex
          </a>
        </div>

        {/* Original database citation */}
        <div className="border-t border-indigo-100 pt-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Original Database Reference</p>
          <p className="text-xs text-gray-500 leading-relaxed">
            Shuichi Kawashima, Minoru Kanehisa,{' '}
            <span className="italic">AAindex: Amino Acid index database</span>,{' '}
            Nucleic Acids Research, Volume 28, Issue 1, 1 January 2000, Page 374.{' '}
            <a
              href="https://doi.org/10.1093/nar/28.1.374"
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-600 hover:underline break-all"
            >
              https://doi.org/10.1093/nar/28.1.374
            </a>
          </p>
        </div>
      </div>
    </div>
  )
}
