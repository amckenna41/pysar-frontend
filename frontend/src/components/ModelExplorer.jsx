import { useState } from 'react'
import { MagnifyingGlassIcon, ChevronDownIcon, ChevronRightIcon, ExclamationTriangleIcon, CheckCircleIcon, XMarkIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import { useAppStore } from '../store/appStore'

// Scikit-learn documentation links per algorithm
const SKLEARN_DOCS = {
  plsregression:    'https://scikit-learn.org/stable/modules/generated/sklearn.cross_decomposition.PLSRegression.html',
  randomforest:     'https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.RandomForestRegressor.html',
  adaboost:         'https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.AdaBoostRegressor.html',
  gradientboosting: 'https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.GradientBoostingRegressor.html',
  svr:              'https://scikit-learn.org/stable/modules/generated/sklearn.svm.SVR.html',
  knn:              'https://scikit-learn.org/stable/modules/generated/sklearn.neighbors.KNeighborsRegressor.html',
  ridge:            'https://scikit-learn.org/stable/modules/generated/sklearn.linear_model.Ridge.html',
  lasso:            'https://scikit-learn.org/stable/modules/generated/sklearn.linear_model.Lasso.html',
  elasticnet:       'https://scikit-learn.org/stable/modules/generated/sklearn.linear_model.ElasticNet.html',
  linear:           'https://scikit-learn.org/stable/modules/generated/sklearn.linear_model.LinearRegression.html',
  bagging:          'https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.BaggingRegressor.html',
  extratrees:       'https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.ExtraTreesRegressor.html',
  hgbr:             'https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.HistGradientBoostingRegressor.html',
  gpr:              'https://scikit-learn.org/stable/modules/generated/sklearn.gaussian_process.GaussianProcessRegressor.html',
}

// Full metadata for all supported ML algorithms
const ALGO_DATA = [
  {
    value: 'plsregression',
    label: 'PLS Regression',
    category: 'Linear',
    description: 'Partial Least Squares Regression projects features into latent components that maximally explain covariance with the target. Ideal for high-dimensional, collinear feature spaces typical in sequence encoding.',
    pros: ['Handles collinearity extremely well', 'Fast training and inference', 'Works well when features >> samples', 'No feature scaling required'],
    cons: ['Assumes linear relationship', 'Number of components must be tuned', 'Less effective on highly nonlinear tasks'],
    complexity: 'O(n·p·k)',
    complexityNote: 'n = samples, p = features, k = components',
    bestFor: 'High-dimensional AAI-encoded or descriptor feature matrices with correlated features.',
    scaleThreshold: null,
    defaultParams: { n_components: 2 },
  },
  {
    value: 'randomforest',
    label: 'Random Forest',
    category: 'Ensemble',
    description: 'An ensemble of independently trained decision trees, each trained on a bootstrap sample with random feature subsets. Aggregates predictions by averaging — robust to noise and overfitting.',
    pros: ['Robust to overfitting', 'Handles non-linear relationships', 'Built-in feature importance', 'No feature scaling needed'],
    cons: ['Slower than linear models', 'Memory-intensive for many trees', 'Less interpretable than single tree'],
    complexity: 'O(n·log n·p·T)',
    complexityNote: 'T = number of trees',
    bestFor: 'General-purpose regression with moderate-to-large datasets and complex non-linear patterns.',
    scaleThreshold: null,
    defaultParams: { n_estimators: 100 },
  },
  {
    value: 'adaboost',
    label: 'AdaBoost',
    category: 'Ensemble',
    description: 'Adaptive Boosting sequentially trains weak learners, reweighting samples that previous trees got wrong. The final prediction is a weighted majority vote. Sensitive to noisy data.',
    pros: ['Simple, interpretable boosting', 'Often outperforms single tree', 'Few hyperparameters to tune'],
    cons: ['Sensitive to outliers and noise', 'Can overfit with too many estimators', 'Slower than bagging approaches'],
    complexity: 'O(n·T)',
    complexityNote: 'T = number of estimators',
    bestFor: 'Clean datasets with a moderate number of features and samples.',
    scaleThreshold: null,
    defaultParams: { n_estimators: 50, learning_rate: 1.0 },
  },
  {
    value: 'gradientboosting',
    label: 'Gradient Boosting',
    category: 'Ensemble',
    description: 'Gradient Boosted Trees build an additive model by fitting each subsequent tree to the residuals of all prior trees. Powerful but requires careful tuning of learning rate and tree depth.',
    pros: ['State-of-the-art performance on tabular data', 'Handles missing values natively (HGBR)', 'Flexible loss functions'],
    cons: ['Slow to train with many estimators', 'Many hyperparameters to tune', 'Risk of overfitting without regularisation'],
    complexity: 'O(n·p·T·d)',
    complexityNote: 'T = estimators, d = max depth',
    bestFor: 'Tabular datasets where accuracy is the priority and computational cost is acceptable.',
    scaleThreshold: null,
    defaultParams: { n_estimators: 100, learning_rate: 0.1, max_depth: 3 },
  },
  {
    value: 'svr',
    label: 'Support Vector Regression',
    category: 'Kernel',
    description: 'Finds a hyperplane that fits the maximum number of data points within an epsilon tube, using support vectors. The kernel trick maps inputs into higher-dimensional spaces to capture non-linearity.',
    pros: ['Effective in high-dimensional spaces', 'Kernel trick handles non-linearity', 'Robust to outliers (ε-insensitive loss)'],
    cons: ['O(n²–n³) training — slow on large datasets', 'Requires feature scaling', 'Hard to interpret', 'Sensitive to C/ε hyperparameters'],
    complexity: 'O(n²–n³)',
    complexityNote: 'Scales poorly above ~5,000 samples',
    bestFor: 'Small-to-medium datasets (<5,000 samples) with high-dimensional features.',
    scaleThreshold: 5000,
    defaultParams: { C: 1.0, kernel: 'rbf', epsilon: 0.1 },
  },
  {
    value: 'knn',
    label: 'K-Nearest Neighbours',
    category: 'Instance-based',
    description: 'Predicts by computing the average target of the k closest training samples in feature space. Non-parametric — makes no assumptions about data distribution.',
    pros: ['No training phase', 'Captures complex local patterns', 'Non-parametric — no distribution assumptions'],
    cons: ['Slow prediction for large datasets (O(n) per query)', 'Requires feature scaling', 'High memory usage', 'Sensitive to irrelevant features'],
    complexity: 'O(n·p) per prediction',
    complexityNote: 'Brute-force distance computation',
    bestFor: 'Small-to-medium datasets (<10,000 samples) where local structure matters.',
    scaleThreshold: 10000,
    defaultParams: { n_neighbors: 5 },
  },
  {
    value: 'ridge',
    label: 'Ridge Regression',
    category: 'Linear',
    description: 'Ordinary least squares with L2 regularisation (weight decay). Shrinks coefficients toward zero to prevent overfitting in high-dimensional or collinear settings without eliminating features.',
    pros: ['Very fast training and prediction', 'Stable with collinear features', 'Closed-form solution', 'Easy to interpret'],
    cons: ['Strictly linear', 'Does not perform feature selection (all coefficients survive)', 'Cannot capture non-linearity'],
    complexity: 'O(p²·n + p³)',
    complexityNote: 'Closed-form via normal equations',
    bestFor: 'High-dimensional linear tasks with correlated features where full coefficient retention is desired.',
    scaleThreshold: null,
    defaultParams: { alpha: 1.0 },
  },
  {
    value: 'lasso',
    label: 'Lasso Regression',
    category: 'Linear',
    description: 'Least Absolute Shrinkage and Selection Operator — L1 regularisation drives sparse solutions by zeroing out irrelevant feature coefficients. Acts as simultaneous regression and feature selection.',
    pros: ['Automatic feature selection via sparsity', 'Interpretable sparse model', 'Works well with irrelevant features'],
    cons: ['Selects at most n features when p >> n', 'Unstable when features are highly correlated', 'Cannot capture non-linearity'],
    complexity: 'O(n·p·iterations)',
    complexityNote: 'Coordinate descent optimisation',
    bestFor: 'High-dimensional datasets with many irrelevant features where sparsity is desired.',
    scaleThreshold: null,
    defaultParams: { alpha: 1.0 },
  },
  {
    value: 'elasticnet',
    label: 'ElasticNet',
    category: 'Linear',
    description: 'Combines L1 (Lasso) and L2 (Ridge) penalties. Encourages sparsity while remaining stable when features are correlated — best of both regularisation worlds.',
    pros: ['Handles correlated features better than Lasso alone', 'Produces sparse solutions', 'l1_ratio allows continuous L1↔L2 control'],
    cons: ['Two hyperparameters to tune (alpha + l1_ratio)', 'Still strictly linear', 'Slower than Ridge'],
    complexity: 'O(n·p·iterations)',
    complexityNote: 'Coordinate descent optimisation',
    bestFor: 'High-dimensional datasets with groups of correlated features.',
    scaleThreshold: null,
    defaultParams: { alpha: 1.0, l1_ratio: 0.5 },
  },
  {
    value: 'linear',
    label: 'Linear Regression',
    category: 'Linear',
    description: 'Ordinary Least Squares — fits a linear model by minimising the sum of squared residuals. No regularisation. Baseline model for any regression task.',
    pros: ['Extremely fast', 'Fully interpretable coefficients', 'Zero hyperparameters'],
    cons: ['Overfits with many features', 'Requires features to be roughly independent', 'No non-linearity'],
    complexity: 'O(p²·n + p³)',
    complexityNote: 'Closed-form via normal equations',
    bestFor: 'Low-dimensional tasks or as a quick baseline before trying complex models.',
    scaleThreshold: null,
    defaultParams: {},
  },
  {
    value: 'bagging',
    label: 'Bagging Regressor',
    category: 'Ensemble',
    description: 'Bootstrap Aggregating trains multiple estimators on random subsets of training data and averages predictions. Reduces variance without increasing bias — a general-purpose variance reducer.',
    pros: ['Reduces variance', 'Parallelisable', 'Works with any base estimator'],
    cons: ['Does not reduce bias', 'Higher memory than a single model', 'Less effective than Random Forest on tabular data'],
    complexity: 'O(T · base_complexity)',
    complexityNote: 'T = number of estimators',
    bestFor: 'Reducing overfitting in high-variance base models.',
    scaleThreshold: null,
    defaultParams: { n_estimators: 10 },
  },
  {
    value: 'extratrees',
    label: 'Extra Trees',
    category: 'Ensemble',
    description: 'Extremely Randomised Trees use random split thresholds in addition to random feature subsets, making them faster to train than Random Forests at the cost of slightly higher bias.',
    pros: ['Faster training than Random Forest', 'Good generalisation', 'Built-in feature importance'],
    cons: ['Slightly higher bias than Random Forest', 'Many trees needed for stability', 'Less interpretable'],
    complexity: 'O(n·p·T)',
    complexityNote: 'Faster than Random Forest due to random splits',
    bestFor: 'Large feature spaces where training speed matters and slight extra bias is acceptable.',
    scaleThreshold: null,
    defaultParams: { n_estimators: 100 },
  },
  {
    value: 'hgbr',
    label: 'Hist Gradient Boosting',
    category: 'Ensemble',
    description: 'A histogram-based gradient boosting implementation (scikit-learn\'s LightGBM-like variant). Uses binned feature values for fast training, natively handles missing values, and scales well to large datasets.',
    pros: ['Very fast — histogram binning reduces splits', 'Handles missing values natively', 'State-of-the-art accuracy', 'Scales to hundreds of thousands of samples'],
    cons: ['Many hyperparameters', 'Risk of overfitting without early stopping', 'Black box'],
    complexity: 'O(n·T·bins)',
    complexityNote: 'bins = number of histogram bins (default 255)',
    bestFor: 'Large tabular datasets where both speed and accuracy are important.',
    scaleThreshold: null,
    defaultParams: { max_iter: 100, learning_rate: 0.1 },
  },
  {
    value: 'gpr',
    label: 'Gaussian Process',
    category: 'Probabilistic',
    description: 'A Bayesian non-parametric model that places a prior over functions. Predictions are Gaussian distributions, providing uncertainty estimates alongside point estimates. Exact inference is cubic in n.',
    pros: ['Principled uncertainty quantification', 'Flexible kernel design', 'Exact probabilistic predictions', 'Works well on small datasets'],
    cons: ['O(n³) training — prohibitively slow above ~500 samples', 'O(n²) memory', 'Kernel selection is non-trivial', 'Poorly calibrated for large n'],
    complexity: 'O(n³)',
    complexityNote: 'Cubic time and quadratic memory in n',
    bestFor: 'Small datasets (<500 samples) where uncertainty quantification is important.',
    scaleThreshold: 500,
  },
]

const CATEGORIES = ['All', 'Linear', 'Ensemble', 'Kernel', 'Instance-based', 'Probabilistic']

const CATEGORY_COLORS = {
  'Linear':         'bg-blue-100 text-blue-700',
  'Ensemble':       'bg-green-100 text-green-700',
  'Kernel':         'bg-purple-100 text-purple-700',
  'Instance-based': 'bg-amber-100 text-amber-700',
  'Probabilistic':  'bg-rose-100 text-rose-700',
}

// Returns a fitness label for the current dataset size vs the algorithm's scale threshold
function getDatasetFit(algo, numRows) {
  if (numRows === null) return null
  if (algo.scaleThreshold !== null && numRows > algo.scaleThreshold) {
    return { ok: false, label: `May be slow (${numRows.toLocaleString()} rows > ~${algo.scaleThreshold.toLocaleString()})` }
  }
  return { ok: true, label: `Good fit (${numRows.toLocaleString()} rows)` }
}

export default function ModelExplorer() {
  const { config, setConfigValue, setShowModelExplorer, dataset } = useAppStore()
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [expandedKey, setExpandedKey] = useState(null)
  // Local editable params per algorithm — seeded from existing perAlgoParameters or defaultParams
  const [editedParams, setEditedParams] = useState({})
  const numRows = dataset?.num_rows ?? null

  // Get effective params for an algorithm: user edits → saved config → defaults
  function getParams(algo) {
    if (editedParams[algo.value] !== undefined) return editedParams[algo.value]
    return { ...algo.defaultParams, ...(config.model.perAlgoParameters?.[algo.value] ?? {}) }
  }

  // Update a single param value for an algorithm in local state
  function setParam(algoValue, key, rawVal) {
    const parsed = rawVal === '' ? '' : isNaN(Number(rawVal)) ? rawVal : Number(rawVal)
    setEditedParams((prev) => ({
      ...prev,
      [algoValue]: { ...getParams({ value: algoValue, defaultParams: {} }), [key]: parsed },
    }))
  }

  // Filter by search and category
  const filtered = ALGO_DATA.filter(({ value, label, category: cat, description }) => {
    const q = search.toLowerCase()
    const matchSearch = !q || label.toLowerCase().includes(q) || cat.toLowerCase().includes(q) || description.toLowerCase().includes(q)
    const matchCat = category === 'All' || cat === category
    return matchSearch && matchCat
  })

  function selectAlgorithm(value) {
    setConfigValue(['model', 'algorithm'], value)
    // Also add to the multi-select algorithms list in Configure
    const current = config.model.algorithms ?? []
    if (!current.includes(value)) {
      setConfigValue(['model', 'algorithms'], [...current, value])
    }
    // Pre-fill any edited params into the persistent per-algo config
    const params = editedParams[value]
    if (params && Object.keys(params).length > 0) {
      Object.entries(params).forEach(([k, v]) => {
        setConfigValue(['model', 'perAlgoParameters', value, k], v)
      })
    }
    setShowModelExplorer(false)
  }

  const currentAlgo = config.model.algorithm
  const selectedAlgos = config.model.algorithms ?? []

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">

      {/* Search + category filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <MagnifyingGlassIcon className="absolute left-3 top-2.5 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            className="input pl-10 pr-8"
            placeholder="Search algorithms…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {/* Clear search */}
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
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={[
                'px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors',
                category === cat
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                  : 'border-gray-200 text-gray-600 bg-white hover:border-gray-300',
              ].join(' ')}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Results count */}
      <p className="text-xs text-gray-400">
        Showing {filtered.length} of {ALGO_DATA.length} algorithms
        {numRows !== null && ` · dataset: ${numRows.toLocaleString()} rows`}
      </p>

      {/* Algorithm cards */}
      <div className="space-y-3">
        {filtered.map((algo) => {
          const isExpanded = expandedKey === algo.value
          const isActive   = currentAlgo === algo.value || selectedAlgos.includes(algo.value)
          const fit        = getDatasetFit(algo, numRows)

          return (
            <div
              key={algo.value}
              className={[
                'rounded-xl border transition-colors overflow-hidden',
                isActive ? 'border-indigo-300 shadow-sm' : 'border-gray-200',
              ].join(' ')}
            >
              {/* Card header row */}
              <button
                onClick={() => setExpandedKey(isExpanded ? null : algo.value)}
                className="w-full flex items-center gap-3 px-4 py-3.5 bg-white hover:bg-gray-50/70 transition-colors text-left"
              >
                {/* Category badge */}
                <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${CATEGORY_COLORS[algo.category] ?? 'bg-gray-100 text-gray-600'}`}>
                  {algo.category}
                </span>

                {/* Algorithm name */}
                <span className="flex-1 text-sm font-semibold text-gray-800">{algo.label}</span>

                {/* "Currently selected" indicator */}
                {isActive && (
                  <span className="text-xs text-indigo-600 font-medium bg-indigo-50 px-2 py-0.5 rounded-full shrink-0">
                    Selected
                  </span>
                )}

                {/* Dataset fit badge */}
                {fit && (
                  fit.ok
                    ? <span className="hidden sm:flex items-center gap-1 text-xs text-green-600 shrink-0">
                        <CheckCircleIcon className="w-3.5 h-3.5" /> {fit.label}
                      </span>
                    : <span className="hidden sm:flex items-center gap-1 text-xs text-amber-600 shrink-0">
                        <ExclamationTriangleIcon className="w-3.5 h-3.5" /> {fit.label}
                      </span>
                )}

                {/* Expand chevron */}
                {isExpanded
                  ? <ChevronDownIcon className="w-4 h-4 text-gray-400 shrink-0" />
                  : <ChevronRightIcon className="w-4 h-4 text-gray-400 shrink-0" />
                }
              </button>

              {/* Expanded detail panel */}
              {isExpanded && (
                <div className="px-5 pb-5 pt-2 bg-gray-50 border-t border-gray-100 space-y-4">

                  {/* Description */}
                  <p className="text-sm text-gray-600 leading-relaxed">{algo.description}</p>

                  {/* Dataset fit warning (mobile visible) */}
                  {fit && !fit.ok && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-700">
                      <ExclamationTriangleIcon className="w-4 h-4 mt-0.5 shrink-0" />
                      <span>{fit.label} — training may be slow.</span>
                    </div>
                  )}

                  {/* Pros / Cons */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-2">Advantages</p>
                      <ul className="space-y-1">
                        {algo.pros.map((p) => (
                          <li key={p} className="text-xs text-gray-600 flex items-start gap-1.5">
                            <span className="text-green-500 shrink-0 mt-0.5">✓</span>
                            {p}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-2">Limitations</p>
                      <ul className="space-y-1">
                        {algo.cons.map((c) => (
                          <li key={c} className="text-xs text-gray-600 flex items-start gap-1.5">
                            <span className="text-red-400 shrink-0 mt-0.5">✗</span>
                            {c}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  {/* Meta-info row */}
                  <div className="flex flex-wrap gap-4 pt-1 border-t border-gray-200">
                    <div>
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Complexity</p>
                      <p className="text-xs font-mono text-gray-700 mt-0.5">{algo.complexity}</p>
                      <p className="text-xs text-gray-400">{algo.complexityNote}</p>
                    </div>
                    <div className="flex-1">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Best for</p>
                      <p className="text-xs text-gray-600 mt-0.5">{algo.bestFor}</p>
                    </div>
                  </div>

                  {/* Editable default parameters */}
                  {algo.defaultParams && Object.keys(algo.defaultParams).length > 0 && (
                    <div className="pt-1 border-t border-gray-200">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Parameters</p>
                      <div className="flex flex-wrap gap-3">
                        {Object.entries(getParams(algo)).map(([key, defaultVal]) => (
                          <label key={key} className="flex flex-col gap-0.5">
                            <span className="text-xs text-gray-500 font-mono">{key}</span>
                            <input
                              type={typeof defaultVal === 'number' ? 'number' : 'text'}
                              step="any"
                              className="input w-28 text-xs font-mono py-1"
                              value={getParams(algo)[key] ?? ''}
                              onChange={(e) => setParam(algo.value, key, e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </label>
                        ))}
                      </div>
                      <p className="text-xs text-gray-400 mt-1.5">Changes are saved when you click “Use this model”.</p>
                    </div>
                  )}

                  {/* Action + sklearn link row */}
                  <div className="flex items-center justify-between gap-3 pt-1">
                    {/* Scikit-learn docs link */}
                    {SKLEARN_DOCS[algo.value] && (
                      <a
                        href={SKLEARN_DOCS[algo.value]}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-700 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" /> scikit-learn docs
                      </a>
                    )}
                    <div className="flex-1" />
                    <button
                      onClick={() => selectAlgorithm(algo.value)}
                      disabled={isActive}
                      className={[
                        'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-indigo-100 text-indigo-400 cursor-default'
                          : 'bg-indigo-600 text-white hover:bg-indigo-700',
                      ].join(' ')}
                    >
                      {isActive ? 'Currently selected' : 'Use this model'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}

        {filtered.length === 0 && (
          <p className="text-center py-12 text-sm text-gray-400">No algorithms match your search.</p>
        )}
      </div>
    </div>
  )
}
