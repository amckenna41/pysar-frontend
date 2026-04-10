import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BoltIcon,
  TagIcon,
  CubeIcon,
  ArrowLeftIcon,
  PlayIcon,
  StopIcon,
  ClockIcon,
  CheckCircleIcon,
  XCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  BeakerIcon,
  QueueListIcon,
  SparklesIcon,
  XMarkIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { useAppStore } from '../store/appStore'
import { startEncoding, getJob, getAaiIndicesFull, cancelJob, getDescriptors, uploadDataset, checkBackend } from '../utils/api'

// ── Descriptor names loaded from backend (pySAR v2.5.0) ──────────────────────
// Falls back to empty array until the fetch resolves; shown in the multi-select grid

// Autocorrelation descriptors — require sequences >= lag residues
const AUTOCORR_DESCS = [
  'moreaubroto_autocorrelation',
  'moran_autocorrelation',
  'geary_autocorrelation',
]

const SORT_OPTIONS = ['R2', 'RMSE', 'MSE', 'MAE', 'RPD', 'Explained_Var']

const STRATEGIES = [
  {
    id: 'aai',
    label: 'AAI Encoding',
    Icon: TagIcon,
    description: 'Encode sequences using all 566 amino acid indices from the AAI1 database. Optionally generate protein spectra with DSP.',
    modelCount: 'Up to 566 models',
  },
  {
    id: 'descriptor',
    label: 'Descriptor Encoding',
    Icon: CubeIcon,
    description: 'Encode sequences using physicochemical, biochemical and structural descriptors via the protpy package.',
    modelCount: '33 / 528 / 5456 models (combo 1/2/3)',
  },
  {
    id: 'aai_descriptor',
    label: 'AAI + Descriptor',
    Icon: BoltIcon,
    description: 'Combine AAI index encodings with descriptor features for potentially enhanced predictability.',
    modelCount: '~8 500 – ~257 000 models',
  },
]

// ── Log line severity → CSS colour class ─────────────────────────────────────
function logLineClass(line) {
  if (/^ERROR/i.test(line)) return 'text-red-400'
  if (/^WARNING|^Cancelled/i.test(line)) return 'text-amber-400'
  if (/^Complete/i.test(line)) return 'text-emerald-400'
  if (/^Strategy:|^Dataset loaded/i.test(line)) return 'text-sky-300'
  return 'text-gray-300'
}

// ── Client-side model count estimator (mirrors backend _estimate_total_models) ─
function estimateModels(strategy, aaiIndices, selectedDescs, descCombo, maxModels) {
  function comb(n, k) {
    if (k > n || k < 0) return 0
    if (k === 0 || k === n) return 1
    let r = 1
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1)
    return Math.round(r)
  }
  const nAai = aaiIndices?.length || 566
  const nDesc = selectedDescs?.length || 12
  const combo = Math.max(1, descCombo || 1)
  let n = 0
  if (strategy === 'aai') {
    n = nAai
  } else if (strategy === 'descriptor') {
    for (let k = 1; k <= combo; k++) n += comb(nDesc, k)
  } else if (strategy === 'aai_descriptor') {
    let dCombos = 0
    for (let k = 1; k <= combo; k++) dCombos += comb(nDesc, k)
    n = nAai * dCombos
  }
  if (maxModels) n = Math.min(n, parseInt(maxModels, 10) || n)
  return n
}

export default function Step3Encode() {
  const {
    dataset, config, encoding, setEncoding, resetEncoding, setStep,
    setJob, updateJob, job, setResults, clearJob, setDataset,
    addJobToHistory, updateJobHistoryStatus,
    pendingRerun, clearPendingRerun,
    encodingQueue, addToQueue, shiftQueue, removeFromQueue, clearQueue,
    aaiIndicesCache, setAaiIndicesCache,
  } = useAppStore()

  // ── Existing state ────────────────────────────────────────────────────────
  // selectedAaiIndices is derived from the store so AaiExplorer selections sync here
  const selectedAaiIndices = encoding.aai_indices ?? []
  // Two-state debounce: input shows immediately, filter waits 250 ms
  const [aaiSearch, setAaiSearch] = useState('')
  const [aaiSearchDebounced, setAaiSearchDebounced] = useState('')
  const aaiDebounceRef = useRef(null)
  const [aaiDropdownOpen, setAaiDropdownOpen] = useState(false)
  const [allAaiRecords, setAllAaiRecords] = useState([])
  // Descriptor names fetched from backend rather than hardcoded
  const [allDescriptorKeys, setAllDescriptorKeys] = useState([])
  const searchRef = useRef(null)
  const [elapsed, setElapsed] = useState(0)
  const [startTs, setStartTs] = useState(null)

  // ── Fetch descriptor catalogue names from backend on mount ────────────────
  useEffect(() => {
    getDescriptors()
      .then((data) => setAllDescriptorKeys((data ?? []).map((d) => d.name).sort()))
      .catch(() => {})
  }, [])

  // ── Backend availability check ────────────────────────────────────────────
  useEffect(() => {
    checkBackend().then(setBackendAvailable)
  }, [])

  // ── New UI state ──────────────────────────────────────────────────────────
  const [showDryRun, setShowDryRun]               = useState(false)
  const [showConfigSnapshot, setShowConfigSnapshot] = useState(false)
  const [useResume, setUseResume]                 = useState(false)
  // Dismissed warning keys (e.g. 'bigJob', 'descLag')
  const [dismissedWarnings, setDismissedWarnings]   = useState(new Set())
  // null = checking, true = reachable, false = unreachable
  const [backendAvailable, setBackendAvailable]     = useState(null)

  // ── Fetch AAI records once; use in-store cache to avoid repeat requests ─────
  useEffect(() => {
    if (encoding.strategy !== 'aai' && encoding.strategy !== 'aai_descriptor') return
    if (allAaiRecords.length > 0) return
    if (aaiIndicesCache.length > 0) { setAllAaiRecords(aaiIndicesCache); return }
    getAaiIndicesFull().then((data) => {
      setAllAaiRecords(data)
      setAaiIndicesCache(data) // persist in store for subsequent opens
    }).catch(() => {})
  }, [encoding.strategy])

  // ── code → title lookup map ───────────────────────────────────────────────
  const aaiIndexMap = useMemo(() => {
    const map = {}
    allAaiRecords.forEach(({ code, title }) => { map[code] = title })
    return map
  }, [allAaiRecords])

  // ── Filtered suggestions (exclude already selected, search code + title) ──
  // Uses debounced value so rapid typing doesn't re-filter on every keystroke
  const filteredAaiIndices = allAaiRecords.filter(
    ({ code, title }) =>
      !selectedAaiIndices.includes(code) &&
      (code.toLowerCase().includes(aaiSearchDebounced.toLowerCase()) ||
       (title ?? '').toLowerCase().includes(aaiSearchDebounced.toLowerCase()))
  )

  // ── Chip add/remove helpers — update store so AaiExplorer stays in sync ─────
  function addAaiIndex(code) {
    setEncoding({ aai_indices: [...selectedAaiIndices, code] })
    setAaiSearch('')
    setAaiSearchDebounced('')
    clearTimeout(aaiDebounceRef.current)
    setAaiDropdownOpen(false)
  }

  function removeAaiIndex(code) {
    setEncoding({ aai_indices: selectedAaiIndices.filter((c) => c !== code) })
  }

  // ── AAI category coverage analysis ───────────────────────────────────────
  const aaiCategoryAnalysis = useMemo(() => {
    if (!allAaiRecords.length || selectedAaiIndices.length < 2) return null
    const catMap = {}
    allAaiRecords.forEach(({ code, category }) => {
      const cat = category || 'Unknown'
      if (!catMap[cat]) catMap[cat] = []
      catMap[cat].push(code)
    })
    const codeToCategory = Object.fromEntries(
      allAaiRecords.map(({ code, category }) => [code, category || 'Unknown'])
    )
    const coveredCats = new Set(selectedAaiIndices.map((c) => codeToCategory[c]))
    const allCats = Object.keys(catMap)
    const missingCats = allCats.filter((c) => !coveredCats.has(c))
    // Suggest one index per uncovered category (up to 5)
    const suggestions = missingCats.slice(0, 5).map((cat) => ({
      category: cat,
      code: catMap[cat][0],
      title: aaiIndexMap[catMap[cat][0]] || catMap[cat][0],
    }))
    return { total: allCats.length, covered: coveredCats.size, suggestions }
  }, [allAaiRecords, selectedAaiIndices, aaiIndexMap])

  // ── Descriptor lag/dependency warnings ───────────────────────────────────
  const descWarnings = useMemo(() => {
    if (!dataset?.length_stats?.min) return []
    const activeDescs =
      encoding.selected_descriptors?.length ? encoding.selected_descriptors : allDescriptorKeys
    const defaultLag = config.descriptors?.moreaubroto_autocorrelation?.lag ?? 30
    return activeDescs
      .filter((d) => AUTOCORR_DESCS.includes(d))
      .filter(() => dataset.length_stats.min <= defaultLag)
      .map((d) => ({ descriptor: d, lag: defaultLag, minLen: dataset.length_stats.min }))
  }, [encoding.selected_descriptors, dataset, config.descriptors, allDescriptorKeys])

  // ── Dry-run model + time estimate ─────────────────────────────────────────
  const dryRunEstimate = useMemo(() => {
    const models = estimateModels(
      encoding.strategy,
      selectedAaiIndices.length ? selectedAaiIndices : null,
      encoding.selected_descriptors?.length ? encoding.selected_descriptors : null,
      encoding.desc_combo,
      encoding.max_models,
    )
    const secsPerModel = 0.5 / Math.max(1, encoding.n_jobs)
    return { models, estimatedSecs: Math.round(models * secsPerModel) }
  }, [encoding, selectedAaiIndices])

  // ── Phase-based ETA (while running) ──────────────────────────────────────
  const eta = useMemo(() => {
    if (!job?.progress || job.progress <= 0 || job.progress >= 100 || elapsed <= 0) return 0
    return Math.max(0, Math.round(elapsed * (100 - job.progress) / job.progress))
  }, [job?.progress, elapsed])

  // ── Columns for the top-N preview table ──────────────────────────────────
  const topNCols = useMemo(() => {
    if (!job?.columns?.length) return []
    const metricCols = new Set(['R2', 'RMSE', 'MSE', 'MAE', 'RPD', 'Explained_Var'])
    const idCol = job.columns.find((c) => !metricCols.has(c)) || job.columns[0]
    return [idCol, 'R2', 'RMSE', 'MAE'].filter(
      (c) => c === idCol || job.columns.includes(c)
    )
  }, [job?.columns])
  useEffect(() => {
    if (!pendingRerun || !dataset) return
    const entry = pendingRerun
    clearPendingRerun()
    // Rebuild payload using saved params but with current dataset paths
    const p = entry.payload
    const payload = {
      ...p,
      file_path:    dataset.file_path,
      sequence_col: dataset.seq_col,
      activity_col: dataset.act_col,
    }
    // Sync AAI chip display from the saved indices into the store
    setEncoding({ aai_indices: p.aai_indices ?? [] })
    // Submit immediately as a new job
    ;(async () => {
      try {
        clearJob()
        const { job_id } = await startEncoding(payload)
        setJob({ job_id, status: 'pending', log: [], progress: 0, strategy: payload.strategy, algorithm: payload.algorithm })
        addJobToHistory({
          id:               job_id,
          job_id,
          submitted_at:     new Date().toISOString(),
          status:           'pending',
          strategy:         payload.strategy,
          algorithm:        payload.algorithm,
          dataset_filename: dataset.filename,
          payload:          { ...payload },
        })
        setStartTs(Date.now())
        setElapsed(0)
        toast.success('Rerun submitted — encoding in progress…')
      } catch (err) {
        toast.error(err?.response?.data?.detail ?? 'Failed to start rerun')
      }
    })()
  }, [pendingRerun, dataset])

  // ── Elapsed-time ticker ───────────────────────────────────────────────────
  useEffect(() => {
    if (!startTs || job?.status === 'completed' || job?.status === 'failed') return
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - startTs) / 1000)), 1000)
    return () => clearInterval(iv)
  }, [startTs, job?.status])

  // ── Job polling ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!job?.job_id || job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return
    const iv = setInterval(async () => {
      try {
        const data = await getJob(job.job_id)
        updateJob(data)
        if (data.status === 'completed') {
          // Store best R², timestamp and duration in history entry
          const best_r2 = data.results?.[0]?.R2 ?? null
          updateJobHistoryStatus(job.job_id, { status: 'completed', best_r2, completed_at: new Date().toISOString(), duration_ms: startTs ? Date.now() - startTs : null })
          setResults(data.results, data.columns)
          toast.success(`Encoding complete — ${data.results?.length} models evaluated`)
          // Auto-start next queued job if any
          const { encodingQueue: q, shiftQueue: sq } = useAppStore.getState()
          if (q.length > 0) { const next = q[0]; sq(); setTimeout(() => _submitPayload(next), 300) }
        }
        if (data.status === 'failed') {
          // Persist error message, log, timestamp and duration
          updateJobHistoryStatus(job.job_id, { status: 'failed', error: data.error, log: data.log, completed_at: new Date().toISOString(), duration_ms: startTs ? Date.now() - startTs : null })
          toast.error(`Job failed: ${data.error}`)
          // Still advance the queue on failure
          const { encodingQueue: q, shiftQueue: sq } = useAppStore.getState()
          if (q.length > 0) { const next = q[0]; sq(); setTimeout(() => _submitPayload(next), 300) }
        }
        if (data.status === 'cancelled') {
          updateJobHistoryStatus(job.job_id, 'cancelled')
        }
      } catch {
        // Network error — keep polling
      }
    }, 2000)
    return () => clearInterval(iv)
  }, [job?.job_id, job?.status])

  // ── Internal: submit a payload as a new job ───────────────────────────────
  async function _submitPayload(payload) {
    try {
      clearJob()
      const { job_id } = await startEncoding(payload)
      setJob({ job_id, status: 'pending', log: [], progress: 0, strategy: payload.strategy, algorithm: payload.algorithm })
      addJobToHistory({
        id: job_id, job_id,
        submitted_at:     new Date().toISOString(),
        status:           'pending',
        strategy:         payload.strategy,
        algorithm:        payload.algorithm,
        dataset_filename: dataset?.filename,
        payload:          { ...payload },
      })
      setStartTs(Date.now())
      setElapsed(0)
    } catch (err) {
      toast.error(err?.response?.data?.detail ?? 'Failed to start job')
    }
  }

  // ── Build current payload from store state ────────────────────────────────
  // algoOverride: if provided, use this algorithm instead of the first selected
  function _buildPayload(algoOverride) {
    const algo = algoOverride ?? config.model.algorithms?.[0] ?? config.model.algorithm
    // Per-algo params fall back to legacy `parameters` for compatibility
    const algoParams = config.model.perAlgoParameters?.[algo] ?? config.model.parameters ?? {}
    return {
      file_path:            dataset.file_path,
      sequence_col:         dataset.seq_col,
      activity_col:         dataset.act_col,
      algorithm:            algo,
      model_parameters:     algoParams,
      test_split:           config.model.test_split,
      descriptors_config:   config.descriptors,
      dsp_config:           { ...config.pyDSP, use_dsp: config.pyDSP.use_dsp ? 1 : 0 },
      strategy:             encoding.strategy,
      aai_indices:          selectedAaiIndices.length > 0 ? selectedAaiIndices : null,
      selected_descriptors: encoding.selected_descriptors?.length > 0 ? encoding.selected_descriptors : null,
      desc_combo:           encoding.desc_combo,
      sort_by:              encoding.sort_by,
      n_jobs:               encoding.n_jobs,
      max_models:           encoding.max_models ? parseInt(encoding.max_models, 10) : null,
      sample_mode:          encoding.sample_mode,
      random_state:         encoding.random_state ? parseInt(encoding.random_state, 10) : null,
      resume:               useResume,
    }
  }

  // ── Submit job ────────────────────────────────────────────────────────────
  async function handleRun() {
    if (!dataset) { toast.error('No dataset loaded'); return }
    // Guard: encoding requires the backend — surface clearly rather than mid-op failure
    if (backendAvailable === false) { toast.error('Backend not connected — deploy the backend and set VITE_API_URL'); return }
    // Validate required columns are selected
    if (!dataset.seq_col) { toast.error('Select a sequence column in Step 1 first'); return }
    if (!dataset.act_col) { toast.error('Select an activity column in Step 1 first'); return }
    // Lazy upload: example datasets are parsed client-side (file_path is null)
    // Upload to the backend now so we have a real file_path for the encode job
    if (!dataset.file_path && dataset._pendingFile) {
      try {
        toast('Uploading dataset to backend…', { duration: 2000 })
        const uploaded = await uploadDataset(dataset._pendingFile)
        // Merge the real file_id/file_path into the existing dataset state
        setDataset({ ...dataset, file_id: uploaded.file_id, file_path: uploaded.file_path, _pendingFile: null })
        // Re-read from store for payload building below
        Object.assign(dataset, { file_id: uploaded.file_id, file_path: uploaded.file_path })
      } catch (err) {
        toast.error('Dataset upload failed — check the backend is running')
        return
      }
    }
    // Block if any autocorrelation descriptor lag exceeds the shortest sequence
    if (descWarnings.length > 0) {
      toast.error(
        `Lag exceeds shortest sequence (${descWarnings[0]?.minLen} residues) — deselect or shorten lag for: ${descWarnings.map((w) => w.descriptor).join(', ')}`,
        { duration: 6000 }
      )
      return
    }
    const algos = config.model.algorithms?.length ? config.model.algorithms : [config.model.algorithm]
    if (algos.length > 1) {
      // Queue remaining algorithms then submit the first
      algos.slice(1).forEach((a) => addToQueue(_buildPayload(a)))
      toast.success(`Submitting ${algos.length} jobs — encoding in progress…`)
    } else {
      toast.success('Job submitted — encoding in progress…')
    }
    await _submitPayload(_buildPayload(algos[0]))
  }

  // ── Descriptor multi-select toggle ────────────────────────────────────────
  function toggleDesc(d) {
    const cur = encoding.selected_descriptors ?? []
    const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]
    setEncoding({ selected_descriptors: next })
  }

  const isRunning  = job && (job.status === 'pending' || job.status === 'running')
  const isDone     = job?.status === 'completed'
  const isFailed   = job?.status === 'failed'
  const isCancelled = job?.status === 'cancelled'

  // ── Cancel running job ────────────────────────────────────────────────────
  async function handleCancel() {
    if (!job?.job_id) return
    try {
      await cancelJob(job.job_id)
      updateJob({ status: 'cancelled' })
      updateJobHistoryStatus(job.job_id, 'cancelled')
      toast('Job cancelled')
    } catch {
      toast.error('Could not cancel job')
    }
  }

  // ── Large-job warning ─────────────────────────────────────────────────────
  const bigJobWarning = !encoding.max_models && (
    encoding.strategy === 'aai_descriptor'
      ? 'AAI + Descriptor can evaluate up to ~257,000 models. Set a Max models limit to constrain run time.'
      : encoding.strategy === 'aai'
      ? 'AAI encoding will evaluate up to 566 models. Set Max models to limit if needed.'
      : null
  )

  // Best result row for the quick summary card
  const bestResult = isDone ? (job?.partial_results?.[0] ?? job?.results?.[0]) : null

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* ── Backend unavailable banner ── */}
      {backendAvailable === false && (
        <div className="flex gap-3 items-start rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-600 p-4 text-sm">
          <svg className="w-5 h-5 shrink-0 text-amber-500 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
          <div>
            <p className="font-semibold text-amber-800 dark:text-amber-200">Backend not connected</p>
            <p className="text-amber-700 dark:text-amber-300 mt-0.5">
              Encoding requires the pySAR backend. Deploy it to Railway, Render, or Fly.io and set the{' '}
              <code className="font-mono text-xs bg-amber-100 dark:bg-amber-800 px-1 rounded">VITE_API_URL</code>{' '}
              environment variable in Vercel, or run the backend locally.
            </p>
          </div>
        </div>
      )}
      {/* ── Strategy cards ── */}
      <div>
        <p className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">
          Select encoding strategy
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {STRATEGIES.map(({ id, label, Icon, description, modelCount }) => {
            const active = encoding.strategy === id
            const locked = isRunning && !active  // disable non-active cards during encoding
            return (
              <button
                key={id}
                onClick={() => !isRunning && setEncoding({ strategy: id })}
                disabled={locked}
                className={[
                  'text-left rounded-xl p-4 border-2 transition-colors',
                  locked
                    ? 'border-gray-200 bg-gray-50 opacity-40 cursor-not-allowed'
                    : active
                      ? 'border-indigo-500 bg-indigo-50'
                      : 'border-gray-200 bg-white hover:border-gray-300',
                ].join(' ')}
              >
                <Icon className={`w-6 h-6 mb-2 ${active ? 'text-indigo-600' : 'text-gray-400'}`} />
                <p className={`font-semibold text-sm ${active ? 'text-indigo-700 dark:text-indigo-300' : 'text-gray-800 dark:text-gray-200'}`}>
                  {label}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-snug">
                  {description}
                </p>
                <p className="text-xs font-medium text-indigo-500 dark:text-indigo-400 mt-2">
                  {modelCount}
                </p>
              </button>
            )
          })}
        </div>
      </div>

      {/* ── AAI indices input (shown for aai / aai_descriptor) ── */}
      {(encoding.strategy === 'aai' || encoding.strategy === 'aai_descriptor') && (
        <div className="card p-4 space-y-2">
          <label className="label font-semibold">
            AAI indices
            <span className="ml-1 font-normal text-gray-400">(leave blank to use all 566)</span>
          </label>

          {/* Chip container + typeahead input */}
          <div className="relative">
            <div
              className="input min-h-[2.5rem] flex flex-wrap gap-1 p-1.5 cursor-text"
              onClick={() => searchRef.current?.focus()}
            >
              {/* Selected chips — with hover tooltip showing the index title */}
              {selectedAaiIndices.map((code) => {
                const title = aaiIndexMap[code]
                return (
                  <span key={code} className="relative group/chip">
                    <span className="inline-flex items-center gap-1 bg-indigo-100 text-indigo-800 text-xs font-mono px-2 py-0.5 rounded cursor-default">
                      {code}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removeAaiIndex(code) }}
                        className="hover:text-indigo-600 leading-none"
                      >
                        ×
                      </button>
                    </span>
                    {/* Tooltip — appears above chip on hover */}
                    {title && (
                      <span className="pointer-events-none absolute bottom-full left-0 mb-1.5 z-50 w-64 rounded-lg bg-gray-900 text-white text-xs px-3 py-2 opacity-0 group-hover/chip:opacity-100 transition-opacity duration-150 shadow-xl">
                        <span className="block font-semibold font-mono mb-0.5">{code}</span>
                        <span className="block text-gray-300 leading-snug">{title}</span>
                      </span>
                    )}
                  </span>
                )
              })}

              {/* Search input */}
              <input
                ref={searchRef}
                className="flex-1 min-w-[140px] bg-transparent outline-none text-xs font-mono"
                placeholder={selectedAaiIndices.length === 0 ? 'Type to search indices…' : ''}
                value={aaiSearch}
                onChange={(e) => {
                  const v = e.target.value
                  setAaiSearch(v)
                  setAaiDropdownOpen(true)
                  // Debounce the filter value so rapid typing doesn't recompute on every keystroke
                  clearTimeout(aaiDebounceRef.current)
                  aaiDebounceRef.current = setTimeout(() => setAaiSearchDebounced(v), 250)
                }}
                onFocus={() => setAaiDropdownOpen(true)}
                onBlur={() => setTimeout(() => setAaiDropdownOpen(false), 150)}
                onKeyDown={(e) => {
                  // Backspace on empty input removes last chip
                  if (e.key === 'Backspace' && !aaiSearch && selectedAaiIndices.length > 0) {
                    removeAaiIndex(selectedAaiIndices[selectedAaiIndices.length - 1])
                  }
                  // Enter selects first suggestion
                  if (e.key === 'Enter' && filteredAaiIndices.length > 0) {
                    e.preventDefault()
                    addAaiIndex(filteredAaiIndices[0].code)
                  }
                }}
              />
            </div>

            {/* Dropdown suggestions — show code + title */}
            {aaiDropdownOpen && filteredAaiIndices.length > 0 && (
              <div className="absolute z-50 mt-1 w-full max-h-48 overflow-auto shadow-lg bg-white rounded border border-gray-200">
                {filteredAaiIndices.slice(0, 60).map(({ code, title }) => (
                  <button
                    key={code}
                    type="button"
                    className="w-full text-left px-3 py-1.5 hover:bg-indigo-50 flex items-baseline gap-2 min-w-0"
                    onMouseDown={() => addAaiIndex(code)}
                  >
                    <span className="text-xs font-mono font-semibold text-indigo-700 shrink-0">{code}</span>
                    {title && <span className="text-xs text-gray-400 truncate">{title}</span>}
                  </button>
                ))}
                {filteredAaiIndices.length > 60 && (
                  <div className="px-3 py-1.5 text-xs text-gray-400 italic">
                    +{filteredAaiIndices.length - 60} more — keep typing to narrow results
                  </div>
                )}
              </div>
            )}
          </div>

          <p className="text-xs text-gray-400">Search and select accession codes from the AAI1 database</p>

          {/* AAI category coverage recommendations — shown when ≥ 2 indices are selected */}
          {aaiCategoryAnalysis && (
            <div className="flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5">
              <SparklesIcon className="w-4 h-4 text-sky-500 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-sky-700">
                  Category coverage: {aaiCategoryAnalysis.covered} / {aaiCategoryAnalysis.total}
                </p>
                {aaiCategoryAnalysis.suggestions.length > 0 && (
                  <p className="text-xs text-sky-600 mt-0.5">
                    Expand coverage — add from:{' '}
                    {aaiCategoryAnalysis.suggestions.map(({ category, code }) => (
                      <button
                        key={code}
                        type="button"
                        className="font-mono text-indigo-600 hover:underline mr-1.5"
                        onClick={() => addAaiIndex(code)}
                        title={`${category}: add ${code}`}
                      >
                        {code}
                      </button>
                    ))}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Descriptor selection (shown for descriptor / aai_descriptor) ── */}
      {(encoding.strategy === 'descriptor' || encoding.strategy === 'aai_descriptor') && (
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <label className="label font-semibold">
              Descriptors
              <span className="ml-1 font-normal text-gray-400">(leave all unchecked to use all)</span>
            </label>
            {/* desc_combo */}
            <div className="flex items-center gap-2">
              <span className="label mb-0">Combo</span>
              {[1, 2, 3].map((n) => (
                <button
                  key={n}
                  onClick={() => setEncoding({ desc_combo: n })}
                  className={[
                    'w-8 h-8 rounded-lg border text-xs font-bold transition-colors',
                    encoding.desc_combo === n
                      ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
                      : 'border-gray-200 dark:border-gray-700 text-gray-500',
                  ].join(' ')}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {allDescriptorKeys.map((d) => {
              const checked = (encoding.selected_descriptors ?? []).includes(d)
              const hasWarning = descWarnings.some((w) => w.descriptor === d)
              return (
                <label key={d} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleDesc(d)}
                    className="accent-indigo-600"
                  />
                  <span className={`text-xs leading-tight break-all ${hasWarning ? 'text-amber-600 dark:text-amber-400' : 'text-gray-600 dark:text-gray-400'}`}>
                    {d}{hasWarning ? ' ⚠' : ''}
                  </span>
                </label>
              )
            })}
          </div>

          {/* Descriptor dependency warnings */}
          {descWarnings.length > 0 && !dismissedWarnings.has('descLag') && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-700">
              <ExclamationTriangleIcon className="w-4 h-4 mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="font-semibold">Sequence length warning</p>
                <p className="mt-0.5">
                  {descWarnings.map((w) => w.descriptor).join(', ')} use lag={descWarnings[0]?.lag}, but your
                  shortest sequence is {descWarnings[0]?.minLen} residues. This may cause errors.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDismissedWarnings((prev) => new Set(prev).add('descLag'))}
                className="shrink-0 p-0.5 rounded hover:bg-amber-200 text-red-400 hover:text-red-600 transition-colors"
                title="Dismiss warning"
              >
                <XMarkIcon className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Encoding tuning params ── */}
      <div className="card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">Encoding parameters</p>
          <div className="flex items-center gap-3">
            {/* Reset all encoding params (strategy, indices, descriptors, tuning) to defaults */}
            <button
              type="button"
              onClick={() => { resetEncoding(); setAaiSearch(''); setAaiSearchDebounced(''); toast('Encoding parameters reset') }}
              disabled={isRunning}
              className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Reset all encoding parameters to defaults"
            >
              <ArrowPathIcon className="w-3.5 h-3.5" /> Reset
            </button>
            {/* Config snapshot toggle */}
            <button
              type="button"
              onClick={() => setShowConfigSnapshot((p) => !p)}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
              title="Toggle config snapshot"
            >
              <InformationCircleIcon className="w-4 h-4" />
              {showConfigSnapshot ? 'Hide config' : 'Config'}
            </button>
            {/* Dry-run estimate toggle */}
            <button
              type="button"
              onClick={() => setShowDryRun((p) => !p)}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-indigo-600"
              title="Estimate model count and run time"
            >
              <BeakerIcon className="w-4 h-4" />
              Estimate
            </button>
          </div>
        </div>

        {/* Config snapshot panel */}
        {showConfigSnapshot && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 dark:bg-gray-800/60 px-4 py-3 text-xs">
            <p className="font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
              Config snapshot
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1">
              <SnapItem label="Algorithm"  value={config.model.algorithms?.length > 1 ? `${config.model.algorithms.length} selected` : config.model.algorithm} mono />
              <SnapItem label="Test split" value={config.model.test_split} />
              <SnapItem label="DSP"        value={config.pyDSP?.use_dsp ? 'Enabled' : 'Off'} />
              <SnapItem label="Strategy"   value={encoding.strategy} />
              <SnapItem label="n_jobs"     value={encoding.n_jobs} />
              <SnapItem label="Sort by"    value={encoding.sort_by} />
              {encoding.max_models ? <SnapItem label="Max models" value={encoding.max_models} /> : null}
              {encoding.sample_mode ? <SnapItem label="Sample mode" value="On" /> : null}
              {selectedAaiIndices.length > 0 ? (
                <SnapItem label="AAI indices" value={`${selectedAaiIndices.length} selected`} />
              ) : null}
              {encoding.selected_descriptors?.length > 0 ? (
                <SnapItem label="Descriptors" value={`${encoding.selected_descriptors.length} selected`} />
              ) : null}
            </div>
            <button
              type="button"
              className="mt-2 text-indigo-500 hover:underline text-xs"
              onClick={() => setStep(2)}
            >
              Edit model config →
            </button>
          </div>
        )}

        {/* Dry-run estimate panel */}
        {showDryRun && (
          <div className="rounded-lg border border-indigo-200 bg-indigo-50 dark:bg-indigo-900/20 px-4 py-3 text-xs">
            <p className="font-semibold text-indigo-700 dark:text-indigo-300 mb-2">Run estimate</p>
            <div className="flex flex-wrap items-center gap-6">
              <div>
                <span className="text-gray-500">Models: </span>
                <span className="font-bold text-indigo-700">{dryRunEstimate.models.toLocaleString()}</span>
              </div>
              <div>
                <span className="text-gray-500">Estimated time: </span>
                <span className="font-bold text-indigo-700">~{formatElapsed(dryRunEstimate.estimatedSecs)}</span>
              </div>
            </div>
            <p className="text-gray-400 mt-1.5">
              Estimate assumes ~0.5 s/model at {encoding.n_jobs} worker{encoding.n_jobs !== 1 ? 's' : ''}.
              Actual time depends on sequence length and hardware.
            </p>
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {/* Sort by */}
          <div>
            <label className="label">Sort results by</label>
            <select className="input" value={encoding.sort_by} onChange={(e) => setEncoding({ sort_by: e.target.value })}>
              {SORT_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>

          {/* n_jobs */}
          <div>
            <label className="label">Parallel workers (n_jobs)</label>
            <input
              type="number" className="input" min={1} max={32}
              value={encoding.n_jobs}
              onChange={(e) => setEncoding({ n_jobs: parseInt(e.target.value, 10) || 1 })}
            />
            <p className="text-xs text-gray-400 mt-0.5">-1 = all CPUs</p>
          </div>

          {/* max_models */}
          <div>
            <label className="label">Max models <span className="font-normal text-gray-400">(optional)</span></label>
            <input
              type="number" className="input" min={1}
              placeholder="unlimited"
              value={encoding.max_models}
              onChange={(e) => setEncoding({ max_models: e.target.value })}
            />
          </div>

          {/* random_state */}
          <div>
            <label className="label">Random state <span className="font-normal text-gray-400">(optional)</span></label>
            <input
              type="number" className="input"
              placeholder="none"
              value={encoding.random_state}
              onChange={(e) => setEncoding({ random_state: e.target.value })}
            />
          </div>

          {/* sample_mode */}
          <div className="flex items-end pb-1.5">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={encoding.sample_mode}
                onChange={(e) => setEncoding({ sample_mode: e.target.checked })}
                className="w-4 h-4 accent-indigo-600"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">Sample mode</span>
            </label>
          </div>

          {/* resume — sends resume:true to the backend */}
          <div className="flex items-end pb-1.5">
            <label className="flex items-center gap-2 cursor-pointer" title="Resume from a previous checkpoint if one exists">
              <input
                type="checkbox"
                checked={useResume}
                onChange={(e) => setUseResume(e.target.checked)}
                className="w-4 h-4 accent-indigo-600"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">Resume previous</span>
            </label>
          </div>
        </div>
      </div>

      {/* ── Large-job warning ── */}
      {bigJobWarning && !isRunning && !dismissedWarnings.has('bigJob') && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          <ExclamationTriangleIcon className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="flex-1">{bigJobWarning}</span>
          <button
            type="button"
            onClick={() => setDismissedWarnings((prev) => new Set(prev).add('bigJob'))}
            className="shrink-0 p-0.5 rounded hover:bg-amber-200 text-red-400 hover:text-red-600 transition-colors"
            title="Dismiss warning"
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ── Job status panel ── */}
      {job && (
        <div className="card p-4 space-y-3">
          {/* Header row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 flex-wrap">
              {isRunning   && <Spinner />}
              {isDone      && <CheckCircleIcon className="w-5 h-5 text-green-500" />}
              {isFailed    && <XCircleIcon className="w-5 h-5 text-red-500" />}
              {isCancelled && <XCircleIcon className="w-5 h-5 text-amber-500" />}
              <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                {isRunning ? 'Running…' : isDone ? 'Complete' : isCancelled ? 'Cancelled' : 'Failed'}
              </span>
              {/* Live model count */}
              {job.total_models > 0 && (
                <span className="text-xs text-gray-400 tabular-nums">
                  {(job.models_completed ?? 0).toLocaleString()} / {job.total_models.toLocaleString()} models
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {/* ETA while running */}
              {isRunning && eta > 0 && (
                <span className="text-xs text-gray-400">~{formatElapsed(eta)} remaining</span>
              )}
              {/* Elapsed clock */}
              {startTs && (
                <span className="flex items-center gap-1 text-xs text-gray-400">
                  <ClockIcon className="w-3.5 h-3.5" />
                  {formatElapsed(elapsed)}
                </span>
              )}
              {/* Cancel button */}
              {isRunning && (
                <button
                  onClick={handleCancel}
                  className="flex items-center gap-1 text-xs text-red-600 hover:text-red-700 font-medium border border-red-200 rounded px-2 py-1"
                >
                  <StopIcon className="w-3.5 h-3.5" /> Stop
                </button>
              )}
            </div>
          </div>

          {/* Progress bar */}
          {(isRunning || isDone) && (
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
              <div
                className={`h-1.5 rounded-full transition-all duration-500 ${isDone ? 'bg-green-500' : 'bg-indigo-500'}`}
                style={{ width: `${job.progress ?? 0}%` }}
              />
            </div>
          )}

          {/* Log console with severity colouring */}
          <div className="rounded-lg bg-gray-900 font-mono text-xs p-3 max-h-40 overflow-y-auto space-y-0.5">
            {(job.log ?? []).map((line, i) => (
              <div key={i} className={logLineClass(line)}>{'> '}{line}</div>
            ))}
            {isRunning && <div className="text-gray-500 animate-pulse">{'> '}…</div>}
          </div>

          {/* Quick result summary — shown when job completes */}
          {isDone && bestResult && (
            <div className="rounded-lg border border-green-200 bg-green-50 dark:bg-green-900/20 px-4 py-3">
              <p className="text-xs font-semibold text-green-700 dark:text-green-300 mb-2">Best model</p>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-gray-500">R²</p>
                  <p className="text-xl font-bold text-green-700 tabular-nums">
                    {bestResult.R2 != null ? Number(bestResult.R2).toFixed(4) : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">RMSE</p>
                  <p className="text-xl font-bold text-gray-700 dark:text-gray-200 tabular-nums">
                    {bestResult.RMSE != null ? Number(bestResult.RMSE).toFixed(4) : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Models evaluated</p>
                  <p className="text-xl font-bold text-gray-700 dark:text-gray-200 tabular-nums">
                    {job.results?.length ?? job.models_completed ?? '—'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Top-10 preview table — shown once job is complete */}
          {isDone && topNCols.length > 0 && job.partial_results?.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1.5">Top models preview</p>
              <div className="overflow-x-auto rounded border border-gray-200 dark:border-gray-700">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 dark:bg-gray-800 text-gray-500">
                    <tr>
                      {topNCols.map((col) => (
                        <th key={col} className="text-left px-2 py-1.5 font-medium whitespace-nowrap">{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {job.partial_results.slice(0, 10).map((row, i) => (
                      <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/60">
                        {topNCols.map((col, ci) => (
                          <td
                            key={col}
                            className={`px-2 py-1 ${
                              ci === 0
                                ? 'font-mono text-gray-700 dark:text-gray-300 max-w-[180px] truncate'
                                : ci === 1
                                  ? 'text-indigo-600 font-medium tabular-nums'
                                  : 'text-gray-600 dark:text-gray-400 tabular-nums'
                            }`}
                            title={ci === 0 ? String(row[col] ?? '') : undefined}
                          >
                            {typeof row[col] === 'number' ? Number(row[col]).toFixed(4) : (row[col] ?? '—')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {isFailed && job.error && (
            <p className="text-xs text-red-500 dark:text-red-400">{job.error}</p>
          )}
        </div>
      )}

      {/* ── Encoding queue panel ── */}
      {encodingQueue.length > 0 && (
        <div className="card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <QueueListIcon className="w-4 h-4 text-gray-400" />
              <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                Queue ({encodingQueue.length})
              </p>
            </div>
            <button type="button" className="text-xs text-gray-400 hover:text-red-500" onClick={clearQueue}>
              Clear all
            </button>
          </div>
          <div className="space-y-1.5">
            {encodingQueue.map((item, i) => (
              <div key={i} className="flex items-center justify-between text-xs rounded border border-gray-100 dark:border-gray-700 px-3 py-1.5 bg-gray-50 dark:bg-gray-800">
                <span className="font-medium text-gray-600 dark:text-gray-300">
                  #{i + 1} — {item.strategy}
                </span>
                <span className="text-gray-400 font-mono">{item.algorithm}</span>
                <button
                  type="button"
                  className="text-gray-300 hover:text-red-400 ml-2"
                  onClick={() => removeFromQueue(i)}
                  title="Remove from queue"
                >
                  <XMarkIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Navigation ── */}
      <div className="flex justify-between">
        <button className="btn-secondary" onClick={() => setStep(2)}>
          <ArrowLeftIcon className="w-4 h-4" /> Back
        </button>
        <div className="flex gap-2">
          {isDone && (
            <button className="btn-primary bg-green-600 hover:bg-green-700" onClick={() => setStep(4)}>
              View Results
            </button>
          )}
          <button
            className="btn-primary"
            onClick={handleRun}
            disabled={isRunning || backendAvailable === false}
          >
            <PlayIcon className="w-4 h-4" />
            {isRunning ? 'Running…' : isDone ? 'Rerun Encoding' : 'Start Encoding'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <svg className="animate-spin w-4 h-4 text-indigo-500" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
      <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" className="opacity-75" />
    </svg>
  )
}

function formatElapsed(s) {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

// Compact key/value row for the config snapshot panel
function SnapItem({ label, value, mono = false }) {
  return (
    <div>
      <span className="text-gray-400">{label}: </span>
      <span className={mono ? 'font-mono text-gray-700 dark:text-gray-200' : 'text-gray-700 dark:text-gray-200'}>
        {value ?? '—'}
      </span>
    </div>
  )
}
