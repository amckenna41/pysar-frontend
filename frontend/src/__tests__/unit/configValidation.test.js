/**
 * Unit tests for frontend/src/utils/configValidation.js
 *
 * Tests cover every validation branch in validateConfig() and all paths
 * through countDiffs(). These are pure functions with no side effects.
 */
import { describe, it, expect } from 'vitest'
import {
  validateConfig,
  countDiffs,
  VALID_ALGORITHMS,
  VALID_SPECTRA,
  VALID_WINDOWS,
  VALID_FILTERS,
} from '../../utils/configValidation'
import { DEFAULT_CONFIG } from '../../store/appStore'

// ── helpers ────────────────────────────────────────────────────────────────────

/** Deep clone DEFAULT_CONFIG so tests can mutate freely. */
function base() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG))
}

// ──────────────────────────────────────────────────────────────────────────────
// Exported constants
// ──────────────────────────────────────────────────────────────────────────────

describe('configValidation — constants', () => {
  it('VALID_ALGORITHMS is a non-empty array of strings', () => {
    expect(Array.isArray(VALID_ALGORITHMS)).toBe(true)
    expect(VALID_ALGORITHMS.length).toBeGreaterThan(0)
    expect(VALID_ALGORITHMS.every((a) => typeof a === 'string')).toBe(true)
  })

  it('VALID_SPECTRA contains power, absolute, real, imaginary', () => {
    expect(VALID_SPECTRA).toContain('power')
    expect(VALID_SPECTRA).toContain('absolute')
    expect(VALID_SPECTRA).toContain('real')
    expect(VALID_SPECTRA).toContain('imaginary')
  })

  it('VALID_WINDOWS contains common window names', () => {
    expect(VALID_WINDOWS).toContain('hamming')
    expect(VALID_WINDOWS).toContain('hann')
    expect(VALID_WINDOWS).toContain('blackman')
  })

  it('VALID_FILTERS contains null as a valid value', () => {
    expect(VALID_FILTERS).toContain(null)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// validateConfig — happy paths
// ──────────────────────────────────────────────────────────────────────────────

describe('validateConfig — valid configs', () => {
  it('returns empty array for DEFAULT_CONFIG', () => {
    expect(validateConfig(DEFAULT_CONFIG)).toEqual([])
  })

  it('returns empty array for null/undefined (graceful fallback)', () => {
    expect(validateConfig(null)).toEqual([])
    expect(validateConfig(undefined)).toEqual([])
  })

  it('returns empty array for empty object', () => {
    expect(validateConfig({})).toEqual([])
  })

  it('returns empty array for each valid algorithm', () => {
    for (const algo of VALID_ALGORITHMS) {
      const cfg = base()
      cfg.model.algorithm = algo
      expect(validateConfig(cfg)).toEqual([])
    }
  })

  it('returns empty array when test_split is 0.2', () => {
    const cfg = base()
    cfg.model.test_split = 0.2
    expect(validateConfig(cfg)).toEqual([])
  })

  it('returns empty array when cv_folds is 10', () => {
    const cfg = base()
    cfg.model.cv_folds = 10
    expect(validateConfig(cfg)).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// validateConfig — model errors
// ──────────────────────────────────────────────────────────────────────────────

describe('validateConfig — model validation', () => {
  it('flags an unrecognised algorithm', () => {
    const cfg = base()
    cfg.model.algorithm = 'notanalgorithm'
    const errors = validateConfig(cfg)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/notanalgorithm/)
  })

  it('ignores algorithm case (ridge vs RIDGE)', () => {
    const cfg = base()
    cfg.model.algorithm = 'RIDGE'
    expect(validateConfig(cfg)).toEqual([])
  })

  it('flags model.algorithms when not an array', () => {
    const cfg = base()
    cfg.model.algorithms = 'ridge'  // should be an array
    const errors = validateConfig(cfg)
    expect(errors.some((e) => e.includes('array'))).toBe(true)
  })

  it('flags unknown algorithms in model.algorithms array', () => {
    const cfg = base()
    cfg.model.algorithms = ['ridge', 'bogus_algo']
    const errors = validateConfig(cfg)
    expect(errors.some((e) => e.includes('bogus_algo'))).toBe(true)
  })

  it('accepts a valid algorithms array', () => {
    const cfg = base()
    cfg.model.algorithms = ['ridge', 'lasso']
    expect(validateConfig(cfg)).toEqual([])
  })

  it('flags test_split of 0 (not strictly positive)', () => {
    const cfg = base()
    cfg.model.test_split = 0
    expect(validateConfig(cfg).some((e) => e.includes('test_split'))).toBe(true)
  })

  it('flags test_split of 1 (not strictly less than 1)', () => {
    const cfg = base()
    cfg.model.test_split = 1
    expect(validateConfig(cfg).some((e) => e.includes('test_split'))).toBe(true)
  })

  it('flags test_split > 1', () => {
    const cfg = base()
    cfg.model.test_split = 1.5
    expect(validateConfig(cfg).some((e) => e.includes('test_split'))).toBe(true)
  })

  it('flags cv_folds of 1 (below minimum)', () => {
    const cfg = base()
    cfg.model.cv_folds = 1
    expect(validateConfig(cfg).some((e) => e.includes('cv_folds'))).toBe(true)
  })

  it('flags cv_folds of 21 (above maximum)', () => {
    const cfg = base()
    cfg.model.cv_folds = 21
    expect(validateConfig(cfg).some((e) => e.includes('cv_folds'))).toBe(true)
  })

  it('flags non-integer cv_folds', () => {
    const cfg = base()
    cfg.model.cv_folds = 4.5
    expect(validateConfig(cfg).some((e) => e.includes('cv_folds'))).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// validateConfig — pyDSP errors
// ──────────────────────────────────────────────────────────────────────────────

describe('validateConfig — pyDSP validation', () => {
  it('does not validate DSP fields when use_dsp is falsy', () => {
    const cfg = base()
    cfg.pyDSP.use_dsp = false
    cfg.pyDSP.spectrum = 'invalid_spectrum'  // would normally be an error
    expect(validateConfig(cfg)).toEqual([])
  })

  it('flags invalid spectrum when use_dsp is truthy', () => {
    const cfg = base()
    cfg.pyDSP.use_dsp = true
    cfg.pyDSP.spectrum = 'invalid_spectrum'
    expect(validateConfig(cfg).some((e) => e.includes('spectrum'))).toBe(true)
  })

  it('accepts each valid spectrum type when use_dsp is true', () => {
    for (const spectrum of VALID_SPECTRA) {
      const cfg = base()
      cfg.pyDSP.use_dsp = true
      cfg.pyDSP.spectrum = spectrum
      const errors = validateConfig(cfg)
      expect(errors.filter((e) => e.includes('spectrum'))).toHaveLength(0)
    }
  })

  it('flags invalid window type when use_dsp is true', () => {
    const cfg = base()
    cfg.pyDSP.use_dsp = true
    cfg.pyDSP.window = { type: 'badwindow' }
    expect(validateConfig(cfg).some((e) => e.includes('window'))).toBe(true)
  })

  it('flags even window_length when use_dsp is true', () => {
    const cfg = base()
    cfg.pyDSP.use_dsp = true
    cfg.pyDSP.filter = { type: 'savgol', window_length: 4 }  // even number
    expect(validateConfig(cfg).some((e) => e.includes('window_length'))).toBe(true)
  })

  it('flags window_length of 0 (not positive)', () => {
    const cfg = base()
    cfg.pyDSP.use_dsp = true
    cfg.pyDSP.filter = { type: 'savgol', window_length: 0 }
    expect(validateConfig(cfg).some((e) => e.includes('window_length'))).toBe(true)
  })

  it('accepts odd window_length when use_dsp is true', () => {
    const cfg = base()
    cfg.pyDSP.use_dsp = true
    cfg.pyDSP.filter = { type: 'savgol', window_length: 5 }  // valid odd
    expect(validateConfig(cfg).filter((e) => e.includes('window_length'))).toHaveLength(0)
  })

  it('flags invalid filter type when use_dsp is true', () => {
    const cfg = base()
    cfg.pyDSP.use_dsp = true
    cfg.pyDSP.filter = { type: 'badfilter' }
    expect(validateConfig(cfg).some((e) => e.includes('filter.type'))).toBe(true)
  })

  it('accepts filter.type of null when use_dsp is true', () => {
    const cfg = base()
    cfg.pyDSP.use_dsp = true
    cfg.pyDSP.filter = { type: null }
    expect(validateConfig(cfg).filter((e) => e.includes('filter.type'))).toHaveLength(0)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// validateConfig — descriptors
// ──────────────────────────────────────────────────────────────────────────────

describe('validateConfig — descriptors', () => {
  it('accepts descriptors as a plain object', () => {
    const cfg = base()
    cfg.descriptors = { amino_acid_composition: {} }
    expect(validateConfig(cfg)).toEqual([])
  })

  it('flags descriptors when it is an array', () => {
    const cfg = base()
    cfg.descriptors = ['aac', 'dpc']
    expect(validateConfig(cfg).some((e) => e.includes('descriptors'))).toBe(true)
  })

  it('flags descriptors when it is a string', () => {
    const cfg = base()
    cfg.descriptors = 'aac'
    expect(validateConfig(cfg).some((e) => e.includes('descriptors'))).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// countDiffs
// ──────────────────────────────────────────────────────────────────────────────

describe('countDiffs', () => {
  it('returns 0 when current equals defaults', () => {
    expect(countDiffs(DEFAULT_CONFIG, DEFAULT_CONFIG)).toBe(0)
  })

  it('returns 0 for two empty objects', () => {
    expect(countDiffs({}, {})).toBe(0)
  })

  it('counts one diff for a changed scalar field', () => {
    const current = { model: { algorithm: 'ridge', test_split: 0.2 } }
    const defaults = { model: { algorithm: 'plsregression', test_split: 0.2 } }
    expect(countDiffs(current, defaults)).toBe(1)
  })

  it('counts diffs recursively into nested objects', () => {
    const current = {
      model: { algorithm: 'ridge', test_split: 0.3 },
    }
    const defaults = {
      model: { algorithm: 'plsregression', test_split: 0.2 },
    }
    expect(countDiffs(current, defaults)).toBe(2)
  })

  it('counts a changed array as 1 diff', () => {
    const current = { model: { algorithms: ['ridge', 'lasso'] } }
    const defaults = { model: { algorithms: ['plsregression'] } }
    expect(countDiffs(current, defaults)).toBe(1)
  })

  it('counts a new key in current that is absent from defaults as 1 diff', () => {
    const current  = { model: { algorithm: 'plsregression', extra_key: 42 } }
    const defaults = { model: { algorithm: 'plsregression' } }
    expect(countDiffs(current, defaults)).toBe(1)
  })

  it('counts a key absent from current but present in defaults as 1 diff', () => {
    const current  = { model: { test_split: 0.2 } }
    const defaults = { model: { algorithm: 'plsregression', test_split: 0.2 } }
    expect(countDiffs(current, defaults)).toBe(1)
  })

  it('handles null values gracefully', () => {
    expect(countDiffs(null, null)).toBe(0)
    expect(countDiffs(null, {})).toBe(0)
    expect(countDiffs({}, null)).toBe(0)
  })

  it('does not mutate input objects', () => {
    const cfg = base()
    const snapshot = JSON.stringify(cfg)
    countDiffs(cfg, DEFAULT_CONFIG)
    expect(JSON.stringify(cfg)).toBe(snapshot)
  })
})
