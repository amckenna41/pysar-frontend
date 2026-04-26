import { useState } from 'react'
import { ClipboardDocumentIcon, ArrowDownTrayIcon, BookmarkIcon, ListBulletIcon, ArrowsRightLeftIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { useAppStore, DEFAULT_CONFIG } from '../store/appStore'

/** Minimal JSON syntax highlighter — returns an HTML string */
function highlight(json) {
  return json
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (match) => {
      if (/^"/.test(match)) {
        return /:$/.test(match)
          ? `<span class="json-key">${match}</span>`
          : `<span class="json-str">${match}</span>`
      }
      if (/true|false/.test(match)) return `<span class="json-bool">${match}</span>`
      if (/null/.test(match))       return `<span class="json-null">${match}</span>`
      return `<span class="json-num">${match}</span>`
    })
}

// Named starter templates
const CONFIG_TEMPLATES = [
  {
    name: 'Quick Benchmark',
    desc: 'PLS Regression, 20% holdout, default descriptors',
    config: { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model, algorithm: 'plsregression', parameters: { n_components: 2 } } },
  },
  {
    name: 'Random Forest',
    desc: 'Random Forest, 100 trees, 20% holdout',
    config: { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model, algorithm: 'randomforest', parameters: { n_estimators: 100 } } },
  },
  {
    name: 'DSP + HGBR',
    desc: 'Hist Gradient Boosting with Power + Hamming DSP',
    config: {
      ...DEFAULT_CONFIG,
      model: { ...DEFAULT_CONFIG.model, algorithm: 'hgbr', parameters: { max_iter: 100 } },
      pyDSP: { ...DEFAULT_CONFIG.pyDSP, use_dsp: true, spectrum: 'power', window: { ...DEFAULT_CONFIG.pyDSP.window, type: 'hamming' } },
    },
  },
  {
    name: 'k-Fold CV',
    desc: 'Ridge regression with 5-fold cross-validation, seed 42',
    config: { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model, algorithm: 'ridge', parameters: { alpha: 1.0 }, use_cv: true, cv_folds: 5, random_state: 42 } },
  },
  {
    name: 'SVR (RBF kernel)',
    desc: 'Support Vector Regression with RBF kernel, 80/20 split',
    config: { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model, algorithm: 'svr', parameters: { kernel: 'rbf', C: 1.0, epsilon: 0.1 } } },
  },
  {
    name: 'Gradient Boosting',
    desc: 'Gradient Boosting, 200 estimators, 10% holdout',
    config: { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model, algorithm: 'gradientboosting', test_split: 0.1, parameters: { n_estimators: 200, learning_rate: 0.1, max_depth: 3 } } },
  },
  {
    name: 'Elastic Net',
    desc: 'Elastic Net with balanced L1/L2 regularisation',
    config: { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model, algorithm: 'elasticnet', parameters: { alpha: 0.5, l1_ratio: 0.5 } } },
  },
  {
    name: 'k-NN Regressor',
    desc: 'k-Nearest Neighbours, k=5, uniform weights',
    config: { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model, algorithm: 'knn', parameters: { n_neighbors: 5, weights: 'uniform', metric: 'euclidean' } } },
  },
  {
    name: 'LASSO (sparse)',
    desc: 'LASSO regression for sparse feature selection',
    config: { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model, algorithm: 'lasso', parameters: { alpha: 0.1 } } },
  },
  {
    name: 'DSP + Random Forest',
    desc: 'Random Forest with Absolute spectrum + Blackman window DSP',
    config: {
      ...DEFAULT_CONFIG,
      model: { ...DEFAULT_CONFIG.model, algorithm: 'randomforest', parameters: { n_estimators: 200, max_depth: 10 } },
      pyDSP: { ...DEFAULT_CONFIG.pyDSP, use_dsp: true, spectrum: 'absolute', window: { ...DEFAULT_CONFIG.pyDSP.window, type: 'blackman' } },
    },
  },
  {
    name: 'HGBR + CV',
    desc: 'Hist Gradient Boosting with 10-fold CV, reproducible seed',
    config: { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model, algorithm: 'hgbr', parameters: { max_iter: 200, learning_rate: 0.05 }, use_cv: true, cv_folds: 10, random_state: 0 } },
  },
  {
    name: 'Strict Holdout',
    desc: 'Ridge regression with 30% test holdout for small datasets',
    config: { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model, algorithm: 'ridge', test_split: 0.3, parameters: { alpha: 1.0 } } },
  },
]

// Recursively diff current vs defaults — returns [{path, current, default}]
function getDiff(current, defaults, path = []) {
  const diffs = []
  const allKeys = new Set([...Object.keys(current ?? {}), ...Object.keys(defaults ?? {})])
  for (const key of allKeys) {
    const curr = current?.[key]
    const def  = defaults?.[key]
    const fullPath = [...path, key]
    if (typeof curr === 'object' && curr !== null && !Array.isArray(curr)
     && typeof def  === 'object' && def  !== null && !Array.isArray(def)) {
      diffs.push(...getDiff(curr, def, fullPath))
    } else if (JSON.stringify(curr) !== JSON.stringify(def)) {
      diffs.push({ path: fullPath.join('.'), current: curr, default: def })
    }
  }
  return diffs
}

// Validate config fields and return human-readable warnings
function validateConfig(config, dataset) {
  const warnings = []
  const { model, descriptors, pyDSP } = config

  // CV folds must be >= 2
  if (model.use_cv && (model.cv_folds ?? 5) < 2) {
    warnings.push('cv_folds must be at least 2.')
  }

  // PLS n_components must be < number of samples
  if (model.algorithm === 'plsregression') {
    const nComp = model.parameters?.n_components
    if (nComp != null && dataset?.num_rows != null && nComp >= dataset.num_rows) {
      warnings.push(`PLS n_components (${nComp}) must be less than the number of training samples (${dataset.num_rows}).`)
    }
  }

  // Lag/lambda descriptors: lag must be < minimum sequence length
  const lagDescriptors = [
    'moreaubroto_autocorrelation', 'moran_autocorrelation', 'geary_autocorrelation',
    'sequence_order_coupling_number', 'quasi_sequence_order',
    'pseudo_amino_acid_composition', 'amphiphilic_pseudo_amino_acid_composition',
  ]
  for (const key of lagDescriptors) {
    const lag = descriptors?.[key]?.lag ?? descriptors?.[key]?.lambda
    if (lag != null && dataset?.length_stats?.min != null && lag >= dataset.length_stats.min) {
      warnings.push(`${key}: lag/lambda (${lag}) must be less than the shortest sequence (${dataset.length_stats.min} aa).`)
    }
  }

  // Savgol: window_length must be odd and > polyorder
  if (pyDSP?.use_dsp && pyDSP?.filter?.type === 'savgol') {
    const wl = pyDSP.filter.window_length ?? 5
    const po = pyDSP.filter.polyorder ?? 2
    if (wl % 2 === 0) warnings.push('Savitzky-Golay: window_length must be an odd number.')
    if (po >= wl)     warnings.push(`Savitzky-Golay: polyorder (${po}) must be less than window_length (${wl}).`)
  }

  return warnings
}

export default function ConfigPreview() {
  const { config, dataset, saveCurrentConfig, savedConfigs, loadSavedConfig, deleteSavedConfig, importConfig } = useAppStore()
  const [saveName, setSaveName] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [viewMode, setViewMode] = useState('full') // 'full' | 'diff'

  const json = JSON.stringify(config, null, 2)
  const diffs = getDiff(config, DEFAULT_CONFIG)
  const validationWarnings = validateConfig(config, dataset)

  function handleCopy() {
    navigator.clipboard.writeText(json).then(() => toast.success('Config copied to clipboard'))
  }

  function handleDownload() {
    const blob = new Blob([json], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'pysar_config.json'
    a.click()
  }

  function handleSave() {
    if (!saveName.trim()) { toast.error('Enter a name for this config'); return }
    saveCurrentConfig(saveName.trim())
    setSaveName('')
    toast.success('Config saved to history')
  }

  function loadTemplate(t) {
    importConfig(t.config)
    setShowTemplates(false)
    toast.success(`Loaded template: ${t.name}`)
  }

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-800">Live config preview</h3>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary py-1.5 text-xs" onClick={handleCopy}>
            <ClipboardDocumentIcon className="w-3.5 h-3.5" /> Copy
          </button>
          <button className="btn-secondary py-1.5 text-xs" onClick={handleDownload}>
            <ArrowDownTrayIcon className="w-3.5 h-3.5" /> Download
          </button>
          <button className="btn-secondary py-1.5 text-xs" onClick={() => setShowTemplates((v) => !v)}>
            <ListBulletIcon className="w-3.5 h-3.5" /> Templates
          </button>
          <button className="btn-secondary py-1.5 text-xs" onClick={() => setShowHistory((v) => !v)}>
            <BookmarkIcon className="w-3.5 h-3.5" /> History ({savedConfigs.length})
          </button>
        </div>
      </div>

      {/* Validation warnings */}
      {validationWarnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 space-y-1">
          <p className="font-medium flex items-center gap-1.5">
            <ExclamationTriangleIcon className="w-4 h-4 shrink-0" />
            {validationWarnings.length} configuration warning{validationWarnings.length !== 1 ? 's' : ''}
          </p>
          {validationWarnings.map((w, i) => (
            <p key={i} className="text-xs ml-5">{w}</p>
          ))}
        </div>
      )}

      {/* Templates panel */}
      {showTemplates && (
        <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-4">
          <p className="text-xs font-semibold text-indigo-700 uppercase tracking-wide mb-3">Start from template</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {CONFIG_TEMPLATES.map((t) => (
              <button
                key={t.name}
                onClick={() => loadTemplate(t)}
                className="text-left p-3 rounded-lg bg-white border border-gray-200 hover:border-indigo-400 transition-colors"
              >
                <p className="text-sm font-semibold text-gray-800">{t.name}</p>
                <p className="text-xs text-gray-500 mt-0.5">{t.desc}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* View mode toggle: Full JSON vs Changes-from-defaults */}
      <div className="flex rounded-lg border border-gray-200 overflow-hidden w-fit">
        <button
          onClick={() => setViewMode('full')}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${viewMode === 'full' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
        >
          Full Config
        </button>
        <button
          onClick={() => setViewMode('diff')}
          className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-gray-200 inline-flex items-center gap-1 ${viewMode === 'diff' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
        >
          <ArrowsRightLeftIcon className="w-3 h-3" />
          Changes from defaults{diffs.length > 0 ? ` (${diffs.length})` : ''}
        </button>
      </div>

      {/* JSON viewer or diff table */}
      {viewMode === 'full' ? (
        <pre
          className="rounded-lg bg-gray-900 text-gray-100 p-4 text-xs overflow-auto max-h-96 font-mono leading-relaxed"
          dangerouslySetInnerHTML={{ __html: highlight(json) }}
        />
      ) : (
        <div className="rounded-lg border border-gray-200 overflow-hidden">
          {diffs.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No changes from defaults.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">Setting</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">Current</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">Default</th>
                </tr>
              </thead>
              <tbody>
                {diffs.map(({ path, current, default: def }, i) => (
                  <tr key={i} className="border-b border-gray-100 last:border-0">
                    <td className="px-3 py-2 font-mono text-gray-700">{path}</td>
                    <td className="px-3 py-2 font-mono text-green-700 bg-green-50">{JSON.stringify(current)}</td>
                    <td className="px-3 py-2 font-mono text-red-500 bg-red-50 line-through opacity-60">{JSON.stringify(def)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Save current config */}
      <div className="flex gap-2">
        <input
          className="input flex-1 text-xs"
          placeholder="Name this configuration…"
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
        />
        <button className="btn-secondary text-xs" onClick={handleSave}>
          <BookmarkIcon className="w-3.5 h-3.5" /> Save
        </button>
      </div>

      {/* Config history */}
      {showHistory && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-500">Saved configurations</p>
          {savedConfigs.length === 0 && (
            <p className="text-xs text-gray-400">No saved configurations yet.</p>
          )}
          {savedConfigs.map((entry, i) => (
            <div
              key={i}
              className="flex items-center justify-between p-2.5 rounded-lg border border-gray-200 bg-gray-50 text-xs"
            >
              <div>
                <span className="font-medium text-gray-700">{entry.name}</span>
                <span className="ml-2 text-gray-400">{new Date(entry.timestamp).toLocaleString()}</span>
              </div>
              <div className="flex gap-1">
                <button
                  className="btn-secondary px-2 py-1 text-xs"
                  onClick={() => { loadSavedConfig(i); toast.success(`Loaded "${entry.name}"`) }}
                >
                  Load
                </button>
                <button
                  className="px-2 py-1 text-xs rounded text-red-500 hover:bg-red-50"
                  onClick={() => deleteSavedConfig(i)}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

