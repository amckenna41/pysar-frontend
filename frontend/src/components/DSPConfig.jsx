import { InformationCircleIcon } from '@heroicons/react/24/outline'
import { useAppStore } from '../store/appStore'

// Hover tooltip for technical DSP parameters
function Hint({ tip }) {
  return (
    <span className="relative group inline-flex items-center ml-1 cursor-help">
      <InformationCircleIcon className="w-3.5 h-3.5 text-gray-400 group-hover:text-indigo-500" />
      <span className="hidden group-hover:block absolute z-20 bottom-full left-1/2 -translate-x-1/2 mb-2 w-60 text-xs text-gray-700 bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 pointer-events-none leading-relaxed whitespace-normal">
        {tip}
      </span>
    </span>
  )
}

// One-click preset DSP configurations
const DSP_PRESETS = [
  {
    label: 'Power + Hamming',
    desc: 'Standard — balanced frequency resolution',
    apply: (setDSP) => {
      setDSP(['spectrum'], 'power')
      setDSP(['window', 'type'], 'hamming')
      setDSP(['window', 'sym'], true)
      setDSP(['filter', 'type'], null)
    },
  },
  {
    label: 'Absolute + Hann',
    desc: 'Smooth spectrum, low spectral leakage',
    apply: (setDSP) => {
      setDSP(['spectrum'], 'absolute')
      setDSP(['window', 'type'], 'hann')
      setDSP(['window', 'sym'], true)
      setDSP(['filter', 'type'], null)
    },
  },
  {
    label: 'Power + Savgol',
    desc: 'Smoothed power spectrum via Savitzky-Golay filter',
    apply: (setDSP) => {
      setDSP(['spectrum'], 'power')
      setDSP(['window', 'type'], 'hamming')
      setDSP(['window', 'sym'], true)
      setDSP(['filter', 'type'], 'savgol')
      setDSP(['filter', 'window_length'], 5)
      setDSP(['filter', 'polyorder'], 2)
      setDSP(['filter', 'mode'], 'interp')
    },
  },
  {
    label: 'Real + Blackman',
    desc: 'Real output with high side-lobe attenuation',
    apply: (setDSP) => {
      setDSP(['spectrum'], 'real')
      setDSP(['window', 'type'], 'blackman')
      setDSP(['window', 'sym'], true)
      setDSP(['filter', 'type'], null)
    },
  },
]

const SPECTRA = ['power', 'absolute', 'imaginary', 'real']

const WINDOWS = [
  'hamming', 'blackman', 'blackmanharris', 'gaussian', 'bartlett', 'kaiser',
  'barthann', 'bohman', 'chebwin', 'cosine', 'exponential', 'flattop',
  'hann', 'boxcar', 'hanning', 'nuttall', 'parzen', 'triang', 'tukey',
]

const FILTERS = [null, 'savgol', 'medfilt', 'symiirorder1', 'lfilter', 'hilbert']

const FILTER_MODES = ['interp', 'mirror', 'constant', 'nearest', 'wrap']

// Which extra window params are visible per window type
const WINDOW_HAS = {
  gaussian:  ['alpha'],
  kaiser:    ['beta'],
  chebwin:   ['sll'],
  nuttall:   [],
  tukey:     ['alpha'],
  exponential: ['nbar'],
}

export default function DSPConfig() {
  const { config, setConfigValue } = useAppStore()
  const { use_dsp, spectrum, window, filter } = config.pyDSP

  function setDSP(path, val) {
    setConfigValue(['pyDSP', ...path], val)
  }

  // Extra params for the chosen window function
  const extraWindowParams = WINDOW_HAS[window?.type] ?? []

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold text-gray-800">
        Digital Signal Processing (DSP)
      </h3>

      {/* Enable toggle */}
      <div className="flex items-center gap-3">
        <button
          role="switch"
          aria-checked={use_dsp}
          onClick={() => setDSP(['use_dsp'], !use_dsp)}
          className={[
            'relative w-10 h-5 rounded-full transition-colors',
            use_dsp ? 'bg-indigo-600' : 'bg-gray-300',
          ].join(' ')}
        >
          <span
            className={[
              'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform',
              use_dsp ? 'translate-x-5' : 'translate-x-0.5',
            ].join(' ')}
          />
        </button>
        <span className="text-sm text-gray-700">
          Apply DSP to AAI-encoded sequences
        </span>
      </div>

      {use_dsp && (
        <div className="space-y-5 pl-4 border-l-2 border-indigo-200">

          {/* One-click preset profiles */}
          <div>
            <label className="label">Quick presets</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {DSP_PRESETS.map(({ label, desc }) => (
                <button
                  key={label}
                  title={desc}
                  onClick={() => DSP_PRESETS.find((p) => p.label === label)?.apply(setDSP)}
                  className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs font-medium text-gray-600 hover:border-indigo-400 hover:text-indigo-700 bg-white transition-colors"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {/* Spectrum type */}
          <div>
            <label className="label">Output spectrum</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {SPECTRA.map((s) => (
                <button
                  key={s}
                  onClick={() => setDSP(['spectrum'], s)}
                  className={[
                    'px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors',
                    spectrum === s
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                      : 'border-gray-200 text-gray-500 hover:border-gray-300 bg-white',
                  ].join(' ')}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Window function */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Window function</label>
              <select
                className="input"
                value={window?.type ?? 'hamming'}
                onChange={(e) => setDSP(['window', 'type'], e.target.value)}
              >
                {WINDOWS.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            <div className="flex items-end gap-2">
              <div className="flex items-center gap-2 pb-2">
                <input
                  id="sym"
                  type="checkbox"
                  checked={window?.sym ?? true}
                  onChange={(e) => setDSP(['window', 'sym'], e.target.checked)}
                  className="w-4 h-4 accent-indigo-600"
                />
                <label htmlFor="sym" className="text-sm text-gray-700 cursor-pointer flex items-center">
                  Symmetric window
                  <Hint tip="A symmetric window is centred at zero and has equal-length left/right tails. Use asymmetric (unchecked) for filter design; symmetric for spectral analysis." />
                </label>
              </div>
            </div>

            {/* Conditional window params with tooltips */}
            {extraWindowParams.includes('alpha') && (
              <div>
                <label className="label flex items-center">
                  alpha
                  <Hint tip="Shape parameter for the Gaussian or Tukey window. Larger values make the window narrower (more concentrated in time, wider in frequency)." />
                </label>
                <input type="number" className="input" step="0.1"
                  value={window?.alpha ?? ''}
                  onChange={(e) => setDSP(['window', 'alpha'], parseFloat(e.target.value) || null)}
                />
              </div>
            )}
            {extraWindowParams.includes('beta') && (
              <div>
                <label className="label flex items-center">
                  beta
                  <Hint tip="Kaiser window shape parameter. beta = 0 gives a rectangular window; beta = 14 gives a near-optimal window. Higher values add more side-lobe attenuation." />
                </label>
                <input type="number" className="input"
                  value={window?.beta ?? ''}
                  onChange={(e) => setDSP(['window', 'beta'], parseFloat(e.target.value) || null)}
                />
              </div>
            )}
            {extraWindowParams.includes('sll') && (
              <div>
                <label className="label flex items-center">
                  sll
                  <Hint tip="Chebyshev window: desired side-lobe level in dB (e.g. -60 for 60 dB attenuation). Lower values increase the main-lobe width." />
                </label>
                <input type="number" className="input"
                  value={window?.sll ?? ''}
                  onChange={(e) => setDSP(['window', 'sll'], parseFloat(e.target.value) || null)}
                />
              </div>
            )}
            {extraWindowParams.includes('nbar') && (
              <div>
                <label className="label flex items-center">
                  nbar
                  <Hint tip="Exponential window: number of time constants across the window half-width. Larger values give a flatter window." />
                </label>
                <input type="number" className="input"
                  value={window?.nbar ?? ''}
                  onChange={(e) => setDSP(['window', 'nbar'], parseFloat(e.target.value) || null)}
                />
              </div>
            )}
          </div>

          {/* Filter function */}
          <div>
            <label className="label">Filter function</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {FILTERS.map((f) => (
                <button
                  key={f ?? 'none'}
                  onClick={() => setDSP(['filter', 'type'], f)}
                  className={[
                    'px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors',
                    filter?.type === f
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                      : 'border-gray-200 text-gray-500 hover:border-gray-300 bg-white',
                  ].join(' ')}
                >
                  {f ?? 'none'}
                </button>
              ))}
            </div>
          </div>

          {/* Filter params (shown when a filter is selected) */}
          {filter?.type && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {filter.type === 'savgol' && (
                <>
                  <div>
                    <label className="label flex items-center">
                      window_length
                      <Hint tip="Number of data points used in the smoothing window. Must be an odd integer greater than polyorder. Larger values produce smoother output." />
                    </label>
                    <input type="number" className="input"
                      value={filter.window_length ?? 5} min={1}
                      onChange={(e) => setDSP(['filter', 'window_length'], parseInt(e.target.value, 10) || 5)}
                    />
                  </div>
                  <div>
                    <label className="label flex items-center">
                      polyorder
                      <Hint tip="Polynomial order of the Savitzky-Golay fit. Must be less than window_length. Higher orders preserve sharper peaks but may overfit noise." />
                    </label>
                    <input type="number" className="input"
                      value={filter.polyorder ?? 2} min={1}
                      onChange={(e) => setDSP(['filter', 'polyorder'], parseInt(e.target.value, 10) || 2)}
                    />
                    {/* Inline validation: polyorder must be strictly less than window_length */}
                    {(filter.polyorder ?? 2) >= (filter.window_length ?? 5) && (
                      <p className="text-xs text-red-600 mt-1 font-medium">
                        Must be less than window_length
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="label flex items-center">
                      mode
                      <Hint tip="Edge handling: 'interp' uses polynomial interpolation at boundaries (recommended); others pad the signal differently before filtering." />
                    </label>
                    <select className="input"
                      value={filter.mode ?? 'interp'}
                      onChange={(e) => setDSP(['filter', 'mode'], e.target.value)}
                    >
                      {FILTER_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
