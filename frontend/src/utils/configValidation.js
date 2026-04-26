/**
 * Config validation and diff utilities, extracted from Step2Configure.jsx.
 * Pure functions — no React or store dependencies — so they can be
 * imported by both the component and the test suite.
 */

export const VALID_ALGORITHMS = [
  'plsregression', 'ridge', 'lasso', 'elasticnet', 'svr',
  'randomforest', 'gradientboosting', 'hgbr', 'knn', 'linearregression',
  'extratrees', 'bagging', 'adaboost', 'gpr', 'linear',
]
export const VALID_SPECTRA  = ['power', 'absolute', 'real', 'imaginary']
export const VALID_WINDOWS  = ['hamming', 'hann', 'blackman', 'bartlett', 'kaiser', 'boxcar', 'triang', 'flattop']
export const VALID_FILTERS  = ['savgol', 'median', 'fir', 'gauss', null]

/**
 * Validate a parsed config object.
 * Returns an array of human-readable error strings (empty = valid).
 * The config is always applied even when errors exist; callers decide how to surface them.
 *
 * @param {object} cfg
 * @returns {string[]}
 */
export function validateConfig(cfg) {
  const errors = []
  const m = cfg?.model ?? {}

  // model.algorithm
  if (m.algorithm && !VALID_ALGORITHMS.includes(m.algorithm.toLowerCase())) {
    errors.push(`model.algorithm "${m.algorithm}" is not a recognised algorithm`)
  }
  // model.algorithms (multi-select list)
  if (m.algorithms !== undefined && !Array.isArray(m.algorithms)) {
    errors.push('model.algorithms must be an array')
  }
  if (Array.isArray(m.algorithms)) {
    const bad = m.algorithms.filter((a) => !VALID_ALGORITHMS.includes((a ?? '').toLowerCase()))
    if (bad.length) errors.push(`model.algorithms contains unknown algorithm(s): ${bad.join(', ')}`)
  }
  // model.test_split: must be a number strictly between 0 and 1
  if (m.test_split !== undefined) {
    const ts = Number(m.test_split)
    if (Number.isNaN(ts) || ts <= 0 || ts >= 1) {
      errors.push(`model.test_split must be a number between 0 and 1 (got ${m.test_split})`)
    }
  }
  // model.cv_folds: integer between 2 and 20
  if (m.cv_folds !== undefined) {
    const f = Number(m.cv_folds)
    if (!Number.isInteger(f) || f < 2 || f > 20) {
      errors.push(`model.cv_folds must be an integer 2–20 (got ${m.cv_folds})`)
    }
  }

  // pyDSP section (only validated when DSP is active)
  const dsp = cfg?.pyDSP ?? {}
  if (dsp.use_dsp) {
    if (dsp.spectrum && !VALID_SPECTRA.includes(dsp.spectrum)) {
      errors.push(`pyDSP.spectrum "${dsp.spectrum}" is not valid (expected: ${VALID_SPECTRA.join(', ')})`)
    }
    const win = dsp.window?.type
    if (win && !VALID_WINDOWS.includes(win)) {
      errors.push(`pyDSP.window.type "${win}" is not a recognised window`)
    }
    const filt = dsp.filter?.type
    if (filt !== undefined && !VALID_FILTERS.includes(filt)) {
      errors.push(`pyDSP.filter.type "${filt}" is not valid (expected: ${VALID_FILTERS.filter(Boolean).join(', ')}, or null)`)
    }
    const wl = dsp.filter?.window_length
    if (wl !== undefined && (Number(wl) % 2 === 0 || Number(wl) < 1)) {
      errors.push(`pyDSP.filter.window_length must be a positive odd integer (got ${wl})`)
    }
  }

  // descriptors must be a plain object if present
  if (cfg?.descriptors !== undefined && (typeof cfg.descriptors !== 'object' || Array.isArray(cfg.descriptors))) {
    errors.push('descriptors must be a JSON object')
  }

  return errors
}

/**
 * Recursively count settings that differ between two config objects.
 * Used to drive the diff badge on the Config Preview tab.
 *
 * @param {object} current
 * @param {object} defaults
 * @param {string[]} path
 * @returns {number}
 */
export function countDiffs(current, defaults, path = []) {
  let count = 0
  const allKeys = new Set([...Object.keys(current ?? {}), ...Object.keys(defaults ?? {})])
  for (const key of allKeys) {
    const curr = current?.[key]
    const def  = defaults?.[key]
    if (
      typeof curr === 'object' && curr !== null && !Array.isArray(curr) &&
      typeof def  === 'object' && def  !== null && !Array.isArray(def)
    ) {
      count += countDiffs(curr, def, [...path, key])
    } else if (JSON.stringify(curr) !== JSON.stringify(def)) {
      count++
    }
  }
  return count
}
