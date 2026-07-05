/**
 * ModelInsights — post-run panels for a completed job (features 2, 3, 4, 6, 7).
 *
 * Renders (when the backend provides them):
 *  - Feature importance bar chart (feature 3)
 *  - Per-fold cross-validation distribution (feature 6)
 *  - Classification confusion matrix + metrics (feature 4)
 *  - Best-model download + single-sequence prediction (feature 2)
 *  - Reproducibility export: copyable pySAR Python snippet (feature 7)
 */
import { useState } from 'react'
import toast from 'react-hot-toast'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts'
import { downloadBestModel, predictSequences } from '../utils/api'
import { generatePythonSnippet } from '../utils/reproExport'

function Section({ title, subtitle, children }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
      <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</h3>
      {subtitle && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</p>}
      <div className="mt-3">{children}</div>
    </div>
  )
}

function FeatureImportance({ fi }) {
  if (!fi?.top?.length) return null
  const data = fi.top.slice(0, 20).map((d) => ({ name: d.feature, value: Math.abs(d.importance) }))
  return (
    <Section
      title="Feature importance"
      subtitle={`${fi.kind === 'coefficient' ? 'Linear coefficient magnitude' : 'Tree feature importance'} — top ${data.length} of ${fi.total_features} features`}
    >
      <ResponsiveContainer width="100%" height={Math.max(180, data.length * 22)}>
        <BarChart data={data} layout="vertical" margin={{ left: 20, right: 16 }}>
          <XAxis type="number" tick={{ fontSize: 11 }} />
          <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 10 }} />
          <Tooltip formatter={(v) => v.toFixed(4)} />
          <Bar dataKey="value" fill="#6366f1" radius={[0, 3, 3, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </Section>
  )
}

function CrossValidation({ cv }) {
  if (!cv?.scores?.length) return null
  const data = cv.scores.map((s, i) => ({ name: `Fold ${i + 1}`, value: s }))
  return (
    <Section
      title="Cross-validation"
      subtitle={`${cv.folds}-fold ${cv.metric} — mean ${cv.mean?.toFixed(4)} ± ${cv.std?.toFixed(4)}`}
    >
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ left: 8, right: 8 }}>
          <XAxis dataKey="name" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
          <Tooltip formatter={(v) => v.toFixed(4)} />
          {cv.mean != null && <ReferenceLine y={cv.mean} stroke="#f59e0b" strokeDasharray="4 3" />}
          <Bar dataKey="value" fill="#10b981" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </Section>
  )
}

function ConfusionMatrix({ cls }) {
  if (!cls?.confusion_matrix?.length) return null
  const { confusion_matrix: cm, classes } = cls
  const max = Math.max(1, ...cm.flat())
  return (
    <Section title="Confusion matrix" subtitle="Rows = actual class, columns = predicted class">
      <div className="overflow-x-auto">
        <table className="text-xs border-collapse">
          <thead>
            <tr>
              <th className="p-2" />
              {classes.map((c) => (
                <th key={c} className="p-2 font-medium text-gray-600 dark:text-gray-300">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cm.map((row, i) => (
              <tr key={i}>
                <th className="p-2 text-right font-medium text-gray-600 dark:text-gray-300">{classes[i]}</th>
                {row.map((v, j) => {
                  const intensity = v / max
                  return (
                    <td key={j} className="p-0">
                      <div
                        className="w-12 h-12 flex items-center justify-center font-mono"
                        style={{
                          backgroundColor: `rgba(99, 102, 241, ${0.12 + intensity * 0.75})`,
                          color: intensity > 0.55 ? 'white' : 'inherit',
                        }}
                      >
                        {v}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

function ModelExportPredict({ job }) {
  const [seqInput, setSeqInput] = useState('')
  const [preds, setPreds] = useState(null)
  const [busy, setBusy] = useState(false)

  async function handleDownload() {
    try {
      const blob = await downloadBestModel(job.job_id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `pysar_best_model_${job.job_id.slice(0, 8)}.pkl`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error('Could not download model — it may have expired.')
    }
  }

  async function handlePredict() {
    const seqs = seqInput.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean)
    if (!seqs.length) { toast.error('Enter at least one sequence.'); return }
    setBusy(true)
    try {
      const res = await predictSequences(job.job_id, seqs)
      setPreds(res.predictions)
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Prediction failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Deploy this model" subtitle={`Best model: ${job.best_model_name || '—'}`}>
      <button
        onClick={handleDownload}
        className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
      >
        Download model (.pkl)
      </button>
      <div className="mt-4">
        <label className="text-xs font-medium text-gray-600 dark:text-gray-300">
          Score new sequences (one per line)
        </label>
        <textarea
          value={seqInput}
          onChange={(e) => setSeqInput(e.target.value)}
          rows={3}
          placeholder="MTIKEMPQPKTF…"
          className="mt-1 w-full text-sm font-mono rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 p-2"
        />
        <button
          onClick={handlePredict}
          disabled={busy}
          className="mt-2 text-sm px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy ? 'Scoring…' : 'Predict'}
        </button>
      </div>
      {preds && (
        <table className="mt-3 w-full text-xs">
          <thead>
            <tr className="text-gray-500 dark:text-gray-400 text-left">
              <th className="py-1">Sequence</th><th className="py-1">Prediction</th>
            </tr>
          </thead>
          <tbody>
            {preds.map((p, i) => (
              <tr key={i} className="border-t border-gray-100 dark:border-gray-700">
                <td className="py-1 font-mono">{p.sequence}</td>
                <td className="py-1 font-mono">{typeof p.prediction === 'number' ? p.prediction.toFixed(4) : String(p.prediction)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  )
}

function ReproExport({ job, encoding, dataset }) {
  const [open, setOpen] = useState(false)
  const snippet = generatePythonSnippet(job, {
    filePath: dataset?.filename || 'your_dataset.txt',
    sequenceCol: encoding?.sequence_col || dataset?.seq_col_guess || 'sequence',
    activityCol: encoding?.activity_col || dataset?.act_col_guess || 'activity',
    algorithm: job?.algorithm,
    testSplit: encoding?.test_split ?? 0.2,
    useCv: encoding?.use_cv ?? false,
    cvFolds: encoding?.cv_folds ?? 5,
    strategy: job?.strategy,
    aaiIndices: encoding?.aai_indices,
    selectedDescriptors: encoding?.selected_descriptors,
    descCombo: encoding?.desc_combo,
    sortBy: encoding?.sort_by,
    embeddingModel: encoding?.embedding_model,
  })

  return (
    <Section title="Reproduce this run" subtitle="Runnable pySAR Python for your methods section (feature 7)">
      <div className="flex gap-2">
        <button
          onClick={() => { navigator.clipboard.writeText(snippet); toast.success('Python snippet copied') }}
          className="text-sm px-3 py-1.5 rounded-lg bg-gray-800 text-white hover:bg-gray-900"
        >
          Copy Python snippet
        </button>
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600"
        >
          {open ? 'Hide' : 'Preview'}
        </button>
      </div>
      {open && (
        <pre className="mt-3 rounded-lg bg-gray-900 text-gray-100 p-3 text-[11px] overflow-auto max-h-80 font-mono">
          {snippet}
        </pre>
      )}
    </Section>
  )
}

export default function ModelInsights({ job, encoding, dataset, readOnly = false }) {
  if (!job || job.status !== 'completed') return null

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      {job.classification && <ConfusionMatrix cls={job.classification} />}
      {job.feature_importance && <FeatureImportance fi={job.feature_importance} />}
      {job.cv_scores && <CrossValidation cv={job.cv_scores} />}
      {/* Download + predict require session ownership, so hide them on shared views. */}
      {!readOnly && job.model_available && <ModelExportPredict job={job} />}
      <ReproExport job={job} encoding={encoding} dataset={dataset} />
    </div>
  )
}
