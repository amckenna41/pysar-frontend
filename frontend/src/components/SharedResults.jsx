/**
 * Read-only shared results view (feature 10).
 *
 * Rendered when the URL carries ?share=<token>. Fetches the shared job by token
 * (no session required) and shows a trimmed, read-only dashboard: summary, results
 * table, charts, and insights. Download/predict are hidden (they need ownership).
 */
import { useEffect, useState } from 'react'
import { getSharedJob } from '../utils/api'
import ResultsCharts, { PredictedActualChart } from './ResultsCharts'
import ModelInsights from './ModelInsights'

export default function SharedResults({ token }) {
  const [job, setJob] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    getSharedJob(token)
      .then((j) => { if (alive) setJob(j) })
      .catch(() => { if (alive) setError('These shared results are no longer available.') })
    return () => { alive = false }
  }, [token])

  if (error) {
    return <Centered><p className="text-gray-500">{error}</p></Centered>
  }
  if (!job) {
    return <Centered><p className="text-gray-400">Loading shared results…</p></Centered>
  }

  const rows = job.results || []
  const columns = job.columns || (rows[0] ? Object.keys(rows[0]) : [])

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <div className="max-w-5xl mx-auto space-y-5">
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-500">Shared pySAR results (read-only)</p>
          <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100 mt-1">
            {job.best_model_name || job.strategy} — {job.algorithm}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {job.task_type === 'classification' ? 'Classification' : 'Regression'} ·
            {' '}{rows.length} model{rows.length !== 1 ? 's' : ''} evaluated · strategy: {job.strategy}
          </p>
        </div>

        {job.best_model_predictions?.actual?.length > 0 && (
          <PredictedActualChart predictions={job.best_model_predictions} />
        )}
        {rows.length > 0 && <ResultsCharts rows={rows} columns={columns} />}
        <ModelInsights job={job} encoding={{}} dataset={{}} readOnly />

        {rows.length > 0 && (
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-100 dark:border-gray-700">
                  {columns.map((c) => <th key={c} className="px-3 py-2">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 50).map((r, i) => (
                  <tr key={i} className="border-b border-gray-50 dark:border-gray-700/50 last:border-0">
                    {columns.map((c) => (
                      <td key={c} className="px-3 py-2 font-mono">
                        {typeof r[c] === 'number' ? r[c].toFixed(4) : String(r[c] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function Centered({ children }) {
  return <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">{children}</div>
}
