/**
 * Unit tests for frontend/src/utils/encoding.js
 *
 * logLineClass() — maps log line strings to Tailwind colour classes.
 * estimateModels() — estimates model count for the three encoding strategies.
 * snakeToTitle() — converts snake_case descriptor keys to human-readable Title Case.
 *
 * All are pure functions; no mocking is required.
 */
import { describe, it, expect } from 'vitest'
import { logLineClass, estimateModels, snakeToTitle } from '../../utils/encoding'

// ──────────────────────────────────────────────────────────────────────────────
// logLineClass
// ──────────────────────────────────────────────────────────────────────────────

describe('logLineClass', () => {
  it('returns red for lines starting with ERROR', () => {
    expect(logLineClass('ERROR: file not found')).toBe('text-red-400')
    expect(logLineClass('error: something broke')).toBe('text-red-400')
  })

  it('returns amber for lines starting with WARNING', () => {
    expect(logLineClass('WARNING: slow convergence')).toBe('text-amber-400')
    expect(logLineClass('warning: using default')).toBe('text-amber-400')
  })

  it('returns amber for Cancelled lines', () => {
    expect(logLineClass('Cancelled by user')).toBe('text-amber-400')
    expect(logLineClass('cancelled')).toBe('text-amber-400')
  })

  it('returns emerald for lines starting with Complete', () => {
    expect(logLineClass('Complete: 566 models trained')).toBe('text-emerald-400')
    expect(logLineClass('complete')).toBe('text-emerald-400')
  })

  it('returns sky for lines starting with Strategy:', () => {
    expect(logLineClass('Strategy: aai_descriptor')).toBe('text-sky-300')
    expect(logLineClass('strategy:')).toBe('text-sky-300')
  })

  it('returns sky for lines starting with Dataset loaded', () => {
    expect(logLineClass('Dataset loaded: 120 rows')).toBe('text-sky-300')
    expect(logLineClass('dataset loaded')).toBe('text-sky-300')
  })

  it('returns default gray for ordinary informational lines', () => {
    expect(logLineClass('Running model 42 of 566')).toBe('text-gray-300')
    expect(logLineClass('Encoding sequences…')).toBe('text-gray-300')
    expect(logLineClass('')).toBe('text-gray-300')
  })

  it('matches are case-insensitive', () => {
    expect(logLineClass('ERROR something')).toBe(logLineClass('error something'))
    expect(logLineClass('WARNING something')).toBe(logLineClass('warning something'))
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// estimateModels — AAI strategy
// ──────────────────────────────────────────────────────────────────────────────

describe('estimateModels — AAI strategy', () => {
  it('defaults to 566 when aaiIndices is null', () => {
    expect(estimateModels('aai', null, null, 1, null)).toBe(566)
  })

  it('defaults to 566 when aaiIndices is empty array', () => {
    expect(estimateModels('aai', [], null, 1, null)).toBe(566)
  })

  it('uses the length of the provided indices list', () => {
    expect(estimateModels('aai', ['A', 'B', 'C'], null, 1, null)).toBe(3)
  })

  it('returns 1 for a single selected index', () => {
    expect(estimateModels('aai', ['ALTS910101'], null, 1, null)).toBe(1)
  })

  it('respects the maxModels hard cap', () => {
    expect(estimateModels('aai', null, null, 1, 10)).toBe(10)
  })

  it('max cap has no effect when larger than pool', () => {
    expect(estimateModels('aai', ['A', 'B'], null, 1, 100)).toBe(2)
  })

  it('ignores string maxModels of zero (falls back to full pool)', () => {
    // parseInt('0') === 0, which is falsy — backend would ignore it too
    expect(estimateModels('aai', null, null, 1, '0')).toBe(566)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// estimateModels — Descriptor strategy
// ──────────────────────────────────────────────────────────────────────────────

describe('estimateModels — Descriptor strategy', () => {
  it('defaults to 33 when selectedDescs is null and combo=1', () => {
    // 33 matches _DEFAULT_DESC_COUNT in the backend and the allDescCount default in estimateModels
    expect(estimateModels('descriptor', null, null, 1, null)).toBe(33)
  })

  it('C(3,1) = 3 for 3 descriptors and combo=1', () => {
    expect(estimateModels('descriptor', null, ['a', 'b', 'c'], 1, null)).toBe(3)
  })

  it('C(3,1)+C(3,2) = 6 for 3 descriptors and combo=2', () => {
    expect(estimateModels('descriptor', null, ['a', 'b', 'c'], 2, null)).toBe(6)
  })

  it('C(3,1)+C(3,2)+C(3,3) = 7 for 3 descriptors and combo=3', () => {
    expect(estimateModels('descriptor', null, ['a', 'b', 'c'], 3, null)).toBe(7)
  })

  it('C(4,1)+C(4,2)+C(4,3) = 14 for 4 descriptors and combo=3', () => {
    expect(estimateModels('descriptor', null, ['a', 'b', 'c', 'd'], 3, null)).toBe(14)
  })

  it('1 descriptor with combo=1 → 1 model', () => {
    expect(estimateModels('descriptor', null, ['aac'], 1, null)).toBe(1)
  })

  it('combo=0 treated as combo=1', () => {
    expect(estimateModels('descriptor', null, ['a', 'b'], 0, null)).toBe(2)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// estimateModels — AAI+Descriptor strategy
// ──────────────────────────────────────────────────────────────────────────────

describe('estimateModels — AAI + Descriptor strategy', () => {
  it('2 AAI × C(2,1)=2 descriptors = 4 total', () => {
    expect(estimateModels('aai_descriptor', ['A', 'B'], ['x', 'y'], 1, null)).toBe(4)
  })

  it('2 AAI × (C(3,1)+C(3,2))=6 = 12 total', () => {
    expect(estimateModels('aai_descriptor', ['A', 'B'], ['x', 'y', 'z'], 2, null)).toBe(12)
  })

  it('respects maxModels cap in combined strategy', () => {
    // 566 × 12 = 6792 default; cap at 100
    expect(estimateModels('aai_descriptor', null, null, 1, 100)).toBe(100)
  })

  it('uses default 566 when aaiIndices is null', () => {
    // 566 × C(2,1) = 1132
    expect(estimateModels('aai_descriptor', null, ['a', 'b'], 1, null)).toBe(1132)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// estimateModels — edge cases
// ──────────────────────────────────────────────────────────────────────────────

describe('estimateModels — edge cases', () => {
  it('returns 0 for an unknown strategy', () => {
    expect(estimateModels('unknown_strategy', null, null, 1, null)).toBe(0)
  })

  it('returns 0 for empty string strategy', () => {
    expect(estimateModels('', null, null, 1, null)).toBe(0)
  })

  it('returns 0 for null strategy', () => {
    expect(estimateModels(null, null, null, 1, null)).toBe(0)
  })

  it('string maxModels is parsed as integer', () => {
    expect(estimateModels('aai', null, null, 1, '10')).toBe(10)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// snakeToTitle
// ──────────────────────────────────────────────────────────────────────────────

describe('snakeToTitle', () => {
  it('converts single-word keys to Title Case', () => {
    expect(snakeToTitle('aromaticity')).toBe('Aromaticity')
    expect(snakeToTitle('hydrophobicity')).toBe('Hydrophobicity')
  })

  it('replaces underscores with spaces and title-cases each word', () => {
    expect(snakeToTitle('moran_autocorrelation')).toBe('Moran Autocorrelation')
    expect(snakeToTitle('amino_acid_composition')).toBe('Amino Acid Composition')
    expect(snakeToTitle('shannon_entropy')).toBe('Shannon Entropy')
    expect(snakeToTitle('aggregation_propensity')).toBe('Aggregation Propensity')
  })

  it('uppercases the CTD acronym', () => {
    expect(snakeToTitle('ctd')).toBe('CTD')
    expect(snakeToTitle('ctd_composition')).toBe('CTD Composition')
    expect(snakeToTitle('ctd_distribution')).toBe('CTD Distribution')
    expect(snakeToTitle('ctd_transition')).toBe('CTD Transition')
  })

  it('uppercases the AAI acronym', () => {
    expect(snakeToTitle('aai_encoding')).toBe('AAI Encoding')
  })

  it('uppercases the PAAC acronym', () => {
    expect(snakeToTitle('pseudo_amino_acid_composition')).toBe('Pseudo Amino Acid Composition')
    expect(snakeToTitle('amphiphilic_pseudo_amino_acid_composition')).toBe(
      'Amphiphilic Pseudo Amino Acid Composition'
    )
    // paac as a standalone word
    expect(snakeToTitle('paac')).toBe('PAAC')
  })

  it('uppercases the DSP acronym', () => {
    expect(snakeToTitle('dsp_filter')).toBe('DSP Filter')
  })

  it('handles already-single-word lowercase strings', () => {
    expect(snakeToTitle('boman_index')).toBe('Boman Index')
    expect(snakeToTitle('aliphatic_index')).toBe('Aliphatic Index')
  })
})
