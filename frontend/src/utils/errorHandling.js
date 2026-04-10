import toast from 'react-hot-toast'

// Map Axios errors to user-friendly messages
export function formatApiError(err) {
  if (err?.response?.status === 413) return 'File too large — please upload a smaller file'
  if (err?.response?.status === 422) return err?.response?.data?.detail ?? 'Validation error'
  if (err?.code === 'ECONNABORTED') return 'Request timed out — check the backend is running'
  if (err?.response?.data?.detail) return String(err.response.data.detail)
  if (err?.message) return err.message
  return 'An unexpected error occurred'
}

// Show a toast with the formatted error message
export function toastApiError(err, fallback = 'Operation failed') {
  toast.error(formatApiError(err) || fallback, { duration: 5000 })
}
