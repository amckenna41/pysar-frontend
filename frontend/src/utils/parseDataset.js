/**
 * Client-side dataset parser — mirrors backend _build_dataset_response.
 * Used to load example datasets without a backend call in Step 1.
 * The returned object includes a `_pendingFile` field so Step 3 can
 * lazily upload the file to the backend before submitting an encode job.
 */

// Standard + ambiguous amino acid characters (matches Python _VALID_AA)
const VALID_AA = new Set('ACDEFGHIKLMNPQRSTVWYacdefghiklmnpqrstvwyBZXUOJbzxuoj'.split(''))
const ACT_EXCLUDE = new Set(['sequence', 'seq', 'id', 'name', 'is_train'])

function _round(v, d = 4) {
  return Math.round(v * Math.pow(10, d)) / Math.pow(10, d)
}

function _mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function _std(arr) {
  if (arr.length < 2) return 0
  const m = _mean(arr)
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1))
}

function _skewness(arr) {
  const n = arr.length
  if (n < 3) return 0
  const m = _mean(arr)
  const s = _std(arr)
  if (s === 0) return 0
  return (n / ((n - 1) * (n - 2))) * arr.reduce((sum, v) => sum + ((v - m) / s) ** 3, 0)
}

function _kurtosis(arr) {
  const n = arr.length
  if (n < 4) return 0
  const m = _mean(arr)
  const s = _std(arr)
  if (s === 0) return 0
  const k4 = arr.reduce((sum, v) => sum + ((v - m) / s) ** 4, 0)
  return (n * (n + 1) / ((n - 1) * (n - 2) * (n - 3))) * k4 - 3 * (n - 1) ** 2 / ((n - 2) * (n - 3))
}

function _histogram(vals, bins = 20) {
  if (!vals.length) return []
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  if (lo === hi) return [{ bin: _round(lo, 4), count: vals.length }]
  const width = (hi - lo) / bins
  const buckets = new Array(bins).fill(0)
  for (const v of vals) {
    let b = Math.floor((v - lo) / width)
    b = Math.min(b, bins - 1)
    buckets[b]++
  }
  return buckets.map((count, i) => ({ bin: _round(lo + i * width, 4), count }))
}

// Simple CSV/TSV split — auto-detects comma vs tab delimiter
function _parseCSV(text) {
  const lines = text.trim().split(/\r?\n/)
  if (!lines.length) return { headers: [], rows: [] }
  // Use tab as separator if the first line contains one
  const sep = lines[0].includes('\t') ? '\t' : ','
  const headers = lines[0].split(sep)
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    const vals = lines[i].split(sep)
    const row = {}
    headers.forEach((h, j) => { row[h] = vals[j] ?? '' })
    rows.push(row)
  }
  return { headers, rows }
}

/**
 * Parse a CSV/TXT dataset file entirely in the browser.
 * Returns the same shape as the backend's _build_dataset_response plus
 * `_pendingFile` (the raw File) for lazy upload at encode time.
 *
 * @param {File} file
 * @returns {Promise<object>}
 */
export async function parseDatasetClientSide(file) {
  const text = await file.text()
  const { headers, rows } = _parseCSV(text)

  if (!headers.length || !rows.length) {
    throw new Error('Could not parse dataset file — no data found')
  }

  // Guess sequence column (name contains "seq") then activity column
  const seqCol = headers.find(h => h.toLowerCase().includes('seq')) ?? headers[0]
  const actCol = headers.find(h => !ACT_EXCLUDE.has(h.toLowerCase()) && h !== seqCol) ?? headers[headers.length - 1]

  // Parse numeric activity values
  const actVals = rows.map(r => parseFloat(r[actCol])).filter(v => !isNaN(v))

  // Sequence length stats
  const seqLengths = rows.map(r => (r[seqCol] ?? '').length)
  const length_stats = {
    min: Math.min(...seqLengths),
    max: Math.max(...seqLengths),
    mean: _round(_mean(seqLengths), 1),
    distribution: _histogram(seqLengths, 20),
  }

  // Activity stats (mirrors backend _activity_histogram + stats block)
  let activity_stats = {}
  if (actVals.length > 0) {
    const logVals = actVals.filter(v => v > -1).map(v => Math.log1p(v))
    activity_stats = {
      min:      _round(Math.min(...actVals), 4),
      max:      _round(Math.max(...actVals), 4),
      mean:     _round(_mean(actVals), 4),
      std:      _round(_std(actVals), 4),
      skewness: _round(_skewness(actVals), 3),
      kurtosis: _round(_kurtosis(actVals), 3),
      histogram:     _histogram(actVals),
      log_histogram: _histogram(logVals),
    }
  }

  // Sequence validation — flag non-standard amino acid characters
  const invalidIndices = []
  const warnings = []
  rows.forEach((r, idx) => {
    const seq = r[seqCol] ?? ''
    const bad = [...new Set([...seq].filter(c => c.trim() && !VALID_AA.has(c)))]
    if (bad.length) {
      invalidIndices.push(idx)
      if (warnings.length < 5) {
        warnings.push(`Row ${idx}: unknown character(s) ${JSON.stringify(bad)} in '${seq.slice(0, 20)}…'`)
      }
    }
  })
  const seq_validation = {
    valid:               invalidIndices.length === 0,
    invalid_count:        invalidIndices.length,
    warnings,
    invalid_row_indices:  invalidIndices,
    invalid_rows:         invalidIndices.slice(0, 50).map(i => rows[i]),
  }

  // Duplicate sequence detection
  const seen = new Map()
  const dupIndices = []
  rows.forEach((r, idx) => {
    const s = r[seqCol] ?? ''
    if (seen.has(s)) dupIndices.push(idx)
    else seen.set(s, idx)
  })
  const duplicate_info = {
    has_duplicates:        dupIndices.length > 0,
    duplicate_count:       dupIndices.length,
    unique_count:          rows.length - dupIndices.length,
    duplicate_row_indices: dupIndices.slice(0, 50),
    duplicate_rows:        dupIndices.slice(0, 50).map(i => rows[i]),
  }

  // Missing values
  const seqMissingIdx = rows.map((r, i) => (!r[seqCol]?.trim() ? i : -1)).filter(i => i >= 0)
  const actMissingIdx = rows.map((r, i) => (!r[actCol]?.trim() ? i : -1)).filter(i => i >= 0)
  const missing_info = {
    seq_missing:              seqMissingIdx.length,
    act_missing:              actMissingIdx.length,
    has_missing:              seqMissingIdx.length > 0 || actMissingIdx.length > 0,
    seq_missing_row_indices:  seqMissingIdx.slice(0, 50),
    act_missing_row_indices:  actMissingIdx.slice(0, 50),
    seq_missing_rows:         seqMissingIdx.slice(0, 50).map(i => rows[i]),
    act_missing_rows:         actMissingIdx.slice(0, 50).map(i => rows[i]),
  }

  // Outlier detection (>3σ from mean, mirrors backend _detect_outliers)
  let outlier_info = { outlier_count: 0, outlier_indices: [], outlier_values: [], outlier_rows: [] }
  if (actVals.length >= 4) {
    const m = _mean(actVals)
    const s = _std(actVals)
    if (s > 0) {
      const oIdx = [], oVals = [], oRows = []
      rows.forEach((r, idx) => {
        const v = parseFloat(r[actCol])
        if (!isNaN(v) && Math.abs(v - m) > 3 * s) {
          oIdx.push(idx)
          oVals.push(_round(v, 4))
          oRows.push(r)
        }
      })
      outlier_info = {
        outlier_count:   oIdx.length,
        outlier_indices: oIdx.slice(0, 50),
        outlier_values:  oVals.slice(0, 50),
        outlier_rows:    oRows.slice(0, 50),
        mean:            _round(m, 4),
        std:             _round(s, 4),
        threshold_delta: _round(3 * s, 4),
      }
    }
  }

  // Column confidence scores (mirrors backend _col_guess_confidence)
  const seqConf = /sequence|seq|protein|peptide|aa/i.test(seqCol) ? 'high'
    : rows.slice(0, 5).every(r => /^[A-Za-z-]+$/.test(r[seqCol] ?? '')) ? 'medium' : 'low'
  const actConf = /activity|target|label|value|score|fitness|stability|t50|tm/i.test(actCol) ? 'high'
    : actVals.length > 0 ? 'medium' : 'low'

  return {
    file_id:              crypto.randomUUID(), // placeholder; resolved on first encode
    filename:             file.name,
    file_path:            null,               // null signals lazy upload needed
    columns:              headers,
    num_rows:             rows.length,
    preview:              rows.slice(0, 20),
    seq_col_guess:        seqCol,
    act_col_guess:        actCol,
    seq_guess_confidence: seqConf,
    act_guess_confidence: actConf,
    length_stats,
    activity_stats,
    seq_validation,
    duplicate_info,
    missing_info,
    outlier_info,
    _pendingFile:         file,     // valid File in-memory; NOT serializable by JSON.stringify
    _pendingFileText:     text,     // raw text content — survives Zustand persist/rehydrate
    _pendingFileName:     file.name, // original filename for File reconstruction
  }
}
