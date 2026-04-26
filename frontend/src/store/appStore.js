/**
 * Global Zustand store for pySAR frontend.
 * Holds dataset info, config state, encoding params, job status and results.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// ── Default config values (mirrors pySAR defaults) ────────────────────────────
export const DEFAULT_CONFIG = {
  model: {
    algorithm: 'plsregression',
    algorithms: ['plsregression'],  // multi-select list
    parameters: {},
    perAlgoParameters: {},          // per-algo param overrides
    test_split: 0.2,
    use_cv: false,     // true = k-fold cross-validation; false = holdout split
    cv_folds: 5,       // number of folds when use_cv is true
    random_state: null, // integer seed for reproducibility
  },
  descriptors: {
    descriptors_csv: '',
    moreaubroto_autocorrelation: {
      lag: 30,
      properties: ['CIDH920105', 'BHAR880101', 'CHAM820101', 'CHAM820102',
                   'CHOC760101', 'BIGC670101', 'CHAM810101', 'DAYM780201'],
      normalize: 1,
    },
    moran_autocorrelation: {
      lag: 30,
      properties: ['CIDH920105', 'BHAR880101', 'CHAM820101', 'CHAM820102',
                   'CHOC760101', 'BIGC670101', 'CHAM810101', 'DAYM780201'],
      normalize: 1,
    },
    geary_autocorrelation: {
      lag: 30,
      properties: ['CIDH920105', 'BHAR880101', 'CHAM820101', 'CHAM820102',
                   'CHOC760101', 'BIGC670101', 'CHAM810101', 'DAYM780201'],
      normalize: 1,
    },
    ctd: { property: 'hydrophobicity', all: 0 },
    sequence_order_coupling_number: { lag: 30, distance_matrix: 'schneider-wrede' },
    quasi_sequence_order: { lag: 30, weight: 0.1, distance_matrix: 'schneider-wrede' },
    pseudo_amino_acid_composition: { lambda: 30, weight: 0.05, properties: [] },
    amphiphilic_pseudo_amino_acid_composition: { lambda: 30, weight: 0.5 },
    // New configurable descriptors added in pySAR v2.5.1 / protpy v1.3.0
    charge_distribution: { ph: 7.4 },
    kmer_composition: { k: 2 },
    reduced_alphabet_composition: { alphabet_size: 6 },
    hydrophobic_moment: { window: 11, angle: 100 },
  },
  pyDSP: {
    use_dsp: false,
    spectrum: 'power',
    window: {
      type: 'hamming',
      sym: true,
      beta: null,
      alpha: null,
      nbar: null,
      sll: null,
      norm: null,
    },
    filter: {
      type: null,
      window_length: 5,
      polyorder: 2,
      deriv: 0,
      delta: 1,
      mode: 'interp',
    },
  },
}

const DEFAULT_ENCODING = {
  strategy: 'aai',           // 'aai' | 'descriptor' | 'aai_descriptor'
  aai_indices: [],            // [] means "all"
  selected_descriptors: [],   // [] means "all"
  desc_combo: 1,
  sort_by: 'R2',
  n_jobs: 1,
  max_models: '',
  sample_mode: false,
  random_state: '',
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Immutably set a nested value on an object via a key-path array. */
function setNested(obj, path, value) {
  const result = { ...obj }
  let ref = result
  for (let i = 0; i < path.length - 1; i++) {
    ref[path[i]] = { ...ref[path[i]] }
    ref = ref[path[i]]
  }
  ref[path[path.length - 1]] = value
  return result
}

/**
 * Validate that an imported config object has the required top-level sections
 * and that each section is a non-null object.  Returns false on any mismatch.
 */
function _validateConfig(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  const required = ['model', 'descriptors', 'pyDSP']
  if (!required.every((k) => k in obj)) return false
  return required.every((k) => obj[k] !== null && typeof obj[k] === 'object' && !Array.isArray(obj[k]))
}

// ── Store ──────────────────────────────────────────────────────────────────────
export const useAppStore = create(
  persist(
    (set, get) => ({
  // ── Dark mode ──
  darkMode: typeof window !== 'undefined' && document.documentElement.classList.contains('dark'),
  toggleDarkMode: () => set((s) => {
    const next = !s.darkMode
    document.documentElement.classList.toggle('dark', next)
    return { darkMode: next }
  }),

  // ── Backend availability (probed once on app mount; not persisted) ──
  // null = not yet checked, true = reachable, false = unreachable
  backendOnline: null,
  setBackendOnline: (v) => set({ backendOnline: v }),

  // ── Landing page visibility ──
  showLanding: true,
  enterApp: () => set({ showLanding: false }),
  enterLanding: () => set({ showLanding: true }),

  // ── Navigation ──
  step: 1,
  setStep: (step) => set({ step }),

  // ── Dataset (set after successful upload) ──
  dataset: null,
  // dataset shape: {
  //   file_id, filename, file_path, columns, num_rows,
  //   preview, seq_col, act_col, length_stats, activity_stats
  // }
  setDataset: (dataset) => set({ dataset }),
  // Clears the dataset and resets config + encoding to defaults so stale
  // per-dataset params (e.g. AAI indices, descriptors, model config) don't
  // carry over when a new dataset is uploaded.
  clearDataset: () => set({ dataset: null, step: 1, config: DEFAULT_CONFIG, encoding: DEFAULT_ENCODING }),

  // ── Config ──
  config: DEFAULT_CONFIG,

  /** Update a config value at arbitrary depth. path is an array of keys. */
  setConfigValue: (path, value) =>
    set((s) => ({ config: setNested(s.config, path, value) })),

  resetConfig: () => set({ config: DEFAULT_CONFIG }),

  /**
   * Import an external config object, validating its structure first.
   * Deep-merges with DEFAULT_CONFIG so missing nested keys are filled in.
   * Silently rejects malformed configs to prevent state corruption.
   */
  importConfig: (configObj) => {
    if (!_validateConfig(configObj)) {
      console.warn('pySAR: importConfig rejected malformed config', configObj)
      return
    }
    // Deep-merge so any missing nested keys fall back to defaults
    const merged = {
      model: { ...DEFAULT_CONFIG.model, ...configObj.model },
      descriptors: { ...DEFAULT_CONFIG.descriptors, ...configObj.descriptors },
      pyDSP: {
        ...DEFAULT_CONFIG.pyDSP,
        ...configObj.pyDSP,
        window: { ...DEFAULT_CONFIG.pyDSP.window, ...configObj.pyDSP?.window },
        filter: { ...DEFAULT_CONFIG.pyDSP.filter, ...configObj.pyDSP?.filter },
      },
    }
    set({ config: merged })
  },

  // ── Encoding params ──
  encoding: DEFAULT_ENCODING,
  setEncoding: (updates) =>
    set((s) => ({ encoding: { ...s.encoding, ...updates } })),
  resetEncoding: () => set({ encoding: DEFAULT_ENCODING }),

  // ── AAI indices cache (avoids re-fetching on re-open) ──
  aaiIndicesCache: [],
  setAaiIndicesCache: (v) => set({ aaiIndicesCache: v }),

  // ── Descriptor Explorer expanded rows (persists while panel is open) ──
  descriptorExpandedSet: new Set(),
  toggleDescriptorExpanded: (name) => set((s) => {
    const next = new Set(s.descriptorExpandedSet)
    next.has(name) ? next.delete(name) : next.add(name)
    return { descriptorExpandedSet: next }
  }),
  setDescriptorExpandedBatch: (names, expand) => set((s) => {
    const next = new Set(s.descriptorExpandedSet)
    if (expand) names.forEach((n) => next.add(n))
    else names.forEach((n) => next.delete(n))
    return { descriptorExpandedSet: next }
  }),

  // ── Active job ──
  job: null,
  setJob: (job) => set({ job }),
  updateJob: (updates) =>
    set((s) => ({ job: s.job ? { ...s.job, ...updates } : updates })),
  clearJob: () => set({ job: null }),

  // ── Results (copies of job.results for the Results page) ──
  results: null,
  resultColumns: [],
  setResults: (results, columns) => set({ results, resultColumns: columns }),
  clearResults: () => set({ results: null, resultColumns: [] }),

  // ── History: saved configs in localStorage ──
  savedConfigs: JSON.parse(localStorage.getItem('pysar_saved_configs') || '[]'),
  saveCurrentConfig: (name) => {
    const entry = {
      name,
      timestamp: new Date().toISOString(),
      config: get().config,
    }
    const updated = [entry, ...get().savedConfigs].slice(0, 10)
    localStorage.setItem('pysar_saved_configs', JSON.stringify(updated))
    set({ savedConfigs: updated })
  },
  loadSavedConfig: (index) => {
    const entry = get().savedConfigs[index]
    if (entry) set({ config: entry.config })
  },
  deleteSavedConfig: (index) => {
    const updated = get().savedConfigs.filter((_, i) => i !== index)
    localStorage.setItem('pysar_saved_configs', JSON.stringify(updated))
    set({ savedConfigs: updated })
  },

  // ── Jobs panel visibility ──
  showJobs: false,
  setShowJobs: (v) => set({ showJobs: v }),

  // ── Model Explorer visibility ──
  showModelExplorer: false,
  setShowModelExplorer: (v) => set({ showModelExplorer: v }),

  // ── AAI Explorer visibility ──
  showAaiExplorer: false,
  setShowAaiExplorer: (v) => set({ showAaiExplorer: v }),

  // ── Descriptor Explorer visibility ──
  showDescriptorExplorer: false,
  setShowDescriptorExplorer: (v) => set({ showDescriptorExplorer: v }),

  // ── Job history (persisted to localStorage, no results payload) ──
  jobHistory: JSON.parse(localStorage.getItem('pysar_job_history') || '[]'),

  addJobToHistory: (entry) => {
    const updated = [entry, ...get().jobHistory].slice(0, 50) // keep last 50
    localStorage.setItem('pysar_job_history', JSON.stringify(updated))
    set({ jobHistory: updated })
  },

  // updates can be a plain status string or an object like { status, error, log }
  updateJobHistoryStatus: (jobId, updates) => {
    const patch = typeof updates === 'string' ? { status: updates } : updates
    const updated = get().jobHistory.map((e) =>
      e.job_id === jobId ? { ...e, ...patch } : e
    )
    localStorage.setItem('pysar_job_history', JSON.stringify(updated))
    set({ jobHistory: updated })
  },

  removeJobFromHistory: (id) => {
    const updated = get().jobHistory.filter((e) => e.id !== id)
    localStorage.setItem('pysar_job_history', JSON.stringify(updated))
    set({ jobHistory: updated })
  },

  toggleJobPin: (id) => {
    const updated = get().jobHistory.map((e) =>
      e.id === id ? { ...e, pinned: !e.pinned } : e
    )
    localStorage.setItem('pysar_job_history', JSON.stringify(updated))
    set({ jobHistory: updated })
  },

  clearJobHistory: () => {
    localStorage.removeItem('pysar_job_history')
    set({ jobHistory: [] })
  },

  /** Restore encoding + model config from a history entry, then auto-trigger submission. */
  rerunJob: (entry) => {
    const p = entry.payload
    set((s) => ({
      encoding: {
        ...s.encoding,
        strategy:             p.strategy ?? 'aai',
        selected_descriptors: p.selected_descriptors ?? [],
        desc_combo:           p.desc_combo ?? 1,
        sort_by:              p.sort_by ?? 'R2',
        n_jobs:               p.n_jobs ?? 1,
        max_models:           p.max_models ?? '',
        sample_mode:          p.sample_mode ?? false,
        random_state:         p.random_state ?? '',
      },
      config: {
        ...s.config,
        model: {
          algorithm:          p.algorithm ?? 'plsregression',
          algorithms:         [p.algorithm ?? 'plsregression'],
          parameters:         p.model_parameters ?? {},
          perAlgoParameters:  {},
          test_split:         p.test_split ?? 0.2,
        },
      },
      pendingRerun: entry, // Step3Encode watches this and auto-submits
      showJobs: false,
      showModelExplorer: false,
      showAaiExplorer: false,
      showDescriptorExplorer: false,
      step: 3,
    }))
  },

  pendingRerun: null,
  clearPendingRerun: () => set({ pendingRerun: null }),

  // ── Encoding queue (in-memory only, resets on page refresh) ──
  encodingQueue: [],
  addToQueue: (payload) => set((s) => ({ encodingQueue: [...s.encodingQueue, payload] })),
  shiftQueue: () => set((s) => ({ encodingQueue: s.encodingQueue.slice(1) })),
  removeFromQueue: (index) => set((s) => ({ encodingQueue: s.encodingQueue.filter((_, i) => i !== index) })),
  clearQueue: () => set({ encodingQueue: [] }),
    }),
    {
    name: 'pysar-app-state',
    // Only persist user-meaningful state; transient UI and already-persisted slices are excluded
    partialize: (state) => ({
      darkMode:       state.darkMode,
      showLanding:    state.showLanding,
      step:           state.step,
      // Strip _pendingFile (a File object): JSON.stringify serialises it to {} which
      // is truthy but breaks the lazy-upload in handleRun after a page reload.
      // _pendingFileText / _pendingFileName are plain strings and survive serialisation.
      dataset:        state.dataset
        ? { ...state.dataset, _pendingFile: undefined }
        : null,
      config:         state.config,
      encoding:       state.encoding,
      aaiIndicesCache: state.aaiIndicesCache,
    }),
    // Re-apply dark mode CSS class after state is rehydrated from localStorage
    onRehydrateStorage: () => (state) => {
      if (state?.darkMode) {
        document.documentElement.classList.add('dark')
      }
    },
  }
  )
)
