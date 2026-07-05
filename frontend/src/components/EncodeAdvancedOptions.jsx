/**
 * Encode-step advanced options (features 4, 5, 10):
 *  - Task type: regression vs classification
 *  - Embedding model picker + availability gate (shown for the embedding strategy)
 *  - Optional completion webhook URL
 */
import { useEffect, useState } from 'react'
import { getEmbeddingStatus } from '../utils/api'

export default function EncodeAdvancedOptions({ encoding, setEncoding, disabled }) {
  const [embStatus, setEmbStatus] = useState(null)

  useEffect(() => {
    let alive = true
    if (encoding.strategy === 'embedding' && embStatus === null) {
      getEmbeddingStatus().then((s) => { if (alive) setEmbStatus(s) })
    }
    return () => { alive = false }
  }, [encoding.strategy, embStatus])

  const isEmbedding = encoding.strategy === 'embedding'

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 space-y-4">
      <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">Advanced options</p>

      {/* Task type (feature 4) */}
      <div>
        <label className="text-xs font-medium text-gray-600 dark:text-gray-300">Task type</label>
        <div className="mt-1 flex rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden w-fit">
          {['regression', 'classification'].map((t) => (
            <button
              key={t}
              type="button"
              disabled={disabled}
              onClick={() => setEncoding({ task_type: t })}
              className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors disabled:opacity-50 ${
                (encoding.task_type ?? 'regression') === t
                  ? 'bg-indigo-600 text-white'
                  : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-gray-400 mt-1">
          Classification treats the activity column as class labels (accuracy, AUC, confusion matrix).
        </p>
      </div>

      {/* Embedding model (feature 5) */}
      {isEmbedding && (
        <div>
          <label className="text-xs font-medium text-gray-600 dark:text-gray-300">Embedding model</label>
          {embStatus && !embStatus.available ? (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              ⚠ {embStatus.reason || 'Embedding backend unavailable.'} This strategy needs a backend with
              torch + transformers installed.
            </p>
          ) : (
            <select
              disabled={disabled || !embStatus}
              value={encoding.embedding_model || (embStatus?.default_model ?? '')}
              onChange={(e) => setEncoding({ embedding_model: e.target.value })}
              className="mt-1 block w-full text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 p-2"
            >
              {(embStatus?.models ?? []).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Completion webhook (feature 10) */}
      <div>
        <label className="text-xs font-medium text-gray-600 dark:text-gray-300">
          Completion webhook <span className="text-gray-400">(optional)</span>
        </label>
        <input
          type="url"
          disabled={disabled}
          value={encoding.notify_webhook || ''}
          onChange={(e) => setEncoding({ notify_webhook: e.target.value })}
          placeholder="https://hooks.slack.com/services/…"
          className="mt-1 block w-full text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 p-2"
        />
        <p className="text-[11px] text-gray-400 mt-1">
          POSTed a small JSON summary when the job finishes. Point it at Slack, Zapier, or an email relay.
        </p>
      </div>
    </div>
  )
}
