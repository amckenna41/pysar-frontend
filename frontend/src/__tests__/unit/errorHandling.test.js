/**
 * Unit tests for frontend/src/utils/errorHandling.js
 *
 * formatApiError() is a pure function — tested without any React component.
 * toastApiError() wraps formatApiError() with a toast call — tested with
 * react-hot-toast mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { formatApiError, toastApiError } from '../../utils/errorHandling'

// Mock react-hot-toast at module level so Vitest's static hoisting is satisfied
vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn() },
  error: vi.fn(),
}))

// ── helpers ────────────────────────────────────────────────────────────────────

/** Build a minimal Axios-style error object. */
function axiosError({ status, data, code, message } = {}) {
  const err = new Error(message ?? 'Request failed')
  if (status !== undefined || data !== undefined) {
    err.response = { status, data }
  }
  if (code) err.code = code
  return err
}

// ──────────────────────────────────────────────────────────────────────────────
// formatApiError
// ──────────────────────────────────────────────────────────────────────────────

describe('formatApiError', () => {
  it('returns file size message for HTTP 413', () => {
    const err = axiosError({ status: 413 })
    expect(formatApiError(err)).toMatch(/too large/i)
  })

  it('returns backend detail string for HTTP 422 with detail', () => {
    const err = axiosError({ status: 422, data: { detail: 'Column missing' } })
    expect(formatApiError(err)).toBe('Column missing')
  })

  it('returns generic validation error for HTTP 422 without detail', () => {
    const err = axiosError({ status: 422, data: {} })
    expect(formatApiError(err)).toMatch(/validation/i)
  })

  it('returns timeout message for ECONNABORTED code', () => {
    const err = axiosError({ code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' })
    expect(formatApiError(err)).toMatch(/timed out/i)
  })

  it('returns detail string for arbitrary 4xx with response.data.detail', () => {
    const err = axiosError({ status: 400, data: { detail: 'Bad request payload' } })
    expect(formatApiError(err)).toBe('Bad request payload')
  })

  it('returns err.message when no response is present', () => {
    const err = new Error('Network unreachable')
    expect(formatApiError(err)).toBe('Network unreachable')
  })

  it('returns fallback string for completely unknown errors', () => {
    // Passing an object with no recognised properties
    expect(formatApiError({})).toMatch(/unexpected/i)
  })

  it('returns fallback string for null input', () => {
    expect(formatApiError(null)).toMatch(/unexpected/i)
  })

  it('converts non-string detail to string', () => {
    const err = axiosError({ status: 400, data: { detail: ['error 1', 'error 2'] } })
    const msg = formatApiError(err)
    expect(typeof msg).toBe('string')
    expect(msg.length).toBeGreaterThan(0)
  })

  it('prefers status-specific message over detail for 413', () => {
    const err = axiosError({ status: 413, data: { detail: 'ignored detail' } })
    expect(formatApiError(err)).toMatch(/too large/i)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// toastApiError
// ──────────────────────────────────────────────────────────────────────────────

describe('toastApiError', () => {
  let toastErrorSpy

  beforeEach(async () => {
    // Retrieve the hoisted mock and clear it before each test
    const toast = (await import('react-hot-toast')).default
    toastErrorSpy = toast.error
    toastErrorSpy.mockClear()
  })

  it('calls toast.error with the formatted message', async () => {
    const err = axiosError({ status: 413 })
    toastApiError(err)
    expect(toastErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/too large/i),
      expect.objectContaining({ duration: expect.any(Number) }),
    )
  })

  it('calls toast.error once per invocation', async () => {
    toastApiError(new Error('oops'))
    expect(toastErrorSpy).toHaveBeenCalledTimes(1)
  })
})
