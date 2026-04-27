import { useEffect, useState, useMemo } from 'react'
import {
  MagnifyingGlassIcon,
  CubeIcon,
  Cog6ToothIcon,
  XMarkIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  CodeBracketIcon,
  CheckIcon,
  PlusIcon,
} from '@heroicons/react/24/outline'
import { getDescriptors } from '../utils/api'
import { useAppStore } from '../store/appStore'
import { DESCRIPTORS as DESCRIPTOR_DEFS } from './DescriptorConfig'

// ── Category colour badges ────────────────────────────────────────────────────
const CATEGORY_COLOURS = {
  'Composition':        'bg-indigo-100 text-indigo-700',
  'Autocorrelation':    'bg-green-100 text-green-700',
  'Conjoint':           'bg-amber-100 text-amber-700',
  'CTD':                'bg-sky-100 text-sky-700',
  'Sequence Order':     'bg-purple-100 text-purple-700',
  'Pseudo Composition': 'bg-pink-100 text-pink-700',
}

// Solid bar colours for the category breakdown chart
const CATEGORY_BAR_COLOURS = {
  'Composition':        'bg-indigo-400',
  'Autocorrelation':    'bg-green-400',
  'Conjoint':           'bg-amber-400',
  'CTD':                'bg-sky-400',
  'Sequence Order':     'bg-purple-400',
  'Pseudo Composition': 'bg-pink-400',
}

function catColour(cat) {
  return CATEGORY_COLOURS[cat] ?? 'bg-gray-100 text-gray-600'
}

function catBarColour(cat) {
  return CATEGORY_BAR_COLOURS[cat] ?? 'bg-gray-400'
}

function featureCountColour(n) {
  if (n <= 50)  return 'text-green-600'
  if (n <= 300) return 'text-amber-600'
  return 'text-red-600'
}

// Standard amino acid display order for the heatmap
const AA_ORDER = ['A','C','D','E','F','G','H','I','K','L','M','N','P','Q','R','S','T','V','W','Y']

// Diverging colour: blue (low) → light gray (mid) → rose (high)
function heatColour(val, min, max) {
  if (max === min) return 'rgb(243,244,246)'
  const t = (val - min) / (max - min)
  if (t <= 0.5) {
    const s = t / 0.5
    return `rgb(${Math.round(56 + (243 - 56) * s)},${Math.round(189 + (244 - 189) * s)},${Math.round(248 + (246 - 248) * s)})`
  }
  const s = (t - 0.5) / 0.5
  return `rgb(${Math.round(243 + (251 - 243) * s)},${Math.round(244 + (113 - 244) * s)},${Math.round(246 + (133 - 246) * s)})`
}

// Heatmap — 20-AA grid coloured by per-AA property values
function AaHeatmap({ aaValues, label }) {
  const vals = AA_ORDER.map((aa) => aaValues[aa] ?? 0)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  return (
    <div>
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{label}</p>
      <div className="grid grid-cols-5 sm:grid-cols-10 gap-1">
        {AA_ORDER.map((aa) => {
          const v = aaValues[aa] ?? 0
          return (
            <div
              key={aa}
              title={`${aa}: ${v}`}
              style={{ backgroundColor: heatColour(v, min, max) }}
              className="rounded p-1.5 text-center"
            >
              <p className="text-xs font-bold text-gray-800 leading-none">{aa}</p>
              <p className="text-xs text-gray-700 leading-none mt-0.5">{v}</p>
            </div>
          )
        })}
      </div>
      {/* Colour legend */}
      <div className="flex items-center gap-2 mt-2">
        <span className="text-xs text-gray-400">Low</span>
        <div
          className="flex-1 h-1.5 rounded"
          style={{ background: 'linear-gradient(to right, rgb(56,189,248), rgb(243,244,246), rgb(251,113,133))' }}
        />
        <span className="text-xs text-gray-400">High</span>
      </div>
    </div>
  )
}

export default function DescriptorExplorer() {
  const [descriptors, setDescriptors] = useState([])
  const [loading, setLoading]         = useState(true)
  const [loadError, setLoadError]     = useState(null)
  const [retryCount, setRetryCount]   = useState(0)
  const [search, setSearch]           = useState('')
  const [selectedCat, setSelectedCat] = useState('All')
  const [sortMode, setSortMode]        = useState('default') // 'default' | 'features' | 'category'
  // expandedSet is stored globally so it persists when the panel is closed/reopened

  // Read and update the encoding selection from global store
  const { encoding, setEncoding, config, dataset, descriptorExpandedSet, toggleDescriptorExpanded, setDescriptorExpandedBatch, backendOnline } = useAppStore()
  const selectedDescriptors = encoding.selected_descriptors ?? []

  // Param lookup built from DescriptorConfig definitions
  const descParamsMap = useMemo(() => Object.fromEntries(DESCRIPTOR_DEFS.map((d) => [d.key, d.params])), [])

  // Encoding time estimation based on selected feature count × dataset rows
  const encodingComplexity = useMemo(() => {
    if (selectedDescriptors.length === 0) return null
    const totalFeatures = selectedDescriptors.reduce((sum, name) => {
      const d = descriptors.find((x) => x.name === name)
      return sum + (d?.feature_count ?? 0)
    }, 0)
    const numRows = dataset?.num_rows ?? 100
    const score = totalFeatures * numRows
    if (score < 5000)  return { label: 'Fast',     colour: 'bg-green-100 text-green-700' }
    if (score < 50000) return { label: 'Moderate',  colour: 'bg-amber-100 text-amber-700' }
    return                   { label: 'Slow',      colour: 'bg-red-100 text-red-700' }
  }, [selectedDescriptors, dataset, descriptors])

  // Toggle a descriptor name in/out of the selection
  function toggleDescriptor(name, e) {
    e.stopPropagation()
    const next = selectedDescriptors.includes(name)
      ? selectedDescriptors.filter((n) => n !== name)
      : [...selectedDescriptors, name]
    setEncoding({ selected_descriptors: next })
  }

  // Add all currently visible descriptors to the selection
  function selectAllVisible() {
    const names = filtered.map((d) => d.name)
    const merged = Array.from(new Set([...selectedDescriptors, ...names]))
    setEncoding({ selected_descriptors: merged })
  }

  // Remove all currently visible descriptors from the selection
  function deselectAllVisible() {
    const names = new Set(filtered.map((d) => d.name))
    setEncoding({ selected_descriptors: selectedDescriptors.filter((n) => !names.has(n)) })
  }

  // Select all descriptors in the active category filter
  function selectAllInCategory() {
    const names = filtered.map((d) => d.name)
    const merged = Array.from(new Set([...selectedDescriptors, ...names]))
    setEncoding({ selected_descriptors: merged })
  }

  // Clear entire selection (empty = use all)
  function clearSelection() {
    setEncoding({ selected_descriptors: [] })
  }

  // Fetch catalogue on mount; timeout after 5 s if no response
  useEffect(() => {
    setLoading(true)
    setLoadError(null)
    const tid = setTimeout(() => setLoadError('Failed to load — please retry'), 5000)
    getDescriptors(backendOnline)
      .then(d => { setDescriptors(d); clearTimeout(tid) })
      .catch(() => { clearTimeout(tid); setLoadError('Failed to load — please retry') })
      .finally(() => setLoading(false))
    return () => clearTimeout(tid)
  }, [retryCount])

  // Unique category list
  const categories = useMemo(() => {
    const set = new Set(descriptors.map((d) => d.category))
    return ['All', ...Array.from(set)]
  }, [descriptors])

  // Filtered descriptor list
  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    const list = descriptors.filter((d) => {
      const matchSearch = !q
        || d.name.toLowerCase().includes(q)
        || d.label.toLowerCase().includes(q)
        || d.category.toLowerCase().includes(q)
        || d.description.toLowerCase().includes(q)
      const matchCat = selectedCat === 'All' || d.category === selectedCat
      return matchSearch && matchCat
    })
    // Sort by selected mode
    if (sortMode === 'features')  return [...list].sort((a, b) => b.feature_count - a.feature_count)
    if (sortMode === 'category')  return [...list].sort((a, b) => a.category.localeCompare(b.category))
    return list
  }, [descriptors, search, selectedCat, sortMode])

  // Collapse all cards when filter/search changes
  useEffect(() => {
    setDescriptorExpandedBatch(filtered.map((d) => d.name), false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, selectedCat])

  // Category breakdown: total features per category, sorted descending
  const categoryBreakdown = useMemo(() => {
    const map = {}
    descriptors.forEach((d) => { map[d.category] = (map[d.category] || 0) + d.feature_count })
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1])
    const maxVal = entries[0]?.[1] ?? 1
    return entries.map(([cat, total]) => ({ cat, total, pct: (total / maxVal) * 100 }))
  }, [descriptors])

  // True if every visible descriptor is currently expanded
  const allExpanded = filtered.length > 0 && filtered.every((d) => descriptorExpandedSet.has(d.name))

  function toggleExpand(name) {
    toggleDescriptorExpanded(name)
  }

  function toggleExpandAll() {
    if (allExpanded) {
      // Collapse all currently visible rows
      setDescriptorExpandedBatch(filtered.map((d) => d.name), false)
    } else {
      // Expand all currently visible rows
      setDescriptorExpandedBatch(filtered.map((d) => d.name), true)
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div>
        <h2 className="text-lg font-bold text-gray-900">Descriptor Explorer</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Browse all {descriptors.length} supported physicochemical and structural descriptors.
        </p>
      </div>

      {/* Selection banner — shown when descriptors are actively chosen */}
      {selectedDescriptors.length > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm">
          <div className="flex items-center gap-2">
            <CheckIcon className="w-4 h-4 text-indigo-600 shrink-0" />
            <span className="font-medium text-indigo-800">
              {selectedDescriptors.length} {selectedDescriptors.length === 1 ? 'descriptor' : 'descriptors'} selected
            </span>
            <span className="text-indigo-500 text-xs">— will be used in Step 3 encoding</span>
            {/* Encoding time estimate */}
            {encodingComplexity && (
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${encodingComplexity.colour}`}>
                {encodingComplexity.label} encoding
              </span>
            )}
          </div>
          <button
            onClick={clearSelection}
            className="text-xs text-indigo-600 hover:text-indigo-800 font-medium underline underline-offset-2 shrink-0"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Category breakdown chart */}
      {!loading && categoryBreakdown.length > 0 && (
        <div className="card p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Feature count by category
          </p>
          <div className="space-y-2">
            {categoryBreakdown.map(({ cat, total, pct }) => (
              <div key={cat} className="flex items-center gap-3">
                <span className="text-xs text-gray-600 w-36 shrink-0 truncate">{cat}</span>
                <div className="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
                  <div
                    className={`${catBarColour(cat)} h-3 rounded-full transition-all`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className={`text-xs font-mono font-semibold w-16 text-right ${featureCountColour(total)}`}>
                  {total.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search + category filter + expand-all */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <MagnifyingGlassIcon className="absolute left-3 top-2.5 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            className="input pl-10 pr-8"
            placeholder="Search by name, category or description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {/* Clear search button */}
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
          value={selectedCat}
          onChange={(e) => setSelectedCat(e.target.value)}
        >
          {categories.map((c) => (
            <option key={c} value={c}>
              {c === 'All' ? `All categories (${descriptors.length})` : c}
            </option>
          ))}
        </select>
        {/* Expand / collapse all */}
        {!loading && filtered.length > 0 && (
          <button
            onClick={toggleExpandAll}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-xs font-medium text-gray-600 hover:border-indigo-400 hover:text-indigo-700 bg-white transition-colors whitespace-nowrap"
          >
            {allExpanded
              ? <><ChevronUpIcon className="w-3.5 h-3.5" /> Collapse all</>
              : <><ChevronDownIcon className="w-3.5 h-3.5" /> Expand all</>}
          </button>
        )}
        {/* Sort by feature count / category */}
        {!loading && filtered.length > 0 && (
          <button
            onClick={() => setSortMode((m) => m === 'default' ? 'features' : m === 'features' ? 'category' : 'default')}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap ${
              sortMode !== 'default'
                ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
                : 'border-gray-200 bg-white text-gray-600 hover:border-indigo-400 hover:text-indigo-700'
            }`}
          >
            <ChevronDownIcon className="w-3.5 h-3.5" />
            {sortMode === 'features' ? 'Sort: features ↓' : sortMode === 'category' ? 'Sort: category' : 'Sort: default'}
          </button>
        )}
        {/* Select all in category (only when a category is active) */}
        {!loading && filtered.length > 0 && selectedCat !== 'All' && (
          <button
            onClick={selectAllInCategory}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-xs font-medium text-gray-600 hover:border-indigo-400 hover:text-indigo-700 bg-white transition-colors whitespace-nowrap"
          >
            <PlusIcon className="w-3.5 h-3.5" /> Select all in category
          </button>
        )}
        {/* Deselect all visible */}
        {!loading && selectedDescriptors.length > 0 && (
          <button
            onClick={deselectAllVisible}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-xs font-medium text-gray-600 hover:border-red-400 hover:text-red-600 bg-white transition-colors whitespace-nowrap"
          >
            <XMarkIcon className="w-3.5 h-3.5" /> Deselect visible
          </button>
        )}
      </div>

      {/* Results count */}
      <p className="text-xs text-gray-400">
        Showing {filtered.length} of {descriptors.length} descriptors
      </p>

      {/* Card list */}
      {loading ? (
        <div className="card p-8 text-center text-gray-400">
          <CubeIcon className="w-8 h-8 mx-auto mb-2 animate-pulse" />
          <p>Loading descriptor catalogue…</p>
        </div>
      ) : loadError ? (
        <div className="card p-8 text-center text-gray-500 space-y-3">
          <CubeIcon className="w-8 h-8 mx-auto text-red-400" />
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
        <div className="space-y-2">
          {filtered.map((desc) => {
            const isExpanded = descriptorExpandedSet.has(desc.name)
            const isSelected = selectedDescriptors.includes(desc.name)
            return (
              <div key={desc.name} className={`card border-2 transition-colors ${isSelected ? 'border-indigo-300 bg-indigo-50/30' : 'border-transparent'}`}>
                {/* Row header — clicking anywhere toggles the expanded detail panel */}
                <div
                  className="flex items-center gap-3 p-4 cursor-pointer"
                  onClick={() => toggleExpand(desc.name)}
                  role="button"
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? `Collapse ${desc.label}` : `Expand ${desc.label}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-sm text-gray-800">{desc.label}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${catColour(desc.category)}`}>
                        {desc.category}
                      </span>
                      {desc.configurable && (
                        <span className="flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                          <Cog6ToothIcon className="w-3 h-3" /> configurable
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5 font-mono">{desc.name}</p>
                  </div>

                  {/* Feature count */}
                  <div className="text-right shrink-0 hidden sm:block">
                    <p className={`text-sm font-bold ${featureCountColour(desc.feature_count)}`}>
                      {desc.feature_count.toLocaleString()}
                    </p>
                    <p className="text-xs text-gray-400">features</p>
                  </div>

                  {/* Select / deselect button */}
                  <button
                    onClick={(e) => toggleDescriptor(desc.name, e)}
                    aria-label={isSelected ? `Deselect ${desc.label}` : `Select ${desc.label}`}
                    className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded font-medium transition-colors shrink-0 ${
                      isSelected
                        ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                        : 'border border-gray-200 text-gray-500 hover:border-indigo-400 hover:text-indigo-600 bg-white'
                    }`}
                  >
                    {isSelected
                      ? <><CheckIcon className="w-3 h-3" /> Selected</>
                      : <><PlusIcon className="w-3 h-3" /> Use</>}
                  </button>

                  {/* Expand toggle — visual chevron only; click is handled by the row */}
                  <span className="text-gray-400 shrink-0" aria-hidden="true">
                    {isExpanded ? <ChevronUpIcon className="w-4 h-4" /> : <ChevronDownIcon className="w-4 h-4" />}
                  </span>
                </div>

                {/* Expanded detail panel */}
                {isExpanded && (
                  <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-4">
                    <p className="text-sm text-gray-600 leading-relaxed">{desc.description}</p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="rounded-lg bg-gray-50 p-3 text-center">
                        <p className={`text-xl font-bold ${featureCountColour(desc.feature_count)}`}>
                          {desc.feature_count.toLocaleString()}
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">Output features</p>
                      </div>
                      <div className="rounded-lg bg-gray-50 p-3 text-center">
                        <p className={`text-base font-bold ${catColour(desc.category).split(' ')[1]}`}>
                          {desc.category}
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">Category</p>
                      </div>
                      <div className="rounded-lg bg-gray-50 p-3 text-center">
                        <p className={`text-base font-bold ${desc.configurable ? 'text-green-600' : 'text-gray-400'}`}>
                          {desc.configurable ? 'Yes' : 'No'}
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">Configurable</p>
                      </div>
                      <div className="rounded-lg bg-gray-50 p-3 text-center">
                        <p className="text-xs font-mono text-gray-600 break-all">{desc.name}</p>
                        <p className="text-xs text-gray-400 mt-0.5">Identifier</p>
                      </div>
                    </div>
                    {desc.configurable && (
                      <div className="text-xs bg-indigo-50 rounded px-3 py-2 space-y-1.5">
                        <p className="text-indigo-700 font-semibold">Configurable parameters</p>
                        {(() => {
                          const params = descParamsMap[desc.name]
                          const current = config?.descriptors?.[desc.name] ?? {}
                          if (!params || params.length === 0) {
                            return <p className="text-indigo-500">Adjust in Step 2 → Descriptors tab before running.</p>
                          }
                          return (
                            <div className="flex flex-wrap gap-3">
                              {params.map((p) => (
                                <div key={p.key} className="flex flex-col gap-0.5">
                                  <span className="font-mono text-gray-500">{p.key}</span>
                                  <span className="font-mono font-semibold text-indigo-700">
                                    {current[p.key] !== undefined ? String(current[p.key]) : String(p.default)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )
                        })()}
                      </div>
                    )}
                    {/* Amino acid property heatmap — shown when per-AA reference values are available */}
                    {desc.aa_values && (
                      <AaHeatmap aaValues={desc.aa_values} label={desc.aa_values_label || 'Amino acid reference values'} />
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {filtered.length === 0 && (
            <p className="text-center py-8 text-gray-400 text-sm">No descriptors match your search.</p>
          )}
        </div>
      )}

      {/* protpy package attribution */}
      <div className="card p-5 border border-indigo-100 bg-indigo-50/40">
        <p className="text-xs font-semibold text-indigo-700 uppercase tracking-wide mb-3">
          Powered by the protpy Python package
        </p>
        <p className="text-sm text-gray-600 mb-4">
          This explorer is built on top of <span className="font-semibold text-gray-800">protpy</span> — a
          custom Python package providing a comprehensive set of protein physicochemical and structural
          descriptors for sequence-based machine learning.
        </p>
        <div className="flex flex-wrap gap-3">
          <a
            href="https://pypi.org/project/protpy/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white border border-gray-200 text-sm font-medium text-gray-700 hover:border-indigo-400 hover:text-indigo-700 transition-colors shadow-sm"
          >
            <CubeIcon className="w-4 h-4 text-indigo-500" />
            PyPI — protpy
          </a>
          <a
            href="https://github.com/amckenna41/protpy"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white border border-gray-200 text-sm font-medium text-gray-700 hover:border-indigo-400 hover:text-indigo-700 transition-colors shadow-sm"
          >
            <CodeBracketIcon className="w-4 h-4 text-indigo-500" />
            GitHub — amckenna41/protpy
          </a>
        </div>
      </div>
    </div>
  )
}

