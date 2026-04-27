import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
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
import ResultsCharts, { PredictedActualChart } from '../components/ResultsCharts'
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
  const { results, resultColumns, setStep, job, encoding, setEncoding, jobHistory, config, dataset } = useAppStore()

  // ── Tab navigation ────────────────────────────────────────────────────────
  const [tab, setTab] = useState('table')

  // ── Table state ───────────────────────────────────────────────────────────
  const [sortCol, setSortCol]       = useState('R2')
  const [sortDir, setSortDir]       = useState('desc')
  const [filterText, setFilterText] = useState('')
  const [filterTextDebounced, setFilterTextDebounced] = useState('')
  const [page, setPage]             = useState(0)
  const PAGE_SIZE = 50

  // ── Debounce filterText → filterTextDebounced (150 ms) ────────────────────
  useEffect(() => {
    const timer = setTimeout(() => setFilterTextDebounced(filterText), 150)
    return () => clearTimeout(timer)
  }, [filterText])

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

  // ── PDF export options modal ──────────────────────────────────────────────
  const [isPdfCapturing, setIsPdfCapturing] = useState(false) // true while chart SVGs are being captured
  const [showPdfModal, setShowPdfModal] = useState(false)
  const [pdfOptions, setPdfOptions] = useState({
    allResults:      false, // export every row (default: top N only)
    topN:            10,    // how many rows when allResults=false
    includeCharts:   true,  // include charts in appendix
    includeStats:    true,  // include descriptive statistics table
    includeDataset:  true,  // include dataset summary section
    includeEncoding: true,  // include encoding parameters section
    includeSnapshot: true,  // include brief config snapshot section
    includeAppendix: true,  // include full config appendix
  })
  // Toggle a boolean pdf option by key
  const togglePdfOpt = (key) => setPdfOptions((o) => ({ ...o, [key]: !o[key] }))

  // ── Visible columns (excluding hidden) ───────────────────────────────────
  const visibleCols = useMemo(
    () => (resultColumns ?? []).filter((c) => !hiddenCols.has(c)),
    [resultColumns, hiddenCols]
  )

  // ── Sorted + filtered + threshold rows ───────────────────────────────────
  const rows = useMemo(() => {
    if (!results) return []
    let data = [...results]

    // Text filter (debounced to avoid re-running on every keystroke)
    if (filterTextDebounced.trim()) {
      const q = filterTextDebounced.toLowerCase()
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
  }, [results, sortCol, sortDir, filterTextDebounced, thresholds])

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
      // Use sample std dev (n-1) rather than population std dev
      const std  = vals.length > 1
        ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1))
        : 0
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

  async function handleExportExcel() {
    if (!results?.length || !resultColumns?.length) return
    // Lazy-import xlsx so it is not included in the initial bundle
    const XLSX = await import('xlsx')
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

  // ── PDF report export — captures summary, best model, top-N table, and config ──
  async function handleExportPDF(opts = pdfOptions) {
    toast.loading('Generating PDF…', { id: 'pdf' })
    // Hoisted so the finally block can restore state even if an error is thrown mid-export
    let _captureActive = false
    const _prevTab = tab
    try {
      const [{ default: jsPDF }] = await Promise.all([
        import('jspdf'),
      ])

      const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
      const pageW = doc.internal.pageSize.getWidth()
      const pageH = doc.internal.pageSize.getHeight()
      const margin = 14
      const contentW = pageW - margin * 2
      let y = margin

      // ── Helper: add a section heading ──────────────────────────────────────
      function heading(text) {
        doc.setFontSize(11)
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(79, 70, 229) // indigo-600
        doc.text(text, margin, y)
        y += 6
        doc.setDrawColor(200, 200, 255)
        doc.setLineWidth(0.3)
        doc.line(margin, y, margin + contentW, y)
        y += 4
      }

      // ── Helper: add key-value row ──────────────────────────────────────────
      function kv(label, value) {
        doc.setFontSize(9)
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(80, 80, 80)
        doc.text(`${label}:`, margin, y)
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(30, 30, 30)
        doc.text(String(value ?? '—'), margin + 40, y)
        y += 5
      }

      // ── Helper: maybe add a new page ───────────────────────────────────────
      function checkPage(needed = 20) {
        if (y + needed > pageH - margin) { doc.addPage(); y = margin }
      }

      // ── Page 1: Title ──────────────────────────────────────────────────────
      doc.setFontSize(18)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(30, 30, 30)
      doc.text('pySAR Encoding Report', margin, y)
      y += 8
      doc.setFontSize(9)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(120, 120, 120)
      doc.text(`Generated ${new Date().toLocaleString()}`, margin, y)
      y += 10

      // ── Job metadata ───────────────────────────────────────────────────────
      heading('Job Summary')
      kv('Job ID',    job?.job_id?.slice(0, 16) ?? '—')
      kv('Strategy',  job?.strategy ?? '—')
      kv('Algorithm', job?.algorithm ?? '—')
      kv('Models',    results?.length ?? 0)
      y += 4

      // ── Dataset summary (optional) ─────────────────────────────────────────
      if (opts.includeDataset && dataset) {
        checkPage(30)
        heading('Dataset Summary')
        kv('File',          dataset.filename ?? '—')
        kv('Rows',          dataset.num_rows ?? '—')
        kv('Columns',       (dataset.columns ?? []).length)
        kv('Sequence col',  dataset.seq_col ?? '—')
        kv('Activity col',  dataset.act_col ?? '—')
        if (dataset.length_stats) {
          kv('Seq len (mean)', dataset.length_stats.mean?.toFixed(1) ?? '—')
          kv('Seq len (range)', `${dataset.length_stats.min ?? '?'} – ${dataset.length_stats.max ?? '?'}`)
        }
        if (dataset.activity_stats) {
          kv('Activity mean', dataset.activity_stats.mean?.toFixed(4) ?? '—')
          kv('Activity std',  dataset.activity_stats.std?.toFixed(4)  ?? '—')
        }
        y += 4
      }

      // ── Best model ─────────────────────────────────────────────────────────
      if (best) {
        heading('Best Model')
        kv('Model',         modelId(best, resultColumns ?? []))
        METRIC_COLS.filter((m) => best[m] != null).forEach((m) => {
          kv(m, typeof best[m] === 'number' ? best[m].toFixed(4) : best[m])
        })
        y += 4
      }

      // ── Results table (all rows or top-N depending on opts) ─────────────────
      checkPage(40)
      const tableLimit = opts.allResults ? (results?.length ?? 0) : opts.topN
      heading(opts.allResults ? `All ${results?.length ?? 0} Results` : `Top ${opts.topN} Results`)
      const tableCols = (resultColumns ?? []).slice(0, 7) // cap columns to fit page
      const tableRows = (results ?? []).slice(0, tableLimit)

      // Give the identifier (non-metric) column proportionally more space so
      // long descriptor names are not cut off. Metric columns share the remainder equally.
      const identifierIdx = tableCols.findIndex((c) => !METRIC_COLS.includes(c) && c !== 'Rank_Pct')
      const metricCount   = tableCols.length - (identifierIdx >= 0 ? 1 : 0)
      const identifierW   = identifierIdx >= 0 ? Math.min(contentW * 0.42, 72) : 0
      const metricW       = metricCount > 0 ? (contentW - identifierW) / metricCount : contentW / tableCols.length
      const colWidths     = tableCols.map((_, ci) => ci === identifierIdx ? identifierW : metricW)
      // Pre-compute cumulative x offsets for each column
      const colX = tableCols.map((_, ci) => margin + colWidths.slice(0, ci).reduce((s, w) => s + w, 0))

      // Table header
      doc.setFontSize(8)
      doc.setFont('helvetica', 'bold')
      doc.setFillColor(238, 238, 253) // indigo-50
      doc.rect(margin, y, contentW, 6, 'F')
      tableCols.forEach((col, ci) => {
        doc.setTextColor(79, 70, 229)
        // Truncate header to fit its column width
        const headerTxt = doc.splitTextToSize(col, colWidths[ci] - 2)[0]
        doc.text(headerTxt, colX[ci] + 1, y + 4.5)
      })
      y += 6

      // Table rows
      doc.setFont('helvetica', 'normal')
      tableRows.forEach((row, ri) => {
        checkPage(6)
        if (ri % 2 === 0) {
          doc.setFillColor(249, 249, 249)
          doc.rect(margin, y, contentW, 5.5, 'F')
        }
        tableCols.forEach((col, ci) => {
          const val = row[col]
          const txt = typeof val === 'number' ? val.toFixed(4) : String(val ?? '')
          doc.setTextColor(30, 30, 30)
          doc.setFontSize(7.5)
          // Use splitTextToSize so the cell width — not a fixed char count — governs truncation
          const cellTxt = doc.splitTextToSize(txt, colWidths[ci] - 2)[0]
          doc.text(cellTxt, colX[ci] + 1, y + 4)
        })
        y += 5.5
      })
      y += 6

      // ── Descriptive statistics table (optional) ────────────────────────────
      if (opts.includeStats && statsTable.length > 0) {
        checkPage(40)
        heading('Descriptive Statistics')
        const statCols = ['Metric', 'Count', 'Mean', 'Std', 'Min', 'P25', 'Median', 'P75', 'Max']
        const statKeys = ['metric', 'count', 'mean', 'std', 'min', 'p25', 'median', 'p75', 'max']
        const sColW = contentW / statCols.length
        doc.setFontSize(7.5)
        doc.setFont('helvetica', 'bold')
        doc.setFillColor(238, 238, 253)
        doc.rect(margin, y, contentW, 6, 'F')
        statCols.forEach((col, ci) => {
          doc.setTextColor(79, 70, 229)
          doc.text(col, margin + ci * sColW + 1, y + 4.5)
        })
        y += 6
        doc.setFont('helvetica', 'normal')
        statsTable.forEach((row, ri) => {
          checkPage(6)
          if (ri % 2 === 0) { doc.setFillColor(249, 249, 249); doc.rect(margin, y, contentW, 5.5, 'F') }
          statKeys.forEach((key, ci) => {
            doc.setTextColor(30, 30, 30)
            doc.setFontSize(7.5)
            doc.text(String(row[key] ?? '—'), margin + ci * sColW + 1, y + 4)
          })
          y += 5.5
        })
        y += 6
      }

      // ── Config snapshot (optional) ──────────────────────────────────────────
      if (opts.includeSnapshot) {
        checkPage(40)
        heading('Config Snapshot')
        const m = config?.model ?? {}
        kv('Algorithm',  m.algorithm)
        kv('Test split', m.test_split)
        kv('CV',         m.use_cv ? `${m.cv_folds}-fold` : 'holdout')
        kv('DSP',        config?.pyDSP?.use_dsp ? `${config.pyDSP.spectrum} / ${config.pyDSP.window?.type}` : 'disabled')
        y += 4
      }

      // ── Encoding parameters (optional) ─────────────────────────────────────
      if (opts.includeEncoding && encoding) {
        checkPage(40)
        heading('Encoding Parameters')
        kv('Strategy',    encoding.strategy ?? '—')
        kv('Sort by',     encoding.sort_by ?? '—')
        kv('Desc combo',  encoding.desc_combo ?? '—')
        kv('n_jobs',      encoding.n_jobs ?? '—')
        kv('Max models',  encoding.max_models || 'unlimited')
        kv('Sample mode', encoding.sample_mode ? 'yes' : 'no')
        kv('Random seed', encoding.random_state || 'none')
        // AAI indices — potentially long, so wrap
        doc.setFontSize(9)
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(80, 80, 80)
        doc.text('AAI indices:', margin, y)
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(30, 30, 30)
        const idxList = (encoding.aai_indices ?? []).length ? encoding.aai_indices.join(', ') : 'all'
        const idxLines = doc.splitTextToSize(idxList, contentW - 40)
        doc.text(idxLines, margin + 40, y)
        y += 4.5 * idxLines.length
        // Descriptors
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(80, 80, 80)
        doc.text('Descriptors:', margin, y)
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(30, 30, 30)
        const descList = (encoding.selected_descriptors ?? []).length ? encoding.selected_descriptors.join(', ') : 'all'
        const descLines = doc.splitTextToSize(descList, contentW - 40)
        doc.text(descLines, margin + 40, y)
        y += 4.5 * descLines.length + 4
      }

      // ── Appendix (charts and/or full config — both optional) ──────────────
      const showAppendix = opts.includeCharts || opts.includeAppendix
      if (showAppendix) {
        doc.addPage()
        y = margin
        heading('Appendix')
      }

      // ── A.1 Charts (optional) ─────────────────────────────────────────────
      let appendixIdx = 1 // section counter for A.1, A.2 …
      if (opts.includeCharts) {
        // Disable Recharts entry animations so charts render at their final state immediately.
        _captureActive = true
        setIsPdfCapturing(true)
        // Switch to the charts tab so the SVGs are mounted in the DOM.
        setTab('charts')

        // Poll until Recharts has fully rendered data into every recharts-surface SVG.
        // ResponsiveContainer measures its container after mount (async). We wait until:
        //  - SVGs have a non-zero width attribute (ResponsiveContainer has measured)
        //  - SVGs contain drawn shapes (path[d] or rect with positive height/width)
        // Animations are already disabled via isAnimationActive={false}, so shapes
        // appear at their final state on the very first render after measurement.
        await new Promise((resolve) => {
          const deadline = Date.now() + 5000
          const check = () => {
            const section = document.getElementById('results-charts-section')
            if (!section) { requestAnimationFrame(check); return }
            const svgs = Array.from(section.querySelectorAll('svg.recharts-surface'))
            const allReady = svgs.length > 0 && svgs.every((svg) => {
              // Ensure ResponsiveContainer has given the SVG real dimensions
              const svgW = parseFloat(svg.getAttribute('width')) || 0
              if (svgW <= 0) return false
              // Ensure data has been drawn: paths (line/scatter/pie) or rects (bars)
              const hasPaths = svg.querySelectorAll('path[d]').length > 0
              const hasRects = Array.from(svg.querySelectorAll('rect')).some(
                (r) => parseFloat(r.getAttribute('height')) > 0
              )
              return hasPaths || hasRects
            })
            if (allReady || Date.now() > deadline) resolve()
            else requestAnimationFrame(check)
          }
          requestAnimationFrame(check)
        })

        const chartsEl = document.getElementById('results-charts-section')
        if (chartsEl) {
          checkPage(20)
          doc.setFontSize(9.5)
          doc.setFont('helvetica', 'bold')
          doc.setTextColor(60, 60, 60)
          doc.text(`A.${appendixIdx}  Charts`, margin, y)
          appendixIdx += 1
          y += 7

          // Serialize each SVG element to a canvas.
          // html2canvas cannot reliably capture Recharts SVGs — use the native
          // SVG serialization approach instead (same as the per-chart PNG export).
          const svgToCanvas = (svgEl) => new Promise((resolve) => {
            // Prefer the Recharts-set width/height attributes over getBoundingClientRect,
            // since BoundingClientRect can be unreliable when elements are obscured by the modal.
            const w = parseInt(svgEl.getAttribute('width'))  || Math.round(svgEl.getBoundingClientRect().width)  || 800
            const h = parseInt(svgEl.getAttribute('height')) || Math.round(svgEl.getBoundingClientRect().height) || 400
            const clone = svgEl.cloneNode(true)
            clone.setAttribute('width',  w)
            clone.setAttribute('height', h)
            clone.setAttribute('style',  'background:#fff')
            const svgStr = new XMLSerializer().serializeToString(clone)
            const blob   = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' })
            const url    = URL.createObjectURL(blob)
            const img    = new Image()
            img.onload = () => {
              const scale  = 2
              const canvas = document.createElement('canvas')
              canvas.width  = w * scale
              canvas.height = h * scale
              const ctx = canvas.getContext('2d')
              ctx.fillStyle = '#ffffff'
              ctx.fillRect(0, 0, canvas.width, canvas.height)
              ctx.scale(scale, scale)
              ctx.drawImage(img, 0, 0, w, h)
              URL.revokeObjectURL(url)
              resolve(canvas)
            }
            img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
            img.src = url
          })

          // Iterate over each chart card: add title then SVG image to PDF
          const cards = Array.from(chartsEl.querySelectorAll('.card'))
          for (const card of cards) {
            const titleEl = card.querySelector('h3')
            // Target the Recharts SVG specifically (class="recharts-surface"),
            // not the icon SVGs in the export dropdown button.
            const svgEl   = card.querySelector('svg.recharts-surface')
            if (!svgEl) continue
            const canvas  = await svgToCanvas(svgEl)
            if (!canvas) continue
            const imgH    = (canvas.height / canvas.width) * contentW
            checkPage(imgH + 12)
            // Chart title
            if (titleEl?.textContent?.trim()) {
              doc.setFontSize(8.5)
              doc.setFont('helvetica', 'bold')
              doc.setTextColor(80, 80, 80)
              doc.text(titleEl.textContent.trim(), margin, y)
              y += 5
            }
            doc.addImage(canvas.toDataURL('image/png'), 'PNG', margin, y, contentW, imgH)
            y += imgH + 6
          }
        }
        // Restore the tab the user was on before export and re-enable animations
        setIsPdfCapturing(false)
        setTab(_prevTab)
        _captureActive = false
        y += 6
      }

      // ── A.N Full configuration parameters (optional) ──────────────────────
      if (opts.includeAppendix) {
        // Always start config on a fresh page, even if space remains after charts
        doc.addPage()
        y = margin
        doc.setFontSize(9.5)
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(60, 60, 60)
        doc.text(`A.${appendixIdx}  Full Configuration`, margin, y)
        y += 7

      // Helper: render a labelled subsection of flat key→value pairs
      function configSection(label, obj) {
        if (!obj || typeof obj !== 'object') return
        checkPage(14)
        doc.setFontSize(9)
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(60, 60, 60)
        doc.text(label, margin, y)
        y += 5
        doc.setFontSize(8)
        doc.setFont('helvetica', 'normal')
        Object.entries(obj).forEach(([k, v]) => {
          checkPage(5)
          const valStr = v === null || v === undefined
            ? '—'
            : Array.isArray(v)
              ? (v.length === 0 ? '[]' : v.join(', '))
              : typeof v === 'object'
                ? JSON.stringify(v)
                : String(v)
          doc.setTextColor(100, 100, 100)
          doc.text(`${k}:`, margin + 2, y)
          doc.setTextColor(30, 30, 30)
          const lines = doc.splitTextToSize(valStr, contentW - 44)
          doc.text(lines, margin + 44, y)
          y += 4.5 * lines.length
        })
        y += 3
      }

      const cfg = config ?? {}
      configSection('Model', cfg.model)
      configSection('DSP', cfg.pyDSP)

      // Descriptors — one indented block per descriptor
      const descs = cfg.descriptors ?? {}
      if (Object.keys(descs).length > 0) {
        checkPage(14)
        doc.setFontSize(9)
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(60, 60, 60)
        doc.text('Descriptors', margin, y)
        y += 5
        Object.entries(descs).forEach(([name, params]) => {
          if (!params || typeof params !== 'object') return
          checkPage(10)
          doc.setFontSize(8)
          doc.setFont('helvetica', 'bold')
          doc.setTextColor(79, 70, 229)
          doc.text(name, margin + 2, y)
          y += 4.5
          doc.setFont('helvetica', 'normal')
          Object.entries(params).forEach(([k, v]) => {
            checkPage(5)
            const valStr = v === null || v === undefined
              ? '—'
              : Array.isArray(v)
                ? (v.length === 0 ? '[]' : v.join(', '))
                : String(v)
            doc.setTextColor(100, 100, 100)
            doc.text(`${k}:`, margin + 6, y)
            doc.setTextColor(30, 30, 30)
            const lines = doc.splitTextToSize(valStr, contentW - 50)
            doc.text(lines, margin + 50, y)
            y += 4.5 * lines.length
          })
          y += 2
        })
      }
      } // end if (opts.includeAppendix)

      doc.save(`pysar_report_${new Date().toISOString().slice(0, 10)}.pdf`)
      toast.success('PDF saved', { id: 'pdf' })
    } catch (err) {
      console.error('PDF export failed:', err)
      toast.error('PDF export failed — see console for details', { id: 'pdf' })
    } finally {
      // Always restore chart tab and re-enable animations, even if the export threw
      if (_captureActive) {
        setIsPdfCapturing(false)
        setTab(_prevTab)
      }
    }
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
                {job?.algorithm && (
                  <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                    {job.algorithm}
                  </span>
                )}
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
          <button className="btn-secondary text-xs" onClick={() => setShowPdfModal(true)} title="Customise and download PDF report">
            <ArrowDownTrayIcon className="w-3.5 h-3.5" /> PDF Report
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
                  className="input text-xs w-56 !pl-8"
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
      {tab === 'charts' && (
        <div id="results-charts-section" className="space-y-5">
          {/* Predicted vs Actual — shown when backend returns best-model predictions */}
          {job?.best_model_predictions?.actual?.length > 0 && (
            <PredictedActualChart predictions={job.best_model_predictions} disableAnimation={isPdfCapturing} />
          )}
          <ResultsCharts rows={rows} columns={resultColumns} disableAnimation={isPdfCapturing} />
        </div>
      )}

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
                      {typeof val === 'number' ? val.toFixed(METRIC_COLS.includes(col) ? 4 : 6) : (val ?? '—')}
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

      {/* ── PDF export options modal ── */}
      {showPdfModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowPdfModal(false)} />
          <div className="relative bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-6 w-full max-w-md mx-4">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-bold text-gray-900 dark:text-white">PDF Export Options</h2>
              <button onClick={() => setShowPdfModal(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                <XMarkIcon className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">

              {/* Results rows */}
              <div>
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Results Table</p>
                <label className="flex items-start gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-indigo-600"
                    checked={pdfOptions.allResults}
                    onChange={() => togglePdfOpt('allResults')}
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">
                    <span className="font-medium">Export all encoding results</span>
                    {results?.length != null && (
                      <span className="ml-1.5 px-1.5 py-0.5 rounded text-xs font-medium bg-indigo-50 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300">
                        {results.length.toLocaleString()}
                      </span>
                    )}
                    <span className="text-gray-400 dark:text-gray-500 ml-1">(default: top {pdfOptions.topN} only)</span>
                  </span>
                </label>
                {!pdfOptions.allResults && (
                  <div className="mt-2 ml-7 flex items-center gap-2">
                    <span className="text-xs text-gray-500 dark:text-gray-400">Show top</span>
                    {[10, 25, 50].map((n) => (
                      <button
                        key={n}
                        onClick={() => setPdfOptions((o) => ({ ...o, topN: n }))}
                        className={`px-2.5 py-0.5 rounded text-xs font-medium border transition-colors ${
                          pdfOptions.topN === n
                            ? 'bg-indigo-600 border-indigo-600 text-white'
                            : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-indigo-400'
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Appendix items */}
              <div>
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Appendix</p>
                <div className="space-y-2">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-indigo-600"
                      checked={pdfOptions.includeCharts}
                      onChange={() => togglePdfOpt('includeCharts')}
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">
                      <span className="font-medium">Include result charts</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-indigo-600"
                      checked={pdfOptions.includeAppendix}
                      onChange={() => togglePdfOpt('includeAppendix')}
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">
                      <span className="font-medium">Include full config parameters</span>
                    </span>
                  </label>
                </div>
              </div>

              {/* Main body options */}
              <div>
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Sections</p>
                <div className="space-y-2">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-indigo-600"
                      checked={pdfOptions.includeDataset}
                      onChange={() => togglePdfOpt('includeDataset')}
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">
                      <span className="font-medium">Include dataset summary</span>
                      <span className="text-gray-400 dark:text-gray-500 ml-1">(filename, rows, columns, activity stats)</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-indigo-600"
                      checked={pdfOptions.includeStats}
                      onChange={() => togglePdfOpt('includeStats')}
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">
                      <span className="font-medium">Include descriptive statistics</span>
                      <span className="text-gray-400 dark:text-gray-500 ml-1">(mean, std, min, P25, median, P75, max per metric)</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-indigo-600"
                      checked={pdfOptions.includeEncoding}
                      onChange={() => togglePdfOpt('includeEncoding')}
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">
                      <span className="font-medium">Include encoding parameters</span>
                      <span className="text-gray-400 dark:text-gray-500 ml-1">(strategy, indices, descriptors, seed)</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-indigo-600"
                      checked={pdfOptions.includeSnapshot}
                      onChange={() => togglePdfOpt('includeSnapshot')}
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">
                      <span className="font-medium">Include config snapshot</span>
                      <span className="text-gray-400 dark:text-gray-500 ml-1">(brief summary: algorithm, CV, DSP)</span>
                    </span>
                  </label>
                </div>
              </div>

            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 mt-6">
              <button className="btn-secondary text-sm" onClick={() => setShowPdfModal(false)}>Cancel</button>
              <button
                className="btn-primary text-sm"
                onClick={() => { setShowPdfModal(false); handleExportPDF(pdfOptions) }}
              >
                <ArrowDownTrayIcon className="w-4 h-4" /> Generate PDF
              </button>
            </div>
          </div>
        </div>
      )}
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

