/**
 * Encoding utility functions, extracted from Step3Encode.jsx.
 * Pure functions — no React or store dependencies — so they can be
 * imported by both the component and the test suite.
 */

/**
 * Map a log line string to a Tailwind CSS colour class for severity colouring.
 *
 * @param {string} line
 * @returns {string} Tailwind text-colour class
 */
export function logLineClass(line) {
  if (/^ERROR/i.test(line))                     return 'text-red-400'
  if (/^WARNING|^Cancelled/i.test(line))         return 'text-amber-400'
  if (/^Complete/i.test(line))                   return 'text-emerald-400'
  if (/^Strategy:|^Dataset loaded/i.test(line))  return 'text-sky-300'
  return 'text-gray-300'
}

/**
 * Client-side model count estimator.
 * Mirrors backend._estimate_total_models — used to display a live estimate
 * before the job is submitted (not guaranteed to be exact).
 *
 * @param {'aai'|'descriptor'|'aai_descriptor'} strategy
 * @param {string[]|null} aaiIndices  — null / empty means "all 566"
 * @param {string[]|null} selectedDescs — null / empty means "all"
 * @param {number} descCombo — combination depth (1 = single, 2 = pairs, …)
 * @param {number|string|null} maxModels — optional hard cap
 * @param {number} [allDescCount=33] — total descriptor count when none selected;
 *   pass the live count from the descriptor catalogue fetch for accuracy.
 * @returns {number}
 */
export function estimateModels(strategy, aaiIndices, selectedDescs, descCombo, maxModels, allDescCount = 33) {
  // Binomial coefficient helper
  function comb(n, k) {
    if (k > n || k < 0) return 0
    if (k === 0 || k === n) return 1
    let r = 1
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1)
    return Math.round(r)
  }

  const nAai  = aaiIndices?.length  || 566
  const nDesc = selectedDescs?.length || allDescCount
  const combo = Math.max(1, descCombo || 1)

  let n = 0
  if (strategy === 'aai') {
    n = nAai
  } else if (strategy === 'descriptor') {
    for (let k = 1; k <= combo; k++) n += comb(nDesc, k)
  } else if (strategy === 'aai_descriptor') {
    let dCombos = 0
    for (let k = 1; k <= combo; k++) dCombos += comb(nDesc, k)
    n = nAai * dCombos
  }

  // Apply optional hard cap
  if (maxModels) n = Math.min(n, parseInt(maxModels, 10) || n)
  return n
}

/**
 * Convert a snake_case descriptor key to human-readable Title Case.
 * Recognises known acronyms (CTD, AAI, PAAC, DSP) and keeps them fully
 * uppercased rather than title-casing them.
 *
 * @param {string} key  — e.g. 'moran_autocorrelation', 'ctd_composition'
 * @returns {string}    — e.g. 'Moran Autocorrelation', 'CTD Composition'
 */
const _DESCRIPTOR_ACRONYMS = { Ctd: 'CTD', Aai: 'AAI', Paac: 'PAAC', Dsp: 'DSP' }
export function snakeToTitle(key) {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\b(Ctd|Aai|Paac|Dsp)\b/g, (w) => _DESCRIPTOR_ACRONYMS[w] ?? w)
}
