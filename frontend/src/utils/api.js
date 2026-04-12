/**
 * Axios wrapper for all pySAR API calls.
 * In development, /api is proxied by Vite to http://localhost:8000.
 * In production, set VITE_API_URL (e.g. https://pysar-backend.fly.dev) in Vercel env vars.
 */
import axios from 'axios'
import { parseDatasetClientSide } from './parseDataset'

// Use absolute backend URL in production if provided, otherwise fall back to Vite proxy
const BASE_URL = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api'

const client = axios.create({
  baseURL: BASE_URL,
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
 * Ping the backend health endpoint. Returns true if reachable, false otherwise.
 * @returns {Promise<boolean>}
 */
export async function checkBackend() {
  try {
    await client.get('/health', { timeout: 4000 })
    return true
  } catch {
    return false
  }
}

// Hardcoded list — served as static assets from /example_datasets/, no backend needed
const EXAMPLE_DATASETS = [
  { name: 'thermostability',   filename: 'thermostability.txt',   description: 'Enzyme thermostability (T50) — 261 protein variants' },
  { name: 'absorption',        filename: 'absorption.txt',        description: 'UV absorption wavelength — 179 fluorescent protein variants' },
  { name: 'enantioselectivity',filename: 'enantioselectivity.txt',description: 'Enzyme enantioselectivity — 152 lipase variants' },
  { name: 'localization',      filename: 'localization.txt',      description: 'Subcellular localization score — protein sequences' },
]

/**
 * Return the static list of built-in sample datasets (no backend call).
 * @returns {{datasets: object[]}}
 */
export function getExampleDatasets() {
  return { datasets: EXAMPLE_DATASETS }
}

/**
 * Load a built-in sample dataset: fetches the static file from the CDN then
 * parses it entirely client-side — no backend call required.
 * The returned object includes `_pendingFile` so Step 3 can lazily upload
 * the file to the backend before submitting an encode job.
 * @param {string} name
 * @returns {Promise<object>}
 */
export async function loadExampleDataset(name) {
  const entry = EXAMPLE_DATASETS.find((d) => d.name === name)
  if (!entry) throw new Error(`Unknown example dataset: ${name}`)
  // Fetch static asset served by Vercel CDN
  const response = await fetch(`/example_datasets/${entry.filename}`)
  if (!response.ok) throw new Error(`Could not fetch example dataset file: ${response.status}`)
  const blob = await response.blob()
  const file = new File([blob], entry.filename, { type: 'text/plain' })
  return parseDatasetClientSide(file)
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
