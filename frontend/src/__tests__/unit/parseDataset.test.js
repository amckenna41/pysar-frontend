/**
 * Unit tests for frontend/src/utils/parseDataset.js
 *
 * parseDatasetClientSide(file) is a fully client-side dataset parser that
 * mirrors the backend _build_dataset_response shape. It is used in Step 1
 * to load example datasets without a backend round-trip.
 *
 * Test strategy:
 *  - Construct real File objects (jsdom supports them) with CSV/TSV content.
 *  - Assert the returned object shape matches the backend contract.
 *  - Cover edge cases: missing columns, invalid AA characters, duplicates, etc.
 */
import { describe, it, expect } from 'vitest'
import { parseDatasetClientSide } from '../../utils/parseDataset'

// ── helpers ────────────────────────────────────────────────────────────────────

/** Build a File from a plain text string. */
function textFile(name, content) {
  return new File([content], name, { type: 'text/plain' })
}

const CLEAN_CSV = `sequence,T50
ACDEFGHIKLM,55.0
NOPQRSTVWY,60.0
ACDEFGHIKLMP,65.0
NOPQRSTVWYAC,70.0
ACDEFGHIKLMNO,50.0`

const MISSING_ACTIVITY_CSV = `sequence,T50
ACDE,55.0
FGHI,
KLMN,70.0`

const INVALID_AA_CSV = `sequence,T50
ACDE,55.0
AC123DE,60.0`

const DUPLICATE_CSV = `sequence,T50
ACDE,55.0
ACDE,60.0
FGHI,70.0`

// ──────────────────────────────────────────────────────────────────────────────
// Response shape
// ──────────────────────────────────────────────────────────────────────────────

describe('parseDatasetClientSide — response shape', () => {
  it('returns all expected top-level keys for a clean CSV', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', CLEAN_CSV))
    const expected = [
      'file_id', 'filename', 'file_path', 'columns', 'num_rows', 'preview',
      'seq_col_guess', 'act_col_guess', 'seq_guess_confidence', 'act_guess_confidence',
      'length_stats', 'activity_stats', 'seq_validation', 'duplicate_info',
      'missing_info', 'outlier_info',
    ]
    for (const key of expected) {
      expect(result, `Missing key: ${key}`).toHaveProperty(key)
    }
  })

  it('num_rows matches the number of data rows in the file', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', CLEAN_CSV))
    expect(result.num_rows).toBe(5)
  })

  it('columns is an array of column name strings', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', CLEAN_CSV))
    expect(result.columns).toEqual(['sequence', 'T50'])
  })

  it('preview contains at most 20 rows', async () => {
    // Build a CSV with 30 rows
    const header = 'sequence,T50\n'
    const rows = Array.from({ length: 30 }, (_, i) => `ACDE${i},${50 + i}.0`).join('\n')
    const result = await parseDatasetClientSide(textFile('data.csv', header + rows))
    expect(result.preview.length).toBeLessThanOrEqual(20)
  })

  it('preview rows are plain objects with column keys', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', CLEAN_CSV))
    expect(result.preview[0]).toMatchObject({ sequence: expect.any(String), T50: expect.any(String) })
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Column guessing
// ──────────────────────────────────────────────────────────────────────────────

describe('parseDatasetClientSide — column guessing', () => {
  it('guesses "sequence" as the sequence column', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', CLEAN_CSV))
    expect(result.seq_col_guess).toBe('sequence')
  })

  it('guesses "T50" as the activity column', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', CLEAN_CSV))
    expect(result.act_col_guess).toBe('T50')
  })

  it('assigns high confidence to standard column names', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', CLEAN_CSV))
    expect(result.seq_guess_confidence).toBe('high')
    expect(result.act_guess_confidence).toBe('high')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Length stats
// ──────────────────────────────────────────────────────────────────────────────

describe('parseDatasetClientSide — length_stats', () => {
  it('reports correct min length', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', CLEAN_CSV))
    expect(result.length_stats.min).toBe(10)  // "NOPQRSTVWY".length === 10
  })

  it('reports correct max length', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', CLEAN_CSV))
    expect(result.length_stats.max).toBe(13)  // "ACDEFGHIKLMNO".length === 13
  })

  it('includes a distribution array', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', CLEAN_CSV))
    expect(Array.isArray(result.length_stats.distribution)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Activity stats
// ──────────────────────────────────────────────────────────────────────────────

describe('parseDatasetClientSide — activity_stats', () => {
  it('reports correct min activity', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', CLEAN_CSV))
    expect(result.activity_stats.min).toBe(50.0)
  })

  it('reports correct max activity', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', CLEAN_CSV))
    expect(result.activity_stats.max).toBe(70.0)
  })

  it('reports mean activity', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', CLEAN_CSV))
    expect(result.activity_stats.mean).toBeCloseTo(60.0, 1)
  })

  it('includes a histogram', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', CLEAN_CSV))
    expect(Array.isArray(result.activity_stats.histogram)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Sequence validation
// ──────────────────────────────────────────────────────────────────────────────

describe('parseDatasetClientSide — seq_validation', () => {
  it('reports valid=true for clean amino acid data', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', CLEAN_CSV))
    expect(result.seq_validation.valid).toBe(true)
    expect(result.seq_validation.invalid_count).toBe(0)
  })

  it('flags invalid amino acid characters', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', INVALID_AA_CSV))
    expect(result.seq_validation.valid).toBe(false)
    expect(result.seq_validation.invalid_count).toBe(1)
  })

  it('includes warnings array', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', INVALID_AA_CSV))
    expect(Array.isArray(result.seq_validation.warnings)).toBe(true)
    expect(result.seq_validation.warnings.length).toBeGreaterThan(0)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Duplicate detection
// ──────────────────────────────────────────────────────────────────────────────

describe('parseDatasetClientSide — duplicate_info', () => {
  it('has_duplicates=false for clean data', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', CLEAN_CSV))
    expect(result.duplicate_info.has_duplicates).toBe(false)
  })

  it('has_duplicates=true for data with repeated sequence', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', DUPLICATE_CSV))
    expect(result.duplicate_info.has_duplicates).toBe(true)
    expect(result.duplicate_info.duplicate_count).toBe(1)
  })

  it('unique_count reflects distinct sequences', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', DUPLICATE_CSV))
    expect(result.duplicate_info.unique_count).toBe(2)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Missing value detection
// ──────────────────────────────────────────────────────────────────────────────

describe('parseDatasetClientSide — missing_info', () => {
  it('has_missing=false for clean data', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', CLEAN_CSV))
    expect(result.missing_info.has_missing).toBe(false)
  })

  it('detects missing activity value', async () => {
    const result = await parseDatasetClientSide(textFile('data.csv', MISSING_ACTIVITY_CSV))
    expect(result.missing_info.has_missing).toBe(true)
    expect(result.missing_info.act_missing).toBe(1)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// TSV parsing
// ──────────────────────────────────────────────────────────────────────────────

describe('parseDatasetClientSide — TSV files', () => {
  it('parses tab-delimited files correctly', async () => {
    const tsv = 'sequence\tT50\nACDE\t55.0\nFGHI\t60.0\n'
    const result = await parseDatasetClientSide(textFile('data.tsv', tsv))
    expect(result.num_rows).toBe(2)
    expect(result.columns).toContain('sequence')
    expect(result.columns).toContain('T50')
  })
})
