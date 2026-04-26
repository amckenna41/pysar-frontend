/**
 * Unit tests for frontend/src/store/appStore.js
 *
 * Tests cover all Zustand actions: dataset lifecycle, config mutations,
 * encoding params, job management, saved configs, and localStorage persistence.
 *
 * Note: localStorage is stubbed in setup.js and cleared before each test.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { useAppStore } from '../../store/appStore'
import { DEFAULT_CONFIG } from '../../store/appStore'

// Helper to read the current store state outside of React
const getState = () => useAppStore.getState()
const setState = (updates) => useAppStore.setState(updates)

// Reset to a clean initial state before every test
beforeEach(() => {
  // Reset Zustand store state to defaults
  useAppStore.setState({
    darkMode: false,
    showLanding: true,
    step: 1,
    dataset: null,
    config: DEFAULT_CONFIG,
    encoding: {
      strategy: 'aai',
      aai_indices: [],
      selected_descriptors: [],
      desc_combo: 1,
      sort_by: 'R2',
      n_jobs: 1,
      max_models: '',
      sample_mode: false,
      random_state: '',
    },
    job: null,
    results: null,
    resultColumns: [],
    savedConfigs: [],
    jobHistory: [],
    showJobs: false,
    showModelExplorer: false,
    showAaiExplorer: false,
    showDescriptorExplorer: false,
    aaiIndicesCache: [],
    descriptorExpandedSet: new Set(),
    backendOnline: null,
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Navigation
// ──────────────────────────────────────────────────────────────────────────────

describe('appStore — navigation', () => {
  it('starts with showLanding=true', () => {
    expect(getState().showLanding).toBe(true)
  })

  it('enterApp sets showLanding=false', () => {
    act(() => getState().enterApp())
    expect(getState().showLanding).toBe(false)
  })

  it('enterLanding restores showLanding=true', () => {
    act(() => {
      getState().enterApp()
      getState().enterLanding()
    })
    expect(getState().showLanding).toBe(true)
  })

  it('setStep updates the step', () => {
    act(() => getState().setStep(3))
    expect(getState().step).toBe(3)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Dataset
// ──────────────────────────────────────────────────────────────────────────────

describe('appStore — dataset', () => {
  const mockDataset = {
    file_id: 'abc123',
    filename: 'test.csv',
    num_rows: 20,
    columns: ['sequence', 'T50'],
  }

  it('setDataset stores the dataset', () => {
    act(() => getState().setDataset(mockDataset))
    expect(getState().dataset).toEqual(mockDataset)
  })

  it('clearDataset removes the dataset and resets step to 1', () => {
    act(() => {
      getState().setDataset(mockDataset)
      getState().setStep(3)
      getState().clearDataset()
    })
    expect(getState().dataset).toBeNull()
    expect(getState().step).toBe(1)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Config mutations
// ──────────────────────────────────────────────────────────────────────────────

describe('appStore — config', () => {
  it('setConfigValue updates a top-level key', () => {
    act(() => getState().setConfigValue(['model', 'algorithm'], 'ridge'))
    expect(getState().config.model.algorithm).toBe('ridge')
  })

  it('setConfigValue updates a nested key without mutating siblings', () => {
    act(() => getState().setConfigValue(['model', 'test_split'], 0.3))
    expect(getState().config.model.test_split).toBe(0.3)
    // Algorithm unchanged
    expect(getState().config.model.algorithm).toBe(DEFAULT_CONFIG.model.algorithm)
  })

  it('setConfigValue updates a deeply nested key', () => {
    act(() => getState().setConfigValue(['pyDSP', 'window', 'type'], 'hann'))
    expect(getState().config.pyDSP.window.type).toBe('hann')
  })

  it('resetConfig restores DEFAULT_CONFIG', () => {
    act(() => {
      getState().setConfigValue(['model', 'algorithm'], 'ridge')
      getState().resetConfig()
    })
    expect(getState().config.model.algorithm).toBe(DEFAULT_CONFIG.model.algorithm)
  })

  it('importConfig replaces config wholesale', () => {
    const custom = { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model, algorithm: 'lasso' } }
    act(() => getState().importConfig(custom))
    expect(getState().config.model.algorithm).toBe('lasso')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Encoding params
// ──────────────────────────────────────────────────────────────────────────────

describe('appStore — encoding', () => {
  it('starts with strategy=aai', () => {
    expect(getState().encoding.strategy).toBe('aai')
  })

  it('setEncoding merges partial updates', () => {
    act(() => getState().setEncoding({ strategy: 'descriptor', desc_combo: 2 }))
    const enc = getState().encoding
    expect(enc.strategy).toBe('descriptor')
    expect(enc.desc_combo).toBe(2)
    // Unchanged fields preserved
    expect(enc.sort_by).toBe('R2')
  })

  it('resetEncoding restores initial encoding defaults', () => {
    act(() => {
      getState().setEncoding({ strategy: 'aai_descriptor', max_models: 50 })
      getState().resetEncoding()
    })
    expect(getState().encoding.strategy).toBe('aai')
    expect(getState().encoding.max_models).toBe('')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Job management
// ──────────────────────────────────────────────────────────────────────────────

describe('appStore — job', () => {
  const mockJob = { job_id: 'j1', status: 'running', progress: 30, log: [] }

  it('setJob stores the active job', () => {
    act(() => getState().setJob(mockJob))
    expect(getState().job).toEqual(mockJob)
  })

  it('updateJob merges partial updates', () => {
    act(() => {
      getState().setJob(mockJob)
      getState().updateJob({ progress: 80, status: 'completed' })
    })
    expect(getState().job.progress).toBe(80)
    expect(getState().job.status).toBe('completed')
    expect(getState().job.job_id).toBe('j1')  // preserved
  })

  it('clearJob sets job to null', () => {
    act(() => {
      getState().setJob(mockJob)
      getState().clearJob()
    })
    expect(getState().job).toBeNull()
  })

  it('updateJob with no prior job creates the job from updates', () => {
    act(() => getState().updateJob({ job_id: 'j2', status: 'pending' }))
    expect(getState().job).toMatchObject({ job_id: 'j2', status: 'pending' })
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Results
// ──────────────────────────────────────────────────────────────────────────────

describe('appStore — results', () => {
  it('setResults stores results and columns', () => {
    const rows = [{ index: 'ALTS910101', R2: 0.9 }]
    const cols = ['index', 'R2']
    act(() => getState().setResults(rows, cols))
    expect(getState().results).toEqual(rows)
    expect(getState().resultColumns).toEqual(cols)
  })

  it('clearResults resets both results and columns', () => {
    act(() => {
      getState().setResults([{ R2: 0.9 }], ['R2'])
      getState().clearResults()
    })
    expect(getState().results).toBeNull()
    expect(getState().resultColumns).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Saved configs (localStorage-backed)
// ──────────────────────────────────────────────────────────────────────────────

describe('appStore — savedConfigs', () => {
  it('saveCurrentConfig adds an entry to savedConfigs', () => {
    act(() => getState().saveCurrentConfig('My config'))
    expect(getState().savedConfigs).toHaveLength(1)
    expect(getState().savedConfigs[0].name).toBe('My config')
  })

  it('saveCurrentConfig persists to localStorage', () => {
    act(() => getState().saveCurrentConfig('Persisted'))
    const stored = JSON.parse(localStorage.getItem('pysar_saved_configs'))
    expect(stored[0].name).toBe('Persisted')
  })

  it('saveCurrentConfig inserts newest first', () => {
    act(() => {
      getState().saveCurrentConfig('First')
      getState().saveCurrentConfig('Second')
    })
    expect(getState().savedConfigs[0].name).toBe('Second')
  })

  it('loadSavedConfig restores the config from that entry', () => {
    act(() => {
      getState().setConfigValue(['model', 'algorithm'], 'ridge')
      getState().saveCurrentConfig('Ridge config')
      getState().resetConfig()
      getState().loadSavedConfig(0)
    })
    expect(getState().config.model.algorithm).toBe('ridge')
  })

  it('deleteSavedConfig removes the entry by index', () => {
    act(() => {
      getState().saveCurrentConfig('Keep')
      getState().saveCurrentConfig('Delete me')  // index 0 (newest first)
      getState().deleteSavedConfig(0)
    })
    expect(getState().savedConfigs).toHaveLength(1)
    expect(getState().savedConfigs[0].name).toBe('Keep')
  })

  it('savedConfigs is capped at 10 entries', () => {
    act(() => {
      for (let i = 0; i < 12; i++) getState().saveCurrentConfig(`Config ${i}`)
    })
    expect(getState().savedConfigs).toHaveLength(10)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Job history (localStorage-backed)
// ──────────────────────────────────────────────────────────────────────────────

describe('appStore — jobHistory', () => {
  it('addJobToHistory inserts newest first', () => {
    act(() => {
      getState().addJobToHistory({ job_id: 'j1', strategy: 'aai' })
      getState().addJobToHistory({ job_id: 'j2', strategy: 'descriptor' })
    })
    expect(getState().jobHistory[0].job_id).toBe('j2')
  })

  it('addJobToHistory persists to localStorage', () => {
    act(() => getState().addJobToHistory({ job_id: 'j3' }))
    const stored = JSON.parse(localStorage.getItem('pysar_job_history'))
    expect(stored[0].job_id).toBe('j3')
  })

  it('jobHistory is capped at 50 entries', () => {
    act(() => {
      for (let i = 0; i < 55; i++) getState().addJobToHistory({ job_id: `j${i}` })
    })
    expect(getState().jobHistory).toHaveLength(50)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Panel visibility toggles
// ──────────────────────────────────────────────────────────────────────────────

describe('appStore — panel visibility', () => {
  it('setShowJobs toggles the jobs panel', () => {
    act(() => getState().setShowJobs(true))
    expect(getState().showJobs).toBe(true)
    act(() => getState().setShowJobs(false))
    expect(getState().showJobs).toBe(false)
  })

  it('setShowModelExplorer toggles the model explorer panel', () => {
    act(() => getState().setShowModelExplorer(true))
    expect(getState().showModelExplorer).toBe(true)
  })

  it('setShowAaiExplorer toggles the AAI explorer panel', () => {
    act(() => getState().setShowAaiExplorer(true))
    expect(getState().showAaiExplorer).toBe(true)
  })

  it('setShowDescriptorExplorer toggles the descriptor explorer panel', () => {
    act(() => getState().setShowDescriptorExplorer(true))
    expect(getState().showDescriptorExplorer).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Descriptor expanded set
// ──────────────────────────────────────────────────────────────────────────────

describe('appStore — descriptorExpandedSet', () => {
  it('toggleDescriptorExpanded adds a name if not present', () => {
    act(() => getState().toggleDescriptorExpanded('aac'))
    expect(getState().descriptorExpandedSet.has('aac')).toBe(true)
  })

  it('toggleDescriptorExpanded removes a name if already present', () => {
    act(() => {
      getState().toggleDescriptorExpanded('aac')
      getState().toggleDescriptorExpanded('aac')
    })
    expect(getState().descriptorExpandedSet.has('aac')).toBe(false)
  })

  it('setDescriptorExpandedBatch adds multiple names at once', () => {
    act(() => getState().setDescriptorExpandedBatch(['aac', 'dpc', 'tpc'], true))
    const set = getState().descriptorExpandedSet
    expect(set.has('aac')).toBe(true)
    expect(set.has('dpc')).toBe(true)
    expect(set.has('tpc')).toBe(true)
  })

  it('setDescriptorExpandedBatch removes multiple names at once', () => {
    act(() => {
      getState().setDescriptorExpandedBatch(['aac', 'dpc'], true)
      getState().setDescriptorExpandedBatch(['aac'], false)
    })
    const set = getState().descriptorExpandedSet
    expect(set.has('aac')).toBe(false)
    expect(set.has('dpc')).toBe(true)
  })
})
