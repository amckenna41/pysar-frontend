import toast from 'react-hot-toast'

// Map Axios errors to user-friendly messages
export function formatApiError(err) {
  if (err?.response?.status === 413) return 'File too large — please upload a smaller file'
  if (err?.response?.status === 429) {
    // Surface the Retry-After header as a countdown hint when present
    const retryAfter = err?.response?.headers?.['retry-after']
    const base = err?.response?.data?.detail ?? 'Rate limit exceeded — too many requests'
    return retryAfter ? `${base} (retry in ${retryAfter}s)` : String(base)
  }
  if (err?.response?.status === 422) {
    const detail = err?.response?.data?.detail
    // Pydantic v2 returns detail as an array of {loc, msg, input, ctx} objects
    if (Array.isArray(detail)) {
      return detail.map((e) => e.msg ?? String(e)).join('; ') || 'Validation error'
    }
    return String(detail ?? 'Validation error')
  }
  if (err?.code === 'ECONNABORTED') return 'Request timed out — check the backend is running'
  if (err?.response?.data?.detail) {
    const detail = err.response.data.detail
    // Guard against non-string detail values (e.g. arrays) from other endpoints
    return Array.isArray(detail)
      ? detail.map((e) => e.msg ?? String(e)).join('; ')
      : String(detail)
  }
  if (err?.message) return err.message
  return 'An unexpected error occurred'
}

// Maps a failed job's stable error_code (see backend _JobError) to an actionable
// message, so the UI can branch on the code instead of pattern-matching free text.
// Codes with no hint (null) fall back to the server's already-specific error string.
const JOB_ERROR_HINTS = {
  oom: 'Ran out of memory — reduce the dataset size, lower max_models, or narrow the encoding selection.',
  timeout: 'The job hit the time limit — lower max_models, desc_combo, or n_jobs and try again.',
  segfault: 'The encoding process crashed unexpectedly. Try a smaller dataset or a different strategy.',
  subprocess_terminated: 'The encoding process was terminated. Try reducing the dataset size or max_models.',
  encoding_error: null,
  internal: null,
}

/**
 * Human-friendly message for a failed job, preferring the error_code hint when present.
 * @param {{error_code?: string, error?: string}} job
 * @returns {string}
 */
export function jobErrorMessage(job) {
  if (!job) return 'Unknown error'
  const hint = JOB_ERROR_HINTS[job.error_code]
  return hint || job.error || 'Unknown error'
}

// Show a toast with the formatted error message
export function toastApiError(err, fallback = 'Operation failed') {
  toast.error(formatApiError(err) || fallback, { duration: 5000 })
}
