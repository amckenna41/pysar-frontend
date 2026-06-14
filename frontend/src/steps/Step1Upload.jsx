import { useCallback, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import {
  CloudArrowUpIcon,
  CheckCircleIcon,
  XCircleIcon,
  XMarkIcon,
  DocumentTextIcon,
  ArrowRightIcon,
  ExclamationTriangleIcon,
  SparklesIcon,
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from '@heroicons/react/24/outline'
import {
  ResponsiveContainer,
  BarChart, Bar,
  XAxis, YAxis,
  CartesianGrid, Tooltip,
} from 'recharts'
import toast from 'react-hot-toast'
import { uploadDataset, loadExampleDataset, getExampleDatasets, deduplicateDataset, fixMissingSequences, fixMissingActivity, fixOutliers } from '../utils/api'
import { formatApiError } from '../utils/errorHandling'
import { useAppStore } from '../store/appStore'
import DatasetPreview from '../components/DatasetPreview'

// Confidence badge shown next to auto-detected column labels
function ConfidenceBadge({ level }) {
  if (!level) return null
  const styles = {
    high:   'bg-green-100 text-green-700',
    medium: 'bg-amber-100 text-amber-700',
    low:    'bg-red-100 text-red-700',
  }
  return (
    <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded font-medium ${styles[level] ?? ''}`}>
      auto-detected · {level}
    </span>
  )
}

// Skewness annotation displayed over the activity histogram
function skewnessNote(skew) {
  if (skew == null) return null
  const abs = Math.abs(skew)
  if (abs > 1)   return { label: `Skew ${skew} — highly skewed, consider log-transform`, colour: 'text-red-600' }
  if (abs > 0.5) return { label: `Skew ${skew} — moderately skewed`, colour: 'text-amber-600' }
  return { label: `Skew ${skew} — approximately normal`, colour: 'text-green-600' }
}

// Scrollable mini-table used inside warning banners to show affected rows
function AffectedRowsTable({ rows, columns, label }) {
  if (!rows?.length) return null
  // Show a concise subset of columns if the dataset is wide
  const visibleCols = columns.length <= 6 ? columns : columns.slice(0, 6)
  return (
    <div className="mt-3 rounded-lg border border-current/20 overflow-hidden">
      <div className="px-3 py-1.5 bg-current/5 text-xs font-semibold opacity-80 flex items-center justify-between">
        <span>{label ?? `${rows.length} row${rows.length !== 1 ? 's' : ''}`}</span>
        {columns.length > 6 && (
          <span className="opacity-60 font-normal">{columns.length - 6} columns hidden</span>
        )}
      </div>
      <div className="overflow-x-auto max-h-52 overflow-y-auto">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 bg-white/90 dark:bg-gray-900/90">
            <tr>
              {visibleCols.map((c) => (
                <th key={c} className="px-2 py-1.5 text-left font-semibold whitespace-nowrap opacity-70">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-current/10">
            {rows.map((row, i) => (
              <tr key={i} className="hover:bg-current/5">
                {visibleCols.map((c) => (
                  <td key={c} className="px-2 py-1.5 max-w-[180px] truncate whitespace-nowrap font-mono" title={String(row[c] ?? '')}>
                    {String(row[c] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function Step1Upload() {
  const { dataset, setDataset, clearDataset, setStep } = useAppStore()

  const [uploading, setUploading]       = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadProcessing, setUploadProcessing] = useState(false) // true after bytes sent, waiting for server
  const [error, setError]               = useState(null)
  const [backendUnavailable, setBackendUnavailable] = useState(false)
  const [logTransform, setLogTransform] = useState(false)      // activity histogram toggle
  const [showSamples, setShowSamples]   = useState(false)      // sample dataset panel
  const [showBackendDialog, setShowBackendDialog] = useState(false)
  // Static list — no backend call needed; getExampleDatasets() is now synchronous
  const [sampleList, setSampleList]     = useState(() => getExampleDatasets().datasets)
  const [loadingSample, setLoadingSample] = useState(null)     // name of sample being loaded
  const [previewSample, setPreviewSample] = useState(null)     // which sample preview is expanded
  const [deduplicating, setDeduplicating] = useState(false)
  // Snapshot of the dataset before any fix operation — enables "Restore original"
  const [originalDataset, setOriginalDataset] = useState(null)
  // Which warning banner's "View affected rows" is currently expanded
  const [expandedWarning, setExpandedWarning] = useState(null)
  // Dismissed non-blocking warnings (Set of keys: 'seq' | 'duplicate' | 'outlier')
  const [dismissedWarnings, setDismissedWarnings] = useState(new Set())
  // Which fix operation is in flight (null | 'seq' | 'act-mean' | 'act-median' | 'act-remove' | 'outlier-winsorize' | 'outlier-remove')
  const [fixingOp, setFixingOp] = useState(null)
  // Whether the activity-fix options row is expanded inside the missing-values banner
  const [showActFixOptions, setShowActFixOptions] = useState(false)
  // Whether the outlier-fix options row is expanded inside the outlier banner
  const [showOutlierFixOptions, setShowOutlierFixOptions] = useState(false)

  // ── File upload handler ────────────────────────────────────────────────────
  const onDrop = useCallback(
    async (accepted, rejected) => {
      if (rejected.length > 0) {
        setError('Only .txt, .csv and .tsv files are accepted.')
        return
      }
      if (accepted.length === 0) return
      // Secondary extension guard: react-dropzone matches on MIME type AND extension
      // together, but on macOS .tsv/.csv files can slip through with text/plain MIME type.
      const fileExt = accepted[0].name.split('.').pop().toLowerCase()
      if (!['txt', 'csv', 'tsv'].includes(fileExt)) {
        setError('Only .txt, .csv and .tsv files are accepted.')
        return
      }
      // Reject files over 10 MB before sending to the server
      const MAX_BYTES = 10 * 1024 * 1024
      if (accepted[0].size > MAX_BYTES) {
        setError('File too large. Maximum upload size is 10 MB.')
        toast.error('File too large. Maximum upload size is 10 MB.')
        return
      }
      setError(null)
      setBackendUnavailable(false)
      setUploading(true)
      setUploadProgress(0)
      setUploadProcessing(false)
      try {
        // Track when bytes finish uploading so we can show a "Processing…" phase
        const onProgress = (pct) => {
          setUploadProgress(pct)
          if (pct >= 100) setUploadProcessing(true)
        }
        const result = await uploadDataset(accepted[0], onProgress)
        setDataset({ ...result, seq_col: result.seq_col_guess, act_col: result.act_col_guess })
        setOriginalDataset(null) // clear any prior fix snapshot on new upload
        setLogTransform(false)
        toast.success(`Loaded ${result.num_rows} sequences from ${result.filename}`)
      } catch (err) {
        const isConnErr = !err?.response || err?.code === 'ERR_NETWORK' || err?.code === 'ECONNABORTED' || err?.response?.status === 502 || err?.response?.status === 503
        if (isConnErr) {
          setBackendUnavailable(true)
        } else {
          const msg = formatApiError(err) || 'Upload failed'
          setError(msg)
          toast.error(msg)
        }
      } finally {
        setUploading(false)
        setUploadProcessing(false)
      }
    },
    [setDataset],
  )

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    // Include both text/tsv and text/tab-separated-values — macOS uses text/plain for .tsv
    accept: { 'text/plain': ['.txt', '.tsv', '.csv'], 'text/csv': ['.csv'], 'text/tsv': ['.tsv'], 'text/tab-separated-values': ['.tsv'] },
    multiple: false,
    disabled: uploading,
  })

  // ── Sample dataset loader ──────────────────────────────────────────────────
  async function handleLoadSample(name) {
    setLoadingSample(name)
    try {
      const result = await loadExampleDataset(name)
      setDataset({ ...result, seq_col: result.seq_col_guess, act_col: result.act_col_guess })
      setOriginalDataset(null)
      setShowSamples(false)
      setLogTransform(false)
      toast.success(`Loaded sample dataset: ${result.filename}`)
    } catch (err) {
      toast.error(err?.response?.data?.detail ?? 'Failed to load sample dataset')
    } finally {
      setLoadingSample(null)
    }
  }

  // ── Lazy-upload helper ─────────────────────────────────────────────────────
  // Datasets loaded via example datasets are parsed client-side (_pendingFile set,
  // file_path null). Before any fix that needs a server-side file_id, upload first.
  // _pendingFile may have been serialised to {} by Zustand persist — fall back to
  // _pendingFileText (a plain string) which survives JSON serialisation.
  async function ensureUploaded(current) {
    if (!current?.file_path) {
      let fileToUpload = current._pendingFile instanceof File ? current._pendingFile : null
      if (!fileToUpload && current._pendingFileText) {
        fileToUpload = new File(
          [current._pendingFileText],
          current._pendingFileName ?? 'dataset.txt',
          { type: 'text/plain' },
        )
      }
      if (fileToUpload) {
        const uploaded = await uploadDataset(fileToUpload)
        const merged = { ...current, file_id: uploaded.file_id, file_path: uploaded.file_path, _pendingFile: null }
        setDataset(merged)
        return merged
      }
    }
    return current
  }

  // ── Deduplicate ────────────────────────────────────────────────────────────
  async function handleDeduplicate() {
    if (!dataset) return
    setDeduplicating(true)
    // Save snapshot before modifying so user can restore
    if (!originalDataset) setOriginalDataset(dataset)
    try {
      const ds = await ensureUploaded(dataset)
      const result = await deduplicateDataset(ds.file_id, ds.seq_col)
      const removed = result.removed ?? 0
      setDataset({ ...result, seq_col: result.seq_col_guess, act_col: result.act_col_guess })
      toast.success(`Removed ${removed} duplicate sequence${removed !== 1 ? 's' : ''}`)
    } catch (err) {
      toast.error(err?.response?.data?.detail ?? 'Deduplication failed')
    } finally {
      setDeduplicating(false)
    }
  }

  // ── Fix missing activity values ────────────────────────────────────────────
  async function handleFixMissingActivity(method) {
    if (!dataset) return
    const op = `act-${method}`
    setFixingOp(op)
    if (!originalDataset) setOriginalDataset(dataset)
    try {
      const ds = await ensureUploaded(dataset)
      const result = await fixMissingActivity(ds.file_id, ds.seq_col, ds.act_col, method)
      setDataset({ ...result, seq_col: result.seq_col_guess, act_col: result.act_col_guess })
      setShowActFixOptions(false)
      const label = method === 'mean' ? 'mean imputation' : method === 'median' ? 'median imputation' : 'row removal'
      toast.success(`Fixed ${dataset.missing_info.act_missing} missing activity value${dataset.missing_info.act_missing !== 1 ? 's' : ''} via ${label}`)
    } catch (err) {
      toast.error(err?.response?.data?.detail ?? 'Fix failed')
    } finally {
      setFixingOp(null)
    }
  }

  // ── Column selector ────────────────────────────────────────────────────────
  async function handleFixOutliers(method) {
    if (!dataset) return
    const op = `outlier-${method}`
    setFixingOp(op)
    if (!originalDataset) setOriginalDataset(dataset)
    try {
      const ds = await ensureUploaded(dataset)
      const result = await fixOutliers(ds.file_id, ds.seq_col, ds.act_col, method)
      setDataset({ ...result, seq_col: result.seq_col_guess, act_col: result.act_col_guess })
      setShowOutlierFixOptions(false)
      const count = dataset.outlier_info?.outlier_count ?? result.affected ?? 0
      const label = method === 'winsorize' ? 'winsorization (clamped to ±3σ)' : method === 'mean' ? 'mean imputation' : 'row removal'
      toast.success(`Fixed ${count} outlier${count !== 1 ? 's' : ''} via ${label}`)
    } catch (err) {
      toast.error(err?.response?.data?.detail ?? 'Fix failed')
    } finally {
      setFixingOp(null)
    }
  }

  function handleColChange(key, value) {
    setDataset({ ...dataset, [key]: value })
  }
  // ── Stats cards ────────────────────────────────────────────────────────────
  const stats = dataset
    ? [
        { label: 'Sequences',   value: dataset.num_rows },
        { label: 'Columns',     value: dataset.columns.length },
        { label: 'Min length',  value: dataset.length_stats?.min ?? '—' },
        { label: 'Max length',  value: dataset.length_stats?.max ?? '—' },
        { label: 'Mean length', value: dataset.length_stats?.mean ?? '—' },
        {
          label: 'Activity range',
          value: dataset.activity_stats?.min != null
            ? `${dataset.activity_stats.min} – ${dataset.activity_stats.max}`
            : '—',
        },
      ]
    : []

  const canProceed = dataset && dataset.seq_col && dataset.act_col

  // Activity histogram data — switches between raw and log-transformed
  const actHistData = logTransform
    ? dataset?.activity_stats?.log_histogram
    : dataset?.activity_stats?.histogram

  const skewInfo = skewnessNote(dataset?.activity_stats?.skewness)

  return (
    <div className="max-w-4xl mx-auto space-y-6">

      {/* ── Dropzone ── */}
      <div
        {...getRootProps()}
        className={[
          'relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-8 py-12 cursor-pointer transition-colors',
          isDragActive
            ? 'border-indigo-500 bg-indigo-50'
            : dataset
            ? 'border-green-400 bg-green-50'
            : 'border-gray-300 hover:border-indigo-400 bg-white',
          uploading ? 'pointer-events-none' : '',
        ].join(' ')}
      >
        <input {...getInputProps()} />

        {/* Upload progress overlay */}
        {uploading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 rounded-xl">
            <div className="w-48 h-1.5 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-200 ${uploadProcessing ? 'bg-indigo-400 animate-pulse' : 'bg-indigo-600'}`}
                style={{ width: uploadProcessing ? '100%' : `${uploadProgress}%` }}
              />
            </div>
            <p className="mt-2 text-sm text-gray-500">
              {uploadProcessing ? 'Processing…' : `Uploading… ${uploadProgress}%`}
            </p>
          </div>
        )}

        {/* Clear dataset button — also resets config and encoding to defaults */}
        {dataset && !uploading && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); clearDataset() }}
            className="absolute top-3 right-3 p-1 rounded-full bg-red-100 hover:bg-red-200 text-red-600 transition-colors"
            title="Remove dataset and reset all parameters"
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        )}

        {dataset ? (
          <>
            <CheckCircleIcon className="w-10 h-10 text-green-500 mb-2" />
            <p className="font-semibold text-gray-800">{dataset.filename}</p>
            <p className="text-sm text-gray-500">{dataset.num_rows} rows — drop a new file to replace</p>
          </>
        ) : (
          <>
            <CloudArrowUpIcon className="w-12 h-12 text-gray-400 mb-3" />
            <p className="font-semibold text-gray-700 text-lg">
              {isDragActive ? 'Drop your dataset here' : 'Drag & drop your dataset'}
            </p>
            <p className="text-sm text-gray-500 mt-1">
              or click to browse — supports <code>.txt</code>, <code>.csv</code>, <code>.tsv</code>
            </p>
            <p className="text-xs text-gray-400 mt-3">
              File must contain a protein sequence column and a numeric activity column
            </p>
            <p className="text-xs text-gray-400 mt-1">
              Max file size: 10 MB
            </p>
          </>
        )}
      </div>

      {/* ── Sample dataset loader ── */}
      {!dataset && (
        <div className="text-center">
          <button
            onClick={() => setShowSamples((v) => !v)}
            className="inline-flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
          >
            <SparklesIcon className="w-4 h-4" />
            {showSamples ? 'Hide sample datasets' : 'Or try a sample dataset'}
          </button>

          {showSamples && (
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-left">
              {sampleList === null && (
                <p className="col-span-2 text-sm text-gray-400 text-center py-4">Loading…</p>
              )}
              {sampleList?.map((s) => {
                const isExpanded = previewSample === s.name
                return (
                  <div
                    key={s.name}
                    className="card p-3 text-left hover:border-indigo-300 hover:shadow-sm transition-all"
                  >
                    {/* Header row: name + load button */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-800 capitalize">{s.name}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{s.description}</p>
                        {s.num_rows && (
                          <p className="text-xs text-gray-400 mt-0.5">{s.num_rows} rows · {s.columns?.length ?? 0} columns</p>
                        )}
                      </div>
                      <button
                        onClick={() => handleLoadSample(s.name)}
                        disabled={loadingSample === s.name}
                        className="shrink-0 text-xs font-medium px-2.5 py-1 rounded-md bg-indigo-50 text-indigo-600 hover:bg-indigo-100 transition-colors disabled:opacity-50"
                      >
                        {loadingSample === s.name ? 'Loading…' : 'Use'}
                      </button>
                    </div>

                    {/* Preview toggle */}
                    {s.preview_rows?.length > 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setPreviewSample(isExpanded ? null : s.name)
                        }}
                        className="mt-2 inline-flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-700 font-medium transition-colors"
                      >
                        {isExpanded ? <ChevronUpIcon className="w-3.5 h-3.5" /> : <ChevronDownIcon className="w-3.5 h-3.5" />}
                        {isExpanded ? 'Hide preview' : 'Preview rows'}
                      </button>
                    )}

                    {/* Inline preview table */}
                    {isExpanded && s.preview_rows?.length > 0 && (
                      <div className="mt-2 overflow-x-auto rounded border border-gray-200">
                        <table className="w-full text-[11px] leading-tight">
                          <thead>
                            <tr className="bg-gray-50">
                              {s.columns.map((col) => (
                                <th key={col} className="px-2 py-1 text-left font-medium text-gray-600 whitespace-nowrap">
                                  {col}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {s.preview_rows.map((row, i) => (
                              <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}>
                                {s.columns.map((col) => {
                                  const val = String(row[col] ?? '')
                                  // Truncate long values (e.g. sequences)
                                  const display = val.length > 40 ? val.slice(0, 37) + '…' : val
                                  return (
                                    <td key={col} className="px-2 py-1 text-gray-700 whitespace-nowrap" title={val.length > 40 ? val : undefined}>
                                      {display}
                                    </td>
                                  )
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Backend unavailable error */}
      {backendUnavailable && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 text-red-700 text-sm">
          <XCircleIcon className="w-4 h-4 shrink-0" />
          <span>
            Dataset upload failed — check the backend is running.{' '}
            <button
              type="button"
              onClick={() => setShowBackendDialog(true)}
              className="underline font-medium hover:text-red-900 transition-colors"
            >
              How to install the backend
            </button>
          </span>
          <button
            type="button"
            onClick={() => setBackendUnavailable(false)}
            className="ml-auto p-0.5 rounded hover:bg-red-100 text-red-400 hover:text-red-700 transition-colors"
            title="Dismiss"
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Backend install dialog */}
      {showBackendDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowBackendDialog(false) }}
        >
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <ExclamationTriangleIcon className="w-5 h-5 text-amber-500 shrink-0" />
                <h2 className="text-base font-semibold text-gray-900">How to install the backend</h2>
              </div>
              <button
                type="button"
                onClick={() => setShowBackendDialog(false)}
                className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors shrink-0"
              >
                <XMarkIcon className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-gray-600">
              The pySAR API server could not be reached. Follow these steps to run it locally.
            </p>
            <div className="space-y-3 text-sm text-gray-800">
              <div>
                <p className="font-medium mb-1">1. Install dependencies</p>
                <pre className="bg-gray-100 rounded-lg px-3 py-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap">
{`cd pySAR_frontend/backend
pip install -r requirements.txt`}
                </pre>
              </div>
              <div>
                <p className="font-medium mb-1">2. Start the app <span className="font-normal text-gray-500">(recommended — starts backend + frontend together)</span></p>
                <pre className="bg-gray-100 rounded-lg px-3 py-2 text-xs font-mono overflow-x-auto">
{`cd pySAR_frontend
chmod +x start.sh && ./start.sh`}
                </pre>
              </div>
              <p className="text-gray-500 text-xs">
                Or start the backend only:{' '}
                <code className="bg-gray-100 rounded px-1 py-0.5 text-gray-800">uvicorn backend.main:app --reload --port 8000</code>
              </p>
            </div>
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() => setShowBackendDialog(false)}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 text-red-700 text-sm">
          <XCircleIcon className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* ── Upload skeleton — shown while upload/processing is in progress ── */}
      {uploading && (
        <div className="card p-5 space-y-4 animate-pulse">
          {/* Column mapping skeleton */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="h-3 w-32 bg-gray-200 rounded" />
              <div className="h-9 w-full bg-gray-100 rounded-lg" />
            </div>
            <div className="space-y-2">
              <div className="h-3 w-32 bg-gray-200 rounded" />
              <div className="h-9 w-full bg-gray-100 rounded-lg" />
            </div>
          </div>
          {/* Stats row skeleton */}
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 pt-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-14 bg-gray-100 rounded-xl" />
            ))}
          </div>
          {/* Preview table skeleton */}
          <div className="space-y-2 pt-2">
            <div className="h-3 w-24 bg-gray-200 rounded" />
            <div className="rounded-lg border border-gray-100 overflow-hidden">
              <div className="h-8 bg-gray-100" />
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className={`h-7 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Post-upload sections ── */}
      {dataset && (
        <>
          {/* Column mapping with confidence badges */}
          <div className="card p-5 space-y-4">
            <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
              <DocumentTextIcon className="w-4 h-4 text-indigo-500" />
              Column Mapping
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="label">
                  Sequence column *
                  {dataset.seq_col === dataset.seq_col_guess && (
                    <ConfidenceBadge level={dataset.seq_guess_confidence} />
                  )}
                </label>
                <select
                  className="input"
                  value={dataset.seq_col}
                  onChange={(e) => handleColChange('seq_col', e.target.value)}
                >
                  {dataset.columns.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">
                  Activity / target column *
                  {dataset.act_col === dataset.act_col_guess && (
                    <ConfidenceBadge level={dataset.act_guess_confidence} />
                  )}
                </label>
                <select
                  className="input"
                  value={dataset.act_col}
                  onChange={(e) => handleColChange('act_col', e.target.value)}
                >
                  {dataset.columns.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Stats cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {stats.map(({ label, value }) => (
              <div key={label} className="card p-3 text-center">
                <p className="text-lg font-bold text-indigo-600">{value}</p>
                <p className="text-xs text-gray-500 mt-0.5">{label}</p>
              </div>
            ))}
          </div>

          {/* Restore original data button — shown after any fix operation */}
          {originalDataset && (
            <div className="flex items-center gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2.5">
              <ArrowPathIcon className="w-4 h-4 text-indigo-500 shrink-0" />
              <p className="text-sm text-indigo-700 flex-1">Dataset has been modified from the original upload.</p>
              <button
                type="button"
                onClick={() => { setDataset(originalDataset); setOriginalDataset(null); toast.success('Restored original dataset') }}
                className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 border border-indigo-300 rounded-md px-3 py-1.5 hover:bg-indigo-100 transition-colors shrink-0"
              >
                Restore original
              </button>
            </div>
          )}

          {/* ── Data quality banners ── */}
          <div className="space-y-2">
            {/* Sequence validation — non-standard amino acid characters */}
            {dataset.seq_validation && !dataset.seq_validation.valid && !dismissedWarnings.has('seq') && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                <div className="flex items-start gap-2">
                  <ExclamationTriangleIcon className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">
                      {dataset.seq_validation.invalid_count} sequence{dataset.seq_validation.invalid_count !== 1 ? 's' : ''} contain non-standard amino acid characters
                    </p>
                    {dataset.seq_validation.warnings.map((w, i) => (
                      <p key={i} className="text-xs mt-0.5 font-mono">{w}</p>
                    ))}
                  </div>
                  {dataset.seq_validation.invalid_rows?.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setExpandedWarning(expandedWarning === 'seq' ? null : 'seq')}
                      className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-md bg-amber-100 hover:bg-amber-200 text-amber-800 transition-colors"
                    >
                      {expandedWarning === 'seq' ? <ChevronUpIcon className="w-3.5 h-3.5" /> : <ChevronDownIcon className="w-3.5 h-3.5" />}
                      View {dataset.seq_validation.invalid_rows.length} row{dataset.seq_validation.invalid_rows.length !== 1 ? 's' : ''}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setDismissedWarnings((prev) => new Set(prev).add('seq'))}
                    className="shrink-0 p-1 rounded hover:bg-amber-200 text-amber-500 hover:text-amber-800 transition-colors"
                    title="Dismiss warning"
                  >
                    <XMarkIcon className="w-4 h-4" />
                  </button>
                </div>
                {expandedWarning === 'seq' && (
                  <AffectedRowsTable
                    rows={dataset.seq_validation.invalid_rows}
                    columns={dataset.columns}
                    label={`${dataset.seq_validation.invalid_count} affected rows (showing up to 50)`}
                  />
                )}
              </div>
            )}

            {/* Duplicate sequences */}
            {dataset.duplicate_info?.has_duplicates && !dismissedWarnings.has('duplicate') && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                <div className="flex items-start gap-3">
                  <ExclamationTriangleIcon className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">
                      {dataset.duplicate_info.duplicate_count} duplicate sequence{dataset.duplicate_info.duplicate_count !== 1 ? 's' : ''} detected
                      <span className="font-normal ml-1">
                        ({dataset.duplicate_info.unique_count} unique of {dataset.num_rows} total)
                      </span>
                    </p>
                    <p className="text-xs mt-0.5">Duplicates can bias model evaluation — consider removing them.</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {dataset.duplicate_info.duplicate_rows?.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpandedWarning(expandedWarning === 'duplicate' ? null : 'duplicate')}
                        className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-md bg-amber-100 hover:bg-amber-200 text-amber-800 transition-colors"
                      >
                        {expandedWarning === 'duplicate' ? <ChevronUpIcon className="w-3.5 h-3.5" /> : <ChevronDownIcon className="w-3.5 h-3.5" />}
                        View {dataset.duplicate_info.duplicate_rows.length} row{dataset.duplicate_info.duplicate_rows.length !== 1 ? 's' : ''}
                      </button>
                    )}
                    <button
                      onClick={handleDeduplicate}
                      disabled={deduplicating}
                      className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-md bg-amber-100 hover:bg-amber-200 text-amber-800 disabled:opacity-60 transition-colors"
                    >
                      <ArrowPathIcon className={`w-3.5 h-3.5 ${deduplicating ? 'animate-spin' : ''}`} />
                      {deduplicating ? 'Deduplicating…' : 'Deduplicate'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDismissedWarnings((prev) => new Set(prev).add('duplicate'))}
                      className="p-1 rounded hover:bg-amber-200 text-amber-500 hover:text-amber-800 transition-colors"
                      title="Dismiss warning"
                    >
                      <XMarkIcon className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                {expandedWarning === 'duplicate' && (
                  <AffectedRowsTable
                    rows={dataset.duplicate_info.duplicate_rows}
                    columns={dataset.columns}
                    label={`${dataset.duplicate_info.duplicate_count} duplicate rows (showing up to 50)`}
                  />
                )}
              </div>
            )}

            {/* Missing values */}
            {dataset.missing_info?.has_missing && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <div className="flex items-start gap-2">
                  <XCircleIcon className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">Missing values detected</p>
                    {dataset.missing_info.seq_missing > 0 && (
                      <p className="text-xs mt-0.5">
                        Sequence column: {dataset.missing_info.seq_missing} empty/null cell{dataset.missing_info.seq_missing !== 1 ? 's' : ''}
                      </p>
                    )}
                    {dataset.missing_info.act_missing > 0 && (
                      <p className="text-xs mt-0.5">
                        Activity column: {dataset.missing_info.act_missing} empty/null cell{dataset.missing_info.act_missing !== 1 ? 's' : ''}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {/* Show combined affected rows button if either column has missing rows */}
                    {((dataset.missing_info.seq_missing_rows?.length > 0) || (dataset.missing_info.act_missing_rows?.length > 0)) && (
                      <button
                        type="button"
                        onClick={() => setExpandedWarning(expandedWarning === 'missing' ? null : 'missing')}
                        className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-md bg-red-100 hover:bg-red-200 text-red-800 transition-colors"
                      >
                        {expandedWarning === 'missing' ? <ChevronUpIcon className="w-3.5 h-3.5" /> : <ChevronDownIcon className="w-3.5 h-3.5" />}
                        View rows
                      </button>
                    )}
                    {/* Fix button — only shown when activity column has missing values */}
                    {dataset.missing_info.act_missing > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowActFixOptions((v) => !v)}
                        className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-md bg-red-100 hover:bg-red-200 text-red-800 transition-colors"
                      >
                        {showActFixOptions ? <ChevronUpIcon className="w-3.5 h-3.5" /> : <ChevronDownIcon className="w-3.5 h-3.5" />}
                        Fix activity
                      </button>
                    )}
                  </div>
                </div>

                {/* Activity fix options — impute mean, impute median, or remove rows */}
                {showActFixOptions && dataset.missing_info.act_missing > 0 && (
                  <div className="mt-3 p-3 rounded-lg bg-red-100/60 border border-red-200">
                    <p className="text-xs font-medium text-red-800 mb-2">
                      Choose how to handle {dataset.missing_info.act_missing} missing activity value{dataset.missing_info.act_missing !== 1 ? 's' : ''}:
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {/* Apply mean */}
                      <button
                        type="button"
                        onClick={() => handleFixMissingActivity('mean')}
                        disabled={!!fixingOp}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md bg-white border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50 transition-colors"
                      >
                        <ArrowPathIcon className={`w-3.5 h-3.5 ${fixingOp === 'act-mean' ? 'animate-spin' : ''}`} />
                        {fixingOp === 'act-mean' ? 'Applying…' : `Impute mean (${dataset.activity_stats?.mean ?? '…'})`}
                      </button>
                      {/* Apply median */}
                      <button
                        type="button"
                        onClick={() => handleFixMissingActivity('median')}
                        disabled={!!fixingOp}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md bg-white border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50 transition-colors"
                      >
                        <ArrowPathIcon className={`w-3.5 h-3.5 ${fixingOp === 'act-median' ? 'animate-spin' : ''}`} />
                        {fixingOp === 'act-median' ? 'Applying…' : 'Impute median'}
                      </button>
                      {/* Remove rows */}
                      <button
                        type="button"
                        onClick={() => handleFixMissingActivity('remove')}
                        disabled={!!fixingOp}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md bg-white border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50 transition-colors"
                      >
                        <XMarkIcon className={`w-3.5 h-3.5`} />
                        {fixingOp === 'act-remove' ? 'Removing…' : 'Remove affected rows'}
                      </button>
                    </div>
                  </div>
                )}

                {expandedWarning === 'missing' && (
                  <div className="space-y-2 mt-2">
                    {dataset.missing_info.seq_missing_rows?.length > 0 && (
                      <AffectedRowsTable
                        rows={dataset.missing_info.seq_missing_rows}
                        columns={dataset.columns}
                        label={`${dataset.missing_info.seq_missing} rows with missing sequence values`}
                      />
                    )}
                    {dataset.missing_info.act_missing_rows?.length > 0 && (
                      <AffectedRowsTable
                        rows={dataset.missing_info.act_missing_rows}
                        columns={dataset.columns}
                        label={`${dataset.missing_info.act_missing} rows with missing activity values`}
                      />
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Outliers */}
            {dataset.outlier_info?.outlier_count > 0 && !dismissedWarnings.has('outlier') && (
              <div className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-700">
                <div className="flex items-start gap-2">
                  <ExclamationTriangleIcon className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">
                      {dataset.outlier_info.outlier_count} outlier{dataset.outlier_info.outlier_count !== 1 ? 's' : ''}{' '}
                      detected (&gt;3σ from mean)
                    </p>
                    <p className="text-xs mt-0.5">
                      Mean {dataset.outlier_info.mean}, ±{dataset.outlier_info.threshold_delta} threshold.
                      Outlier values: {dataset.outlier_info.outlier_values.slice(0, 5).join(', ')}
                      {dataset.outlier_info.outlier_values.length > 5 ? '…' : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {dataset.outlier_info.outlier_rows?.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpandedWarning(expandedWarning === 'outlier' ? null : 'outlier')}
                        className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-md bg-orange-100 hover:bg-orange-200 text-orange-800 transition-colors"
                      >
                        {expandedWarning === 'outlier' ? <ChevronUpIcon className="w-3.5 h-3.5" /> : <ChevronDownIcon className="w-3.5 h-3.5" />}
                        View {dataset.outlier_info.outlier_rows.length} row{dataset.outlier_info.outlier_rows.length !== 1 ? 's' : ''}
                      </button>
                    )}
                    {/* Toggle fix options */}
                    <button
                      type="button"
                      onClick={() => setShowOutlierFixOptions((v) => !v)}
                      className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-md bg-orange-100 hover:bg-orange-200 text-orange-800 transition-colors"
                    >
                      {showOutlierFixOptions ? <ChevronUpIcon className="w-3.5 h-3.5" /> : <ChevronDownIcon className="w-3.5 h-3.5" />}
                      Fix outliers
                    </button>
                    <button
                      type="button"
                      onClick={() => setDismissedWarnings((prev) => new Set(prev).add('outlier'))}
                      className="p-1 rounded hover:bg-orange-200 text-orange-500 hover:text-orange-800 transition-colors"
                      title="Dismiss warning"
                    >
                      <XMarkIcon className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Fix options panel */}
                {showOutlierFixOptions && (
                  <div className="mt-3 p-3 rounded-lg bg-orange-100/60 border border-orange-200">
                    <p className="text-xs font-medium text-orange-800 mb-2">
                      Choose how to handle {dataset.outlier_info.outlier_count} outlier{dataset.outlier_info.outlier_count !== 1 ? 's' : ''}:
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {/* Winsorize: clamp values to the ±3σ boundary */}
                      <button
                        type="button"
                        onClick={() => handleFixOutliers('winsorize')}
                        disabled={!!fixingOp}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md bg-white border border-orange-300 text-orange-700 hover:bg-orange-50 disabled:opacity-50 transition-colors"
                      >
                        <ArrowPathIcon className={`w-3.5 h-3.5 ${fixingOp === 'outlier-winsorize' ? 'animate-spin' : ''}`} />
                        {fixingOp === 'outlier-winsorize' ? 'Applying…' : 'Winsorize (clamp to ±3σ)'}
                      </button>
                      {/* Impute mean: replace outlier values with the column mean */}
                      <button
                        type="button"
                        onClick={() => handleFixOutliers('mean')}
                        disabled={!!fixingOp}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md bg-white border border-orange-300 text-orange-700 hover:bg-orange-50 disabled:opacity-50 transition-colors"
                      >
                        <ArrowPathIcon className={`w-3.5 h-3.5 ${fixingOp === 'outlier-mean' ? 'animate-spin' : ''}`} />
                        {fixingOp === 'outlier-mean' ? 'Applying…' : `Impute mean (${dataset.outlier_info.mean ?? dataset.activity_stats?.mean ?? '…'})`}
                      </button>
                      {/* Remove: drop outlier rows entirely */}
                      <button
                        type="button"
                        onClick={() => handleFixOutliers('remove')}
                        disabled={!!fixingOp}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md bg-white border border-orange-300 text-orange-700 hover:bg-orange-50 disabled:opacity-50 transition-colors"
                      >
                        <XMarkIcon className="w-3.5 h-3.5" />
                        {fixingOp === 'outlier-remove' ? 'Removing…' : 'Remove affected rows'}
                      </button>
                    </div>
                  </div>
                )}

                {expandedWarning === 'outlier' && (
                  <AffectedRowsTable
                    rows={dataset.outlier_info.outlier_rows}
                    columns={dataset.columns}
                    label={`${dataset.outlier_info.outlier_count} outlier rows (showing up to 50)`}
                  />
                )}
              </div>
            )}
          </div>

          {/* ── Charts: sequence length + activity distribution ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

            {/* Sequence length histogram */}
            {dataset.length_stats?.distribution?.length > 0 && (
              <div className="card p-4">
                <h3 className="text-sm font-semibold text-gray-700 mb-3">
                  Sequence Length Distribution
                  <span className="ml-2 text-xs font-normal text-gray-400">
                    mean {dataset.length_stats.mean}
                  </span>
                </h3>
                <ResponsiveContainer width="100%" height={140}>
                  <BarChart data={dataset.length_stats.distribution} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis dataKey="bin" tick={{ fontSize: 9 }} tickFormatter={(v) => Math.round(v)} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 9 }} width={28} />
                    <Tooltip formatter={(v) => [v, 'count']} labelFormatter={(l) => `~${Math.round(l)} aa`} />
                    <Bar dataKey="count" fill="#10b981" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Activity distribution histogram */}
            {actHistData?.length > 0 && (
              <div className="card p-4">
                {/* Header row: title + log toggle */}
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-sm font-semibold text-gray-700">
                    Activity Distribution
                    <span className="ml-2 text-xs font-normal text-gray-400">
                      mean {dataset.activity_stats.mean} · std {dataset.activity_stats.std}
                    </span>
                  </h3>
                  {dataset.activity_stats?.log_histogram?.length > 0 && (
                    <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        className="rounded"
                        checked={logTransform}
                        onChange={(e) => setLogTransform(e.target.checked)}
                      />
                      log1p scale
                    </label>
                  )}
                </div>
                {/* Skewness note */}
                {skewInfo && (
                  <p className={`text-xs mb-2 ${skewInfo.colour}`}>{skewInfo.label}</p>
                )}
                <ResponsiveContainer width="100%" height={140}>
                  <BarChart data={actHistData} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis dataKey="bin" tick={{ fontSize: 9 }} tickFormatter={(v) => Number(v).toFixed(2)} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 9 }} width={28} />
                    <Tooltip formatter={(v) => [v, 'count']} labelFormatter={(l) => `~${Number(l).toFixed(3)}`} />
                    <Bar dataKey="count" fill="#6366f1" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Preview table */}
          <DatasetPreview
            rows={dataset.preview}
            columns={dataset.columns}
            seqCol={dataset.seq_col}
            actCol={dataset.act_col}
            fileId={dataset.file_id}
            totalRows={dataset.num_rows}
          />

          {/* Proceed button */}
          <div className="flex justify-end">
            <button
              className="btn-primary"
              disabled={!canProceed}
              onClick={() => setStep(2)}
            >
              Continue to Configure
              <ArrowRightIcon className="w-4 h-4" />
            </button>
          </div>
        </>
      )}
    </div>
  )
}


