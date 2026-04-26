/**
 * Unit tests for frontend/src/utils/api.js
 *
 * Axios is mocked via vi.mock so no real HTTP calls are made.
 * Each test class exercises a distinct exported function.
 *
 * Note on getExampleDatasets: it is synchronous and returns a hardcoded list —
 * no mocking required.
 * Note on loadExampleDataset: it uses the global `fetch` — mocked via
 * vi.stubGlobal.
 * Note on checkBackend: returns true on success, false on any error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock axios ─────────────────────────────────────────────────────────────────

const mockGet  = vi.fn()
const mockPost = vi.fn()
const mockDelete = vi.fn()

vi.mock('axios', () => ({
  default: {
    create: () => ({
      get:    mockGet,
      post:   mockPost,
      delete: mockDelete,
      // Required by the retry interceptor registered in api.js
      interceptors: { response: { use: vi.fn() } },
    }),
  },
}))

// ── Mock parseDataset (used by loadExampleDataset) ─────────────────────────────

vi.mock('../../utils/parseDataset', () => ({
  parseDatasetClientSide: vi.fn().mockResolvedValue({ file_id: 'parsed', num_rows: 5 }),
}))

// Lazy import AFTER mocks are registered
const {
  uploadDataset,
  startEncoding,
  getJob,
  deleteJob,
  cancelJob,
  listJobs,
  checkBackend,
  getExampleDatasets,
  loadExampleDataset,
  getAaiIndices,
} = await import('../../utils/api')

// ──────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockGet.mockReset()
  mockPost.mockReset()
  mockDelete.mockReset()
})

// ──────────────────────────────────────────────────────────────────────────────
// uploadDataset
// ──────────────────────────────────────────────────────────────────────────────

describe('api.uploadDataset', () => {
  it('POSTs to /upload and returns data', async () => {
    mockPost.mockResolvedValue({ data: { file_id: 'abc', num_rows: 20 } })
    const file = new File(['seq,T50\nACDE,55'], 'test.csv')
    const result = await uploadDataset(file)
    expect(mockPost).toHaveBeenCalledOnce()
    expect(mockPost.mock.calls[0][0]).toBe('/upload')
    expect(result).toMatchObject({ file_id: 'abc', num_rows: 20 })
  })

  it('invokes onProgress with a percentage', async () => {
    mockPost.mockImplementation((_url, _data, { onUploadProgress }) => {
      // Simulate progress event
      onUploadProgress?.({ loaded: 50, total: 100 })
      return Promise.resolve({ data: {} })
    })
    const onProgress = vi.fn()
    await uploadDataset(new File([''], 'f.csv'), onProgress)
    expect(onProgress).toHaveBeenCalledWith(50)
  })

  it('propagates axios errors to the caller', async () => {
    mockPost.mockRejectedValue(new Error('Network error'))
    await expect(uploadDataset(new File([''], 'f.csv'))).rejects.toThrow('Network error')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// startEncoding
// ──────────────────────────────────────────────────────────────────────────────

describe('api.startEncoding', () => {
  it('POSTs to /encode and returns job_id', async () => {
    mockPost.mockResolvedValue({ data: { job_id: 'j1' } })
    const result = await startEncoding({ file_path: '/tmp/x.csv', strategy: 'aai' })
    expect(mockPost).toHaveBeenCalledWith('/encode', expect.objectContaining({ strategy: 'aai' }))
    expect(result.job_id).toBe('j1')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// getJob
// ──────────────────────────────────────────────────────────────────────────────

describe('api.getJob', () => {
  it('GETs /jobs/{jobId} and returns data', async () => {
    mockGet.mockResolvedValue({ data: { job_id: 'j1', status: 'running' } })
    const result = await getJob('j1')
    expect(mockGet).toHaveBeenCalledWith('/jobs/j1')
    expect(result.status).toBe('running')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// deleteJob / cancelJob / listJobs
// ──────────────────────────────────────────────────────────────────────────────

describe('api.deleteJob', () => {
  it('sends DELETE to /jobs/{jobId}', async () => {
    mockDelete.mockResolvedValue({})
    await deleteJob('j1')
    expect(mockDelete).toHaveBeenCalledWith('/jobs/j1')
  })
})

describe('api.cancelJob', () => {
  it('POSTs to /jobs/{jobId}/cancel and returns data', async () => {
    mockPost.mockResolvedValue({ data: { cancelled: 'j1' } })
    const result = await cancelJob('j1')
    expect(mockPost).toHaveBeenCalledWith('/jobs/j1/cancel')
    expect(result.cancelled).toBe('j1')
  })
})

describe('api.listJobs', () => {
  it('GETs /jobs and returns data', async () => {
    mockGet.mockResolvedValue({ data: [] })
    const result = await listJobs()
    expect(mockGet).toHaveBeenCalledWith('/jobs')
    expect(result).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// checkBackend
// ──────────────────────────────────────────────────────────────────────────────

describe('api.checkBackend', () => {
  it('returns true when /health is reachable', async () => {
    mockGet.mockResolvedValue({ data: { status: 'ok' } })
    expect(await checkBackend()).toBe(true)
  })

  it('returns false when /health throws a network error', async () => {
    mockGet.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await checkBackend()).toBe(false)
  })

  it('returns false for any axios error (including timeout)', async () => {
    const err = new Error('timeout'); err.code = 'ECONNABORTED'
    mockGet.mockRejectedValue(err)
    expect(await checkBackend()).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// getExampleDatasets (synchronous, no HTTP)
// ──────────────────────────────────────────────────────────────────────────────

describe('api.getExampleDatasets', () => {
  it('returns an object with a datasets array', () => {
    const result = getExampleDatasets()
    expect(result).toHaveProperty('datasets')
    expect(Array.isArray(result.datasets)).toBe(true)
  })

  it('includes thermostability, absorption, enantioselectivity, localization', () => {
    const { datasets } = getExampleDatasets()
    const names = datasets.map((d) => d.name)
    expect(names).toContain('thermostability')
    expect(names).toContain('absorption')
    expect(names).toContain('enantioselectivity')
    expect(names).toContain('localization')
  })

  it('each entry has name, filename, description', () => {
    const { datasets } = getExampleDatasets()
    for (const d of datasets) {
      expect(d).toHaveProperty('name')
      expect(d).toHaveProperty('filename')
      expect(d).toHaveProperty('description')
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// loadExampleDataset (uses global fetch + parseDatasetClientSide)
// ──────────────────────────────────────────────────────────────────────────────

describe('api.loadExampleDataset', () => {
  beforeEach(() => {
    // Stub global fetch to return a fake file blob
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['seq,T50\nACDE,55'], { type: 'text/plain' })),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves for a known dataset name', async () => {
    const result = await loadExampleDataset('thermostability')
    expect(result).toBeDefined()
    expect(result.num_rows).toBeGreaterThan(0)
  })

  it('rejects for an unknown dataset name', async () => {
    await expect(loadExampleDataset('does_not_exist')).rejects.toThrow(/unknown/i)
  })

  it('rejects when fetch returns a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    await expect(loadExampleDataset('thermostability')).rejects.toThrow(/404/)
  })

  it('calls parseDatasetClientSide with a File object', async () => {
    const { parseDatasetClientSide } = await import('../../utils/parseDataset')
    await loadExampleDataset('thermostability')
    expect(parseDatasetClientSide).toHaveBeenCalledWith(expect.any(File))
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// getAaiIndices
// ──────────────────────────────────────────────────────────────────────────────

describe('api.getAaiIndices', () => {
  it('GETs /aai-indices and returns the indices list', async () => {
    mockGet.mockResolvedValue({ data: { indices: ['ALTS910101', 'BHAR880101'] } })
    const result = await getAaiIndices()
    expect(mockGet).toHaveBeenCalledWith('/aai-indices')
    expect(result).toEqual(['ALTS910101', 'BHAR880101'])
  })
})
