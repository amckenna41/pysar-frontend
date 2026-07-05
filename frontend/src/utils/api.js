/**
 * Axios wrapper for all pySAR API calls.
 * In development, /api is proxied by Vite to http://localhost:8000.
 * In production, set VITE_API_URL to the backend Cloud Run URL in Vercel env vars (or frontend/.env.production).
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

// ── Session token — scopes job ownership server-side (see backend's
// _get_or_create_session_id). The server mints one on first contact and echoes it
// back via the X-Session-Id response header; we persist it and send it on every
// subsequent request so /api/jobs only ever shows this browser's own jobs.
const SESSION_STORAGE_KEY = 'pysar_session_id'

client.interceptors.request.use((config) => {
  const sessionId = localStorage.getItem(SESSION_STORAGE_KEY)
  if (sessionId) config.headers['X-Session-Id'] = sessionId
  return config
})

client.interceptors.response.use((response) => {
  const sessionId = response.headers?.['x-session-id']
  if (sessionId) localStorage.setItem(SESSION_STORAGE_KEY, sessionId)
  return response
})

// ── Retry interceptor — retries up to 3 times on network errors or 503/502 ────
// Uses exponential backoff (1s → 2s → 4s) to handle transient backend failures.
const MAX_RETRIES = 3
client.interceptors.response.use(null, async (error) => {
  const config = error.config
  // Only retry safe/idempotent methods; skip if already retried max times
  const isRetryable =
    !error.response ||
    error.response.status === 503 ||
    error.response.status === 502
  const attempt = config._retryCount ?? 0
  if (isRetryable && attempt < MAX_RETRIES && ['get', 'GET'].includes(config.method ?? '')) {
    config._retryCount = attempt + 1
    const delay = Math.pow(2, attempt) * 1000  // 1s, 2s, 4s
    await new Promise((res) => setTimeout(res, delay))
    return client(config)
  }
  return Promise.reject(error)
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
    timeout: 0, // unlimited — server-side processing can take longer than 30s for large files
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
    timeout: 0, // unlimited — server-side processing can take longer than 30s for large files
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
  { name: 'thermostability',   filename: 'thermostability.txt',   description: 'Enzyme thermostability (T50) — 260 protein variants' },
  { name: 'absorption',        filename: 'absorption.txt',        description: 'UV absorption wavelength — 80 fluorescent protein variants' },
  { name: 'enantioselectivity',filename: 'enantioselectivity.txt',description: 'Enzyme enantioselectivity — 151 lipase variants' },
  { name: 'localization',      filename: 'localization.txt',      description: 'Subcellular localization score — 253 protein sequences' },
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
 * Falls back to the bundled static JSON if the backend is unreachable.
 * @param {boolean|null} [backendOnline] - pass the cached availability flag to skip the network call when false
 * @returns {Promise<{code: string, title: string}[]>}
 */
export async function getAaiIndicesFull(backendOnline) {
  if (backendOnline !== false) {
    try {
      const { data } = await client.get('/aai-indices-full')
      return data.records
    } catch {
      // fall through to static fallback
    }
  }
  // Backend unavailable — use bundled static fallback
  const res = await fetch('/aai_indices.json')
  const data = await res.json()
  return data.records
}

/**
 * Fetch the full descriptor catalogue with metadata.
 * Falls back to the bundled static JSON if the backend is unreachable.
 * @returns {Promise<object[]>}
 */
export async function getDescriptors(backendOnline) {
  if (backendOnline !== false) {
    try {
      // Short timeout + no retries so the static fallback is reached immediately
      // when the backend is unavailable (bypass the retry interceptor via _retryCount)
      const { data } = await client.get('/descriptors', { timeout: 3000, _retryCount: MAX_RETRIES })
      return data.descriptors
    } catch {
      // fall through to static fallback
    }
  }
  // Backend unavailable — use bundled static fallback
  const res = await fetch('/descriptors.json')
  const data = await res.json()
  return data.descriptors
}

// ── Best model: export, predict, share (features 2 & 10) ─────────────────────────

/** Download the pickled best model as a Blob (sends the session header). */
export async function downloadBestModel(jobId) {
  const { data } = await client.get(`/jobs/${jobId}/model`, { responseType: 'blob' })
  return data
}

/**
 * Score new sequences with a job's exported best model.
 * @param {string} jobId
 * @param {string[]} sequences
 * @returns {Promise<{predictions: {sequence: string, prediction: number}[], model_name: string, task_type: string}>}
 */
export async function predictSequences(jobId, sequences) {
  const { data } = await client.post(`/jobs/${jobId}/predict`, { sequences })
  return data
}

/** Create (or fetch) a read-only share token for a completed job. */
export async function createShareLink(jobId) {
  const { data } = await client.post(`/jobs/${jobId}/share`)
  return data.share_token
}

/** Fetch a shared job's read-only results by token (no session required). */
export async function getSharedJob(token) {
  const { data } = await client.get(`/share/${token}`)
  return data
}

// ── Embedding strategy availability (feature 5) ──────────────────────────────────

/** Report whether the PLM-embedding strategy is available on this backend. */
export async function getEmbeddingStatus() {
  try {
    const { data } = await client.get('/embeddings/status', { timeout: 4000 })
    return data
  } catch {
    return { available: false, models: [], default_model: null, reason: 'Backend unreachable.' }
  }
}

// ── Health ─────────────────────────────────────────────────────────────────────

export async function checkHealth() {
  const { data } = await client.get('/health')
  return data
}
