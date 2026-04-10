/**
 * Axios wrapper for all pySAR API calls.
 * All requests hit the /api prefix which Vite proxies to http://localhost:8000.
 */
import axios from 'axios'

const client = axios.create({
  baseURL: '/api',
  timeout: 30_000,
})

// ── Dataset ────────────────────────────────────────────────────────────────────

/**
 * Upload a dataset file.
 * @param {File} file
 * @param {(pct: number) => void} onProgress
 * @returns {Promise<object>} server response with preview + metadata
 */
export async function uploadDataset(file, onProgress) {
  const form = new FormData()
  form.append('file', file)
  const { data } = await client.post('/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100))
    },
  })
  return data
}

/**
 * Upload a pre-calculated descriptors CSV file.
 * @param {File} file
 * @param {(pct: number) => void} onProgress
 * @returns {Promise<object>} { file_id, file_path, filename, columns, numeric_columns, shape, preview }
 */
export async function uploadDescriptorsCSV(file, onProgress) {
  const form = new FormData()
  form.append('file', file)
  const { data } = await client.post('/upload-descriptors', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100))
    },
  })
  return data
}

// ── Encoding jobs ──────────────────────────────────────────────────────────────

/**
 * Submit an encoding job and return the job_id.
 * @param {object} payload  Matches EncodeRequest Pydantic model
 * @returns {Promise<{job_id: string}>}
 */
export async function startEncoding(payload) {
  const { data } = await client.post('/encode', payload)
  return data
}

/**
 * Poll for a job's current status + results.
 * @param {string} jobId
 * @returns {Promise<object>} job object
 */
export async function getJob(jobId) {
  const { data } = await client.get(`/jobs/${jobId}`)
  return data
}

/**
 * Delete a finished job from the server registry.
 * @param {string} jobId
 */
export async function deleteJob(jobId) {
  await client.delete(`/jobs/${jobId}`)
}

/**
 * Request cancellation of a running job.
 * @param {string} jobId
 */
export async function cancelJob(jobId) {
  const { data } = await client.post(`/jobs/${jobId}/cancel`)
  return data
}

/**
 * Retrieve the list of all jobs (no results payload).
 * @returns {Promise<object[]>}
 */
export async function listJobs() {
  const { data } = await client.get('/jobs')
  return data
}

// ── Dataset rows ───────────────────────────────────────────────────────────────

/**
 * Fetch all rows for an uploaded dataset.
 * @param {string} fileId
 * @returns {Promise<{rows: object[], total: number}>}
 */
export async function getDatasetRows(fileId) {
  const { data } = await client.get(`/dataset/${fileId}/rows`)
  return data
}

/**
 * Deduplicate an uploaded dataset by sequence column; returns new file metadata.
 * @param {string} fileId
 * @param {string} seqCol
 * @returns {Promise<object>}
 */
export async function deduplicateDataset(fileId, seqCol) {
  const { data } = await client.post(`/dataset/${fileId}/deduplicate`, null, {
    params: { seq_col: seqCol },
  })
  return data
}

/** Remove rows with null/empty sequences; returns refreshed dataset response. */
export async function fixMissingSequences(fileId, seqCol, actCol) {
  const { data } = await client.post(`/dataset/${fileId}/fix-missing-sequences`, null, {
    params: { seq_col: seqCol, act_col: actCol },
  })
  return data
}

/**
 * Remediate missing activity values.
 * @param {string} method  'mean' | 'median' | 'remove'
 */
export async function fixMissingActivity(fileId, seqCol, actCol, method) {
  const { data } = await client.post(`/dataset/${fileId}/fix-missing-activity`, null, {
    params: { seq_col: seqCol, act_col: actCol, method },
  })
  return data
}

/**
 * Remediate outlier activity values.
 * @param {string} method  'winsorize' | 'remove'
 */
export async function fixOutliers(fileId, seqCol, actCol, method) {
  const { data } = await client.post(`/dataset/${fileId}/fix-outliers`, null, {
    params: { seq_col: seqCol, act_col: actCol, method },
  })
  return data
}

/**
 * List available built-in sample datasets.
 * @returns {Promise<{datasets: object[]}>}
 */
export async function getExampleDatasets() {
  const { data } = await client.get('/example-datasets')
  return data
}

/**
 * Load a built-in sample dataset by name; returns same shape as uploadDataset.
 * @param {string} name
 * @returns {Promise<object>}
 */
export async function loadExampleDataset(name) {
  const { data } = await client.post(`/example-dataset/${name}`)
  return data
}

// ── AAI indices ────────────────────────────────────────────────────────────────

/**
 * Fetch all 566 AAI1 record codes for the typeahead.
 * @returns {Promise<string[]>}
 */
export async function getAaiIndices() {
  const { data } = await client.get('/aai-indices')
  return data.indices
}

/**
 * Fetch all AAI1 records with code + title for the explorer.
 * @returns {Promise<{code: string, title: string}[]>}
 */
export async function getAaiIndicesFull() {
  const { data } = await client.get('/aai-indices-full')
  return data.records
}

/**
 * Fetch the full descriptor catalogue with metadata.
 * @returns {Promise<object[]>}
 */
export async function getDescriptors() {
  const { data } = await client.get('/descriptors')
  return data.descriptors
}

// ── Health ─────────────────────────────────────────────────────────────────────

export async function checkHealth() {
  const { data } = await client.get('/health')
  return data
}
