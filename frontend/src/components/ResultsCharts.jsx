import { useState, useMemo, useRef, useCallback } from 'react'
import {
  ResponsiveContainer,
  BarChart, Bar,
  XAxis, YAxis,
  CartesianGrid, Tooltip,
  Cell,
  PieChart, Pie, Legend,
  ScatterChart, Scatter, ZAxis,
} from 'recharts'
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline'

const METRIC_COLS = ['R2', 'RMSE', 'MSE', 'MAE', 'RPD', 'Explained_Var']
const PIE_COLOURS = ['#6366f1','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6','#14b8a6','#f97316','#ec4899','#84cc16']

// ── Gradient colour for bar charts ───────────────────────────────────────────
function r2Colour(value, min, max) {
  const t = max === min ? 0.5 : (value - min) / (max - min)
  const r = Math.round(255 * (1 - t))
  const g = Math.round(200 * t + 55)
  return `rgb(${r},${g},80)`
}

// ── Download chart as SVG ─────────────────────────────────────────────────────
function useChartDownload(ref, filename = 'chart.svg') {
  return useCallback(() => {
    const el = ref.current
    if (!el) return
    const svg = el.querySelector('svg')
    if (!svg) return
    const clone = svg.cloneNode(true)
    // Inline a white background so it's legible
    clone.setAttribute('style', 'background:#fff')
    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    URL.revokeObjectURL(a.href)
  }, [ref, filename])
}

// ── Chart card wrapper with optional SVG download button ─────────────────────
function ChartCard({ title, subtitle, filename, children }) {
  const ref = useRef(null)
  const download = useChartDownload(ref, filename ?? `${title.replace(/\s+/g, '_')}.svg`)
  return (
    <div className="card p-4 space-y-2">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{title}</h3>
          {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={download}
          title="Download as SVG"
          className="text-gray-300 hover:text-indigo-500 shrink-0"
        >
          <ArrowDownTrayIcon className="w-4 h-4" />
        </button>
      </div>
      <div ref={ref}>{children}</div>
    </div>
  )
}

// ── R² distribution histogram ─────────────────────────────────────────────────
function R2Histogram({ rows }) {
  const r2Vals = rows.map((r) => r.R2).filter((v) => typeof v === 'number')
  if (!r2Vals.length) return null

  // Bin values into 10 equal-width buckets between min and max
  const min = Math.min(...r2Vals)
  const max = Math.max(...r2Vals)
  const binCount = 10
  const binWidth = (max - min) / binCount || 0.1
  const bins = Array.from({ length: binCount }, (_, i) => ({
    label: `${(min + i * binWidth).toFixed(2)}`,
    count: 0,
  }))
  r2Vals.forEach((v) => {
    const idx = Math.min(Math.floor((v - min) / binWidth), binCount - 1)
    bins[idx].count++
  })

  return (
    <ChartCard title="R² Distribution" subtitle={`${r2Vals.length} models`} filename="r2_histogram.svg">
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={bins} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
          <Tooltip formatter={(v) => [`${v} models`, 'Count']} />
          <Bar dataKey="count" fill="#6366f1" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// ── Metric comparison (avg, min, max per metric) ──────────────────────────────
function MetricCompare({ rows }) {
  const metrics = METRIC_COLS.filter((m) => rows.some((r) => typeof r[m] === 'number'))
  if (!metrics.length) return null

  const data = metrics.map((m) => {
    const vals = rows.map((r) => r[m]).filter((v) => typeof v === 'number')
    return {
      metric: m,
      avg: +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(4),
      min: +Math.min(...vals).toFixed(4),
      max: +Math.max(...vals).toFixed(4),
    }
  })

  return (
    <ChartCard title="Metric Summary" subtitle="Avg / Min / Max across all models" filename="metric_compare.svg">
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
          <XAxis dataKey="metric" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} />
          <Tooltip />
          <Bar dataKey="avg" name="Avg" fill="#6366f1" radius={[3, 3, 0, 0]} />
          <Bar dataKey="min" name="Min" fill="#94a3b8" radius={[3, 3, 0, 0]} />
          <Bar dataKey="max" name="Max" fill="#10b981" radius={[3, 3, 0, 0]} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// ── Top-N R² bar chart ────────────────────────────────────────────────────────
function TopR2Chart({ rows }) {
  const [topN, setTopN] = useState(20)
  const sorted = [...rows].sort((a, b) => (b.R2 ?? 0) - (a.R2 ?? 0))
  const topRows = sorted.slice(0, topN)
  const min = Math.min(...topRows.map((r) => r.R2 ?? 0))
  const max = Math.max(...topRows.map((r) => r.R2 ?? 0))

  const data = topRows.map((r, i) => ({
    name: r.Index ?? r.Descriptor ?? `Model ${i + 1}`,
    r2: +(r.R2 ?? 0).toFixed(4),
    col: r2Colour(r.R2 ?? 0, min, max),
  }))

  return (
    <ChartCard
      title={`Top ${topN} Models by R²`}
      filename="top_r2.svg"
      subtitle={
        <span className="flex items-center gap-2">
          Show top{' '}
          <select
            className="border border-gray-200 dark:border-gray-700 rounded px-1 py-0.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
            value={topN}
            onChange={(e) => setTopN(Number(e.target.value))}
          >
            {[5, 10, 20, 50].map((n) => (
              <option key={n} value={n} disabled={n > rows.length}>{n}</option>
            ))}
          </select>
        </span>
      }
    >
      <ResponsiveContainer width="100%" height={Math.max(240, topN * 18)}>
        <BarChart data={data} layout="vertical" margin={{ left: 10, right: 24, top: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e5e7eb" />
          <XAxis type="number" domain={[0, 1]} tickCount={6} tick={{ fontSize: 11 }} />
          <YAxis dataKey="name" type="category" width={130} tick={{ fontSize: 10 }} />
          <Tooltip formatter={(v) => v.toFixed(4)} labelStyle={{ fontSize: 12 }} />
          <Bar dataKey="r2" radius={[0, 3, 3, 0]}>
            {data.map((d, i) => <Cell key={i} fill={d.col} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// ── Metric scatter plot ───────────────────────────────────────────────────────
function MetricScatter({ rows, columns }) {
  const metricOptions = METRIC_COLS.filter((m) => columns?.includes(m))
  const [xAxis, setXAxis] = useState(metricOptions.find((m) => m === 'RMSE') ?? metricOptions[1] ?? metricOptions[0])
  const [yAxis, setYAxis] = useState(metricOptions.find((m) => m === 'R2') ?? metricOptions[0])

  // Detect categorical column for dot colouring
  const catCol = columns?.find((c) => c === 'Category') ?? columns?.find((c) => c === 'Group')
  const categories = catCol ? [...new Set(rows.map((r) => r[catCol] ?? 'Unknown'))] : ['All']

  // Build per-category scatter series
  const series = categories.map((cat, ci) => ({
    cat,
    colour: PIE_COLOURS[ci % PIE_COLOURS.length],
    data: rows
      .filter((r) => !catCol || (r[catCol] ?? 'Unknown') === cat)
      .map((r) => ({
        x: r[xAxis] ?? 0,
        y: r[yAxis] ?? 0,
        name: r.Index ?? r.Descriptor ?? '',
      })),
  }))

  return (
    <ChartCard title="Metric Scatter Plot" subtitle="Select X / Y axes" filename="scatter.svg">
      <div className="flex gap-4 text-xs mb-3">
        {[['X', xAxis, setXAxis], ['Y', yAxis, setYAxis]].map(([label, val, setter]) => (
          <label key={label} className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
            <span className="font-semibold">{label} axis:</span>
            <select
              className="border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
              value={val}
              onChange={(e) => setter(e.target.value)}
            >
              {metricOptions.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <ScatterChart margin={{ left: 16, right: 16, top: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="x" name={xAxis} type="number" tick={{ fontSize: 10 }} label={{ value: xAxis, position: 'insideBottom', offset: -2, fontSize: 11 }} />
          <YAxis dataKey="y" name={yAxis} type="number" tick={{ fontSize: 10 }} label={{ value: yAxis, angle: -90, position: 'insideLeft', fontSize: 11 }} />
          <ZAxis range={[30, 30]} />
          <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<ScatterTooltip xLabel={xAxis} yLabel={yAxis} />} />
          {series.map(({ cat, colour, data }) => (
            <Scatter key={cat} name={cat} data={data} fill={colour} opacity={0.7} />
          ))}
          {categories.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
        </ScatterChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function ScatterTooltip({ active, payload, xLabel, yLabel }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-2 text-xs shadow">
      {d?.name && <p className="font-semibold text-gray-700 dark:text-gray-200 mb-1 max-w-[180px] truncate">{d.name}</p>}
      <p className="text-gray-600 dark:text-gray-400">{xLabel}: <span className="font-mono font-medium text-gray-800 dark:text-gray-200">{(d?.x ?? 0).toFixed(4)}</span></p>
      <p className="text-gray-600 dark:text-gray-400">{yLabel}: <span className="font-mono font-medium text-gray-800 dark:text-gray-200">{(d?.y ?? 0).toFixed(4)}</span></p>
    </div>
  )
}

// ── Box stats (min/p25/median/p75/max) per metric ─────────────────────────────
function BoxStatsChart({ rows, columns }) {
  const metrics = METRIC_COLS.filter((m) => columns?.includes(m))
  if (!metrics.length) return null

  const stats = metrics.map((m) => {
    const vals = rows.map((r) => r[m]).filter((v) => typeof v === 'number').sort((a, b) => a - b)
    if (!vals.length) return null
    const n = vals.length
    return {
      metric: m,
      min:    vals[0],
      p25:    vals[Math.floor(n * 0.25)],
      median: vals[Math.floor(n * 0.5)],
      p75:    vals[Math.floor(n * 0.75)],
      max:    vals[n - 1],
    }
  }).filter(Boolean)

  if (!stats.length) return null

  // Custom SVG box-and-whisker — rendered as a pure SVG inside a div
  const W = 100               // viewBox units per metric slot
  const H = 160
  const PAD = 10
  const total_w = metrics.length * W + PAD * 2

  // Compute global min/max across all metrics for a common Y scale
  const allVals = stats.flatMap((s) => [s.min, s.max])
  const globalMin = Math.min(...allVals)
  const globalMax = Math.max(...allVals)
  const yRange = globalMax - globalMin || 1

  function toY(v) {
    return PAD + (1 - (v - globalMin) / yRange) * (H - PAD * 2)
  }

  return (
    <ChartCard title="Box Statistics per Metric" subtitle="Min / P25 / Median / P75 / Max" filename="box_stats.svg">
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${total_w} ${H + 30}`} className="w-full" style={{ minWidth: `${Math.max(280, total_w * 3)}px` }}>
          {stats.map((s, idx) => {
            const cx = PAD + idx * W + W / 2
            const bw = 28
            const yMin    = toY(s.min)
            const yP25    = toY(s.p25)
            const yMedian = toY(s.median)
            const yP75    = toY(s.p75)
            const yMax    = toY(s.max)
            return (
              <g key={s.metric}>
                {/* Whiskers */}
                <line x1={cx} y1={yMin} x2={cx} y2={yP25} stroke="#94a3b8" strokeWidth={1.5} />
                <line x1={cx} y1={yP75} x2={cx} y2={yMax} stroke="#94a3b8" strokeWidth={1.5} />
                {/* Min/Max caps */}
                <line x1={cx - 8} y1={yMin} x2={cx + 8} y2={yMin} stroke="#94a3b8" strokeWidth={1.5} />
                <line x1={cx - 8} y1={yMax} x2={cx + 8} y2={yMax} stroke="#94a3b8" strokeWidth={1.5} />
                {/* Box */}
                <rect x={cx - bw / 2} y={yP75} width={bw} height={Math.max(1, yP25 - yP75)} fill="#6366f1" opacity={0.25} stroke="#6366f1" strokeWidth={1} />
                {/* Median line */}
                <line x1={cx - bw / 2} y1={yMedian} x2={cx + bw / 2} y2={yMedian} stroke="#6366f1" strokeWidth={2} />
                {/* Label */}
                <text x={cx} y={H + 14} textAnchor="middle" fontSize={11} fill="#6b7280">{s.metric}</text>
              </g>
            )
          })}
          {/* Y-axis labels */}
          <text x={PAD - 4} y={PAD + 4} textAnchor="end" fontSize={9} fill="#9ca3af">{globalMax.toFixed(2)}</text>
          <text x={PAD - 4} y={H - PAD} textAnchor="end" fontSize={9} fill="#9ca3af">{globalMin.toFixed(2)}</text>
        </svg>
      </div>
    </ChartCard>
  )
}

// ── Correlation heatmap (metric × metric Pearson r) ───────────────────────────
function CorrelationHeatmap({ rows, columns }) {
  // Memoized so the dep arrays below have stable references across renders
  const metrics = useMemo(
    () => METRIC_COLS.filter((m) => columns?.includes(m)),
    [columns]
  )
  if (metrics.length < 2) return null

  // Pearson correlation between two arrays
  function pearson(a, b) {
    const n = a.length
    if (!n) return 0
    const ma = a.reduce((s, v) => s + v, 0) / n
    const mb = b.reduce((s, v) => s + v, 0) / n
    const num   = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0)
    const denA  = Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0))
    const denB  = Math.sqrt(b.reduce((s, v) => s + (v - mb) ** 2, 0))
    return denA * denB === 0 ? 0 : num / (denA * denB)
  }

  // Extract numeric column vectors filtered to rows where both exist
  const vectors = useMemo(() => {
    return metrics.map((m) => rows.map((r) => r[m]).filter((v) => typeof v === 'number'))
  }, [rows, metrics])

  // Build correlation matrix
  const matrix = useMemo(() => {
    return metrics.map((_, i) =>
      metrics.map((__, j) => {
        // Align paired values
        const pairs = rows
          .map((r) => [r[metrics[i]], r[metrics[j]]])
          .filter(([a, b]) => typeof a === 'number' && typeof b === 'number')
        return pearson(pairs.map((p) => p[0]), pairs.map((p) => p[1]))
      })
    )
  }, [rows, metrics])

  // Map r in [-1, 1] to bg colour
  function cellColour(r) {
    if (r >= 0.8)  return '#c7d2fe' // indigo-200
    if (r >= 0.5)  return '#dbeafe' // blue-100
    if (r >= 0.2)  return '#d1fae5' // green-100
    if (r >= -0.2) return '#f3f4f6' // gray-100
    if (r >= -0.5) return '#fef9c3' // yellow-100
    return '#fee2e2'                 // red-100
  }

  return (
    <ChartCard title="Metric Correlation Heatmap" subtitle="Pearson r between metric pairs" filename="correlation_heatmap.svg">
      <div className="overflow-x-auto">
        <table className="text-xs mx-auto">
          <thead>
            <tr>
              <th className="w-16" />
              {metrics.map((m) => (
                <th key={m} className="px-1 py-1 font-semibold text-gray-500 text-center w-16">{m}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((rowM, i) => (
              <tr key={rowM}>
                <td className="pr-2 font-semibold text-gray-500 text-right">{rowM}</td>
                {metrics.map((colM, j) => {
                  const r = matrix[i][j]
                  return (
                    <td
                      key={colM}
                      className="w-16 h-10 text-center tabular-nums font-mono rounded"
                      style={{ backgroundColor: cellColour(r) }}
                      title={`${rowM} × ${colM}: ${r.toFixed(3)}`}
                    >
                      <span className="text-gray-700">{r.toFixed(2)}</span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {/* Legend */}
        <div className="flex items-center gap-1.5 mt-3 text-xs text-gray-500 justify-center flex-wrap">
          {[
            { col: '#c7d2fe', label: 'Strong +' },
            { col: '#dbeafe', label: '+' },
            { col: '#d1fae5', label: 'Weak +' },
            { col: '#f3f4f6', label: '≈0' },
            { col: '#fef9c3', label: 'Weak −' },
            { col: '#fee2e2', label: 'Strong −' },
          ].map(({ col, label }) => (
            <span key={label} className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: col }} />
              {label}
            </span>
          ))}
        </div>
      </div>
    </ChartCard>
  )
}

// ── Category pie chart (model count per category) ─────────────────────────────
function CategoryPie({ rows, breakdownCol }) {
  if (!breakdownCol) return null

  // Count models per category
  const counts = {}
  rows.forEach((r) => {
    const cat = r[breakdownCol] ?? 'Unknown'
    counts[cat] = (counts[cat] || 0) + 1
  })
  const data = Object.entries(counts)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)

  if (!data.length) return null

  return (
    <ChartCard title={`Models by ${breakdownCol}`} subtitle="Count per category" filename="category_pie.svg">
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius={90}
            label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
            labelLine={{ stroke: '#94a3b8' }}
            fontSize={11}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={PIE_COLOURS[i % PIE_COLOURS.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(v) => [`${v} models`, 'Count']} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// ── Category performance table ────────────────────────────────────────────────
function CategoryPerfTable({ rows, breakdownCol }) {
  if (!breakdownCol) return null
  const metricCols = METRIC_COLS.filter((m) => rows.some((r) => typeof r[m] === 'number'))

  // Group and aggregate by category
  const groups = {}
  rows.forEach((r) => {
    const cat = r[breakdownCol] ?? 'Unknown'
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(r)
  })

  const tableRows = Object.entries(groups)
    .map(([cat, members]) => {
      const agg = { cat, count: members.length }
      metricCols.forEach((m) => {
        const vals = members.map((r) => r[m]).filter((v) => typeof v === 'number')
        agg[m] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null
      })
      return agg
    })
    .sort((a, b) => (b.R2 ?? -Infinity) - (a.R2 ?? -Infinity))

  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Category Performance (Avg per Group)</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-xs">
          <thead className="bg-gray-50 dark:bg-gray-900/50">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">{breakdownCol}</th>
              <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase">Count</th>
              {metricCols.map((m) => (
                <th key={m} className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase">{m}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {tableRows.map((row) => (
              <tr key={row.cat} className="hover:bg-gray-50 dark:hover:bg-gray-800/40">
                <td className="px-3 py-2 font-medium text-gray-700 dark:text-gray-300">{row.cat}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-500">{row.count}</td>
                {metricCols.map((m) => (
                  <td key={m} className="px-3 py-2 text-right tabular-nums font-mono text-gray-700 dark:text-gray-300">
                    {row[m] != null ? row[m].toFixed(4) : '—'}
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

// ── Root export ───────────────────────────────────────────────────────────────
export default function ResultsCharts({ rows, columns }) {
  if (!rows?.length) return null

  // Detect which categorical breakdown column is present
  const breakdownCol =
    columns.find((c) => c === 'Category') ??
    columns.find((c) => c === 'Group') ??
    null

  return (
    <div className="space-y-5">
      {/* First row: histogram + metric compare */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <R2Histogram rows={rows} />
        <MetricCompare rows={rows} />
      </div>

      {/* Scatter plot — only useful with multiple models */}
      {rows.length > 1 && <MetricScatter rows={rows} columns={columns} />}

      {/* Top-N bar chart */}
      <TopR2Chart rows={rows} />

      {/* Correlation heatmap */}
      <CorrelationHeatmap rows={rows} columns={columns} />

      {/* Category charts */}
      {breakdownCol && (
        <>
          <CategoryPie rows={rows} breakdownCol={breakdownCol} />
          <CategoryPerfTable rows={rows} breakdownCol={breakdownCol} />
        </>
      )}
    </div>
  )
}
