import { useState } from 'react'
import { ExclamationTriangleIcon, ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline'
import { useAppStore } from '../store/appStore'

const ALGORITHMS = [
  { value: 'plsregression',    label: 'PLS Regression' },
  { value: 'randomforest',     label: 'Random Forest' },
  { value: 'adaboost',         label: 'AdaBoost' },
  { value: 'gradientboosting', label: 'Gradient Boosting' },
  { value: 'svr',              label: 'Support Vector Regression' },
  { value: 'knn',              label: 'K-Nearest Neighbours' },
  { value: 'ridge',            label: 'Ridge Regression' },
  { value: 'lasso',            label: 'Lasso Regression' },
  { value: 'elasticnet',       label: 'ElasticNet' },
  { value: 'linear',           label: 'Linear Regression' },
  { value: 'bagging',          label: 'Bagging Regressor' },
  { value: 'extratrees',       label: 'Extra Trees' },
  { value: 'hgbr',             label: 'Hist Gradient Boosting' },
  { value: 'gpr',              label: 'Gaussian Process' },
]

// Per-algorithm common tunable parameters
const ALGO_PARAMS = {
  plsregression:    [{ key: 'n_components', label: 'n_components', type: 'number', default: 2 }],
  randomforest:     [
    { key: 'n_estimators', label: 'n_estimators', type: 'number', default: 100 },
    { key: 'max_depth',    label: 'max_depth',    type: 'number', default: null },
  ],
  adaboost:         [
    { key: 'n_estimators',  label: 'n_estimators',  type: 'number', default: 50 },
    { key: 'learning_rate', label: 'learning_rate', type: 'number', default: 1.0 },
  ],
  gradientboosting: [
    { key: 'n_estimators',  label: 'n_estimators',  type: 'number', default: 100 },
    { key: 'learning_rate', label: 'learning_rate', type: 'number', default: 0.1 },
    { key: 'max_depth',     label: 'max_depth',     type: 'number', default: 3 },
  ],
  svr: [
    { key: 'C',       label: 'C',       type: 'number', default: 1.0 },
    { key: 'kernel',  label: 'kernel',  type: 'text',   default: 'rbf' },
    { key: 'epsilon', label: 'epsilon', type: 'number', default: 0.1 },
  ],
  knn:      [{ key: 'n_neighbors',  label: 'n_neighbors',  type: 'number', default: 5 }],
  ridge:    [{ key: 'alpha',        label: 'alpha',        type: 'number', default: 1.0 }],
  lasso:    [{ key: 'alpha',        label: 'alpha',        type: 'number', default: 1.0 }],
  elasticnet: [
    { key: 'alpha',    label: 'alpha',    type: 'number', default: 1.0 },
    { key: 'l1_ratio', label: 'l1_ratio', type: 'number', default: 0.5 },
  ],
  bagging:  [{ key: 'n_estimators', label: 'n_estimators', type: 'number', default: 10 }],
  extratrees: [
    { key: 'n_estimators', label: 'n_estimators', type: 'number', default: 100 },
    { key: 'max_depth',    label: 'max_depth',    type: 'number', default: null },
  ],
  hgbr: [
    { key: 'max_iter',      label: 'max_iter',      type: 'number', default: 100 },
    { key: 'learning_rate', label: 'learning_rate', type: 'number', default: 0.1 },
    { key: 'max_depth',     label: 'max_depth',     type: 'number', default: null },
  ],
  gpr:    [],
  linear: [],
}

// Fast / Balanced / Thorough preset parameters per algorithm
const ALGO_PRESETS = {
  plsregression:    { fast: { n_components: 1 }, balanced: { n_components: 2 }, thorough: { n_components: 5 } },
  randomforest:     { fast: { n_estimators: 50 }, balanced: { n_estimators: 100 }, thorough: { n_estimators: 500 } },
  adaboost:         { fast: { n_estimators: 30, learning_rate: 0.5 }, balanced: { n_estimators: 50, learning_rate: 1.0 }, thorough: { n_estimators: 150, learning_rate: 0.3 } },
  gradientboosting: { fast: { n_estimators: 50, learning_rate: 0.2, max_depth: 3 }, balanced: { n_estimators: 100, learning_rate: 0.1, max_depth: 3 }, thorough: { n_estimators: 300, learning_rate: 0.05, max_depth: 5 } },
  svr:              { fast: { C: 0.1, kernel: 'linear', epsilon: 0.1 }, balanced: { C: 1.0, kernel: 'rbf', epsilon: 0.1 }, thorough: { C: 10.0, kernel: 'rbf', epsilon: 0.01 } },
  knn:              { fast: { n_neighbors: 3 }, balanced: { n_neighbors: 5 }, thorough: { n_neighbors: 11 } },
  ridge:            { fast: { alpha: 10.0 }, balanced: { alpha: 1.0 }, thorough: { alpha: 0.01 } },
  lasso:            { fast: { alpha: 1.0 }, balanced: { alpha: 0.1 }, thorough: { alpha: 0.01 } },
  elasticnet:       { fast: { alpha: 1.0, l1_ratio: 0.5 }, balanced: { alpha: 0.5, l1_ratio: 0.5 }, thorough: { alpha: 0.1, l1_ratio: 0.3 } },
  bagging:          { fast: { n_estimators: 10 }, balanced: { n_estimators: 20 }, thorough: { n_estimators: 50 } },
  extratrees:       { fast: { n_estimators: 50 }, balanced: { n_estimators: 100 }, thorough: { n_estimators: 500 } },
  hgbr:             { fast: { max_iter: 50, learning_rate: 0.2 }, balanced: { max_iter: 100, learning_rate: 0.1 }, thorough: { max_iter: 500, learning_rate: 0.05 } },
  gpr:    {},
  linear: {},
}

// Algorithms that are slow on large datasets — show a warning banner
const ALGO_SCALE_WARNINGS = {
  gpr:  { threshold: 500,   msg: (n) => `GPR scales as O(n³) — very slow above ~500 samples. Your dataset has ${n} rows.` },
  svr:  { threshold: 5000,  msg: (n) => `SVR is O(n²–n³) — training may be slow for large datasets. Your dataset has ${n} rows.` },
  knn:  { threshold: 10000, msg: (n) => `KNN requires pairwise distances — may be slow above ~10,000 samples. Your dataset has ${n} rows.` },
}

export default function ModelConfig() {
  const { config, setConfigValue, dataset } = useAppStore()
  const {
    algorithms = ['plsregression'],
    perAlgoParameters = {},
    test_split, use_cv, cv_folds, random_state,
  } = config.model
  const numRows = dataset?.num_rows ?? null

  // Accordion open state for per-algo param sections (first algo open by default)
  const [openAlgos, setOpenAlgos] = useState(() => new Set([algorithms[0]]))

  // Toggle an algorithm in/out of the selected list
  function toggleAlgo(value) {
    if (algorithms.includes(value)) {
      if (algorithms.length === 1) return // must keep at least one selected
      const next = algorithms.filter((a) => a !== value)
      setConfigValue(['model', 'algorithms'], next)
      setConfigValue(['model', 'algorithm'], next[0])
    } else {
      const next = [...algorithms, value]
      setConfigValue(['model', 'algorithms'], next)
      // open accordion for newly added algo
      setOpenAlgos((prev) => new Set([...prev, value]))
    }
  }

  // Update a parameter for a specific algorithm
  function handleParam(algo, key, raw) {
    const num = Number(raw)
    const val = raw === '' || raw === null ? null : isNaN(num) ? raw : num
    setConfigValue(['model', 'perAlgoParameters', algo, key], val)
  }

  // Apply a named preset to a specific algorithm's parameters
  function applyPreset(algo, presetKey) {
    Object.entries(ALGO_PRESETS[algo]?.[presetKey] ?? {}).forEach(([k, v]) => {
      setConfigValue(['model', 'perAlgoParameters', algo, k], v)
    })
  }

  // Collect scale warnings for all selected algorithms
  const activeWarnings = algorithms.flatMap((a) => {
    const w = ALGO_SCALE_WARNINGS[a]
    if (!w || numRows === null || numRows <= w.threshold) return []
    return [{ algo: a, msg: w.msg(numRows) }]
  })

  // Whether any selected algorithm has configurable parameters or presets
  const anyHasParams = algorithms.some((a) => {
    const paramDefs = ALGO_PARAMS[a] ?? []
    const presets = ALGO_PRESETS[a] ?? {}
    return paramDefs.length > 0 || Object.values(presets).some((p) => Object.keys(p).length > 0)
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800">Model settings</h3>
        {/* Badge showing multi-selection count */}
        {algorithms.length > 1 && (
          <span className="text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-full px-2 py-0.5">
            {algorithms.length} algorithms selected
          </span>
        )}
      </div>

      {/* Algorithm multi-select toggle grid */}
      <div>
        <label className="label">
          ML algorithm
          <span className="ml-1 font-normal text-gray-400">(select one or more)</span>
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-1">
          {ALGORITHMS.map(({ value, label }) => {
            const isSelected = algorithms.includes(value)
            return (
              <button
                key={value}
                onClick={() => toggleAlgo(value)}
                className={[
                  'px-3 py-2 rounded-lg border text-xs font-medium text-left transition-colors flex items-center justify-between gap-1',
                  isSelected
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300 bg-white',
                ].join(' ')}
              >
                <span>{label}</span>
                {/* Checkmark icon for selected state */}
                {isSelected && (
                  <svg className="w-3.5 h-3.5 shrink-0 text-indigo-500" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414L8.414 15 3.293 9.879a1 1 0 111.414-1.415L8.414 12.172l6.879-6.879a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Scale warnings for selected algorithms */}
      {activeWarnings.map(({ algo, msg }) => (
        <div key={algo} className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-700">
          <ExclamationTriangleIcon className="w-4 h-4 mt-0.5 shrink-0" />
          {msg}
        </div>
      ))}

      {/* Per-algorithm parameters — accordion sections when multiple algos selected */}
      {anyHasParams && (
        <div>
          <label className="label">Algorithm parameters</label>
          <div className="space-y-2 mt-1">
            {algorithms.map((algo) => {
              const paramDefs = ALGO_PARAMS[algo] ?? []
              const presets = ALGO_PRESETS[algo] ?? {}
              const hasPresets = Object.values(presets).some((p) => Object.keys(p).length > 0)
              if (paramDefs.length === 0 && !hasPresets) return null

              const isOpen = openAlgos.has(algo)
              const algoLabel = ALGORITHMS.find((a) => a.value === algo)?.label ?? algo
              const algoParams = perAlgoParameters[algo] ?? {}
              const multiAlgo = algorithms.length > 1

              return (
                <div key={algo} className="rounded-lg border border-gray-200 overflow-hidden">
                  {/* Collapsible header — only shown when multiple algos are selected */}
                  {multiAlgo && (
                    <button
                      type="button"
                      onClick={() =>
                        setOpenAlgos((prev) => {
                          const next = new Set(prev)
                          isOpen ? next.delete(algo) : next.add(algo)
                          return next
                        })
                      }
                      className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 transition-colors"
                    >
                      <span>{algoLabel}</span>
                      {isOpen ? (
                        <ChevronUpIcon className="w-3.5 h-3.5 text-gray-400" />
                      ) : (
                        <ChevronDownIcon className="w-3.5 h-3.5 text-gray-400" />
                      )}
                    </button>
                  )}

                  {/* Parameter content — always visible for single, collapsed for multi */}
                  {(!multiAlgo || isOpen) && (
                    <div className={multiAlgo ? 'p-3 space-y-3' : 'space-y-3'}>
                      {/* Quick presets */}
                      {hasPresets && (
                        <div>
                          {multiAlgo && <label className="label">Quick presets</label>}
                          {!multiAlgo && <label className="label">Quick presets</label>}
                          <div className="flex gap-2 mt-1">
                            {[['fast', 'Fast ⚡'], ['balanced', 'Balanced'], ['thorough', 'Thorough 🔬']].map(
                              ([key, label]) =>
                                presets[key] && Object.keys(presets[key]).length > 0 ? (
                                  <button
                                    key={key}
                                    onClick={() => applyPreset(algo, key)}
                                    className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs font-medium text-gray-600 hover:border-indigo-400 hover:text-indigo-700 bg-white transition-colors"
                                  >
                                    {label}
                                  </button>
                                ) : null
                            )}
                          </div>
                        </div>
                      )}

                      {/* Parameter inputs */}
                      {paramDefs.length > 0 && (
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                          {paramDefs.map(({ key, label, type, default: defaultVal }) => (
                            <div key={key}>
                              <label className="label">{label}</label>
                              <input
                                type={type}
                                className="input"
                                value={algoParams[key] ?? ''}
                                placeholder={
                                  defaultVal !== null && defaultVal !== undefined ? String(defaultVal) : '—'
                                }
                                onChange={(e) => handleParam(algo, key, e.target.value)}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Evaluation strategy: train/test split vs k-fold CV */}
      <div>
        <div className="flex items-center gap-3 mb-3">
          <label className="label m-0">Evaluation strategy</label>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            <button
              onClick={() => setConfigValue(['model', 'use_cv'], false)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${!use_cv ? 'bg-indigo-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
            >
              Train / Test Split
            </button>
            <button
              onClick={() => setConfigValue(['model', 'use_cv'], true)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-gray-200 ${use_cv ? 'bg-indigo-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
            >
              Cross-Validation
            </button>
          </div>
        </div>

        {!use_cv ? (
          <>
            <label className="label">
              Test split — {Math.round((test_split ?? 0.2) * 100)}% held out for evaluation
            </label>
            <input
              type="range" min="0.1" max="0.5" step="0.05"
              value={test_split ?? 0.2}
              onChange={(e) => setConfigValue(['model', 'test_split'], parseFloat(e.target.value))}
              className="w-full accent-indigo-600"
            />
            <div className="flex justify-between text-xs text-gray-400 mt-0.5">
              <span>10%</span><span>50%</span>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-4">
            <div>
              <label className="label">Folds</label>
              <input
                type="number" className="input w-24"
                min={2} max={20}
                value={cv_folds ?? 5}
                onChange={(e) => setConfigValue(['model', 'cv_folds'], parseInt(e.target.value, 10) || 5)}
              />
            </div>
            <p className="text-xs text-gray-400 mt-4">
              Dataset is split into {cv_folds ?? 5} equal parts; each part is used as the validation set once
            </p>
          </div>
        )}
      </div>

      {/* Random seed */}
      <div>
        <label className="label">
          Random seed
          <span className="ml-1 font-normal text-gray-400">(leave blank for non-deterministic)</span>
        </label>
        <input
          type="number" className="input w-32"
          placeholder="e.g. 42"
          value={random_state ?? ''}
          onChange={(e) => {
            const v = e.target.value === '' ? null : parseInt(e.target.value, 10)
            setConfigValue(['model', 'random_state'], v)
          }}
        />
      </div>
    </div>
  )
}
