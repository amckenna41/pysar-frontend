/**
 * Shared dataset fixtures for E2E tests.
 *
 * These are plain text buffers used with Playwright's setInputFiles() to
 * simulate file uploads without needing real files on disk.
 */

/** 20-row thermostability-like CSV: sequence (standard AA) + T50 activity */
export const THERMO_CSV = [
  'sequence,T50',
  'ACDEFGHIKLMNPQRSTVWY,55.0',
  'CDEFGHIKLMNPQRSTVWYA,60.3',
  'DEFGHIKLMNPQRSTVWYAC,50.1',
  'EFGHIKLMNPQRSTVWYACD,65.7',
  'FGHIKLMNPQRSTVWYACDE,58.2',
  'GHIKLMNPQRSTVWYACDEF,72.0',
  'HIKLMNPQRSTVWYACDEFG,48.9',
  'IKLMNPQRSTVWYACDEFGH,61.5',
  'KLMNPQRSTVWYACDEFGHI,54.3',
  'LMNPQRSTVWYACDEFGHIK,69.8',
  'MNPQRSTVWYACDEFGHIKL,57.6',
  'NPQRSTVWYACDEFGHIKLM,63.1',
  'PQRSTVWYACDEFGHIKLMN,52.4',
  'QRSTVWYACDEFGHIKLMNP,66.9',
  'RSTVWYACDEFGHIKLMNPQ,51.2',
  'STVWYACDEFGHIKLMNPQR,70.4',
  'TVWYACDEFGHIKLMNPQRS,49.7',
  'VWYACDEFGHIKLMNPQRST,64.2',
  'WYACDEFGHIKLMNPQRSTV,53.8',
  'YACDEFGHIKLMNPQRSTVW,67.3',
].join('\n')

/** Small 3-row CSV for fast upload tests */
export const SMALL_CSV = [
  'sequence,T50',
  'ACDE,55.0',
  'FGHI,60.0',
  'KLMN,65.0',
].join('\n')

/** CSV with an invalid amino acid character in row 2 */
export const INVALID_AA_CSV = [
  'sequence,T50',
  'ACDE,55.0',
  'AC123DE,60.0',
  'FGHI,65.0',
].join('\n')

/** CSV with one duplicate sequence */
export const DUPLICATE_CSV = [
  'sequence,T50',
  'ACDE,55.0',
  'ACDE,61.3',
  'FGHI,60.0',
].join('\n')

/** Buffer helper: convert a string to a Buffer for setInputFiles */
export function toBuffer(str) {
  return Buffer.from(str, 'utf-8')
}

/**
 * Canned /api/upload response for SMALL_CSV, shaped like the real backend
 * response. Used to mock the upload route so tests that only need Step 1
 * completed (configure/encode/results specs) don't burn the real 20-req/60s
 * upload rate limit shared with upload.spec.js's real-upload tests.
 */
export function mockUploadResponse() {
  return {
    file_id: 'mock-file-id',
    filename: 'test.csv',
    file_path: '/tmp/mock-file-id.csv',
    columns: ['sequence', 'T50'],
    num_rows: 3,
    preview: [
      { sequence: 'ACDE', T50: 55.0 },
      { sequence: 'FGHI', T50: 60.0 },
      { sequence: 'KLMN', T50: 65.0 },
    ],
    seq_col_guess: 'sequence',
    act_col_guess: 'T50',
    seq_guess_confidence: 'high',
    act_guess_confidence: 'high',
    length_stats: { min: 4, max: 4, mean: 4.0, distribution: [{ bin: 4, count: 3 }] },
    activity_stats: { min: 55.0, max: 65.0, mean: 60.0, std: 5.0, skewness: 0.0, kurtosis: null, histogram: [], log_histogram: [] },
    seq_validation: { valid: true, invalid_count: 0, warnings: [], invalid_row_indices: [], invalid_rows: [] },
    duplicate_info: { has_duplicates: false, duplicate_count: 0, unique_count: 3, duplicate_row_indices: [], duplicate_rows: [] },
    missing_info: { seq_missing: 0, act_missing: 0, has_missing: false, seq_missing_row_indices: [], act_missing_row_indices: [], seq_missing_rows: [], act_missing_rows: [] },
    outlier_info: { outlier_count: 0, outlier_indices: [], outlier_values: [], outlier_rows: [] },
  }
}
