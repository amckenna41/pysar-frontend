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

// Show a toast with the formatted error message
export function toastApiError(err, fallback = 'Operation failed') {
  toast.error(formatApiError(err) || fallback, { duration: 5000 })
}
