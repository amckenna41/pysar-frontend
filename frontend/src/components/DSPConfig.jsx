import { useAppStore } from '../store/appStore'
import HelpTooltip from './HelpTooltip'

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
          <HelpTooltip className="ml-1" tip="Turn this on when you want frequency-domain features from AAIndex signals; leave it off for simpler baseline runs and faster jobs." />
        </span>
      </div>

      {use_dsp && (
        <div className="space-y-5 pl-4 border-l-2 border-indigo-200">

          {/* One-click preset profiles */}
          <div>
            <label className="label flex items-center gap-1">
              Quick presets
              <HelpTooltip tip="Preset bundles apply a sensible starting combination of spectrum, window, and filter; use them first, then fine-tune only if needed." />
            </label>
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
            <label className="label flex items-center gap-1">
              Output spectrum
              <HelpTooltip tip="Choose which FFT component to keep; use power for stable magnitude-based features, and use real or imaginary only for specific signal-analysis experiments." />
            </label>
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
              <label className="label flex items-center gap-1">
                Window function
                <HelpTooltip tip="Windowing reduces edge artifacts before FFT; start with hamming or hann, and change only if you need sharper peak resolution or stronger leakage suppression." />
              </label>
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
                  <HelpTooltip className="ml-1" tip="Keep this enabled for spectral analysis; disable it mainly when preparing coefficients for certain filter-design workflows." />
                </label>
              </div>
            </div>

            {/* Conditional window params with tooltips */}
            {extraWindowParams.includes('alpha') && (
              <div>
                <label className="label flex items-center">
                  alpha
                  <HelpTooltip className="ml-1" tip="Controls Gaussian or Tukey window shape; increase it when you want stronger edge tapering, decrease it when you need a broader effective window." />
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
                  <HelpTooltip className="ml-1" tip="Kaiser shape control: higher values suppress side lobes more but widen the main lobe; raise it when leakage is a bigger concern than resolution." />
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
                  <HelpTooltip className="ml-1" tip="Target Chebyshev side-lobe attenuation in dB; use larger magnitude attenuation for cleaner spectra at the cost of wider main-lobe response." />
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
                  <HelpTooltip className="ml-1" tip="Controls exponential window decay profile; increase it for a flatter window shape, lower it for stronger tapering near edges." />
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
            <label className="label flex items-center gap-1">
              Filter function
              <HelpTooltip tip="Optional post-FFT smoothing or transformation; leave as none unless you are dealing with noisy spectra or replicating a specific DSP protocol." />
            </label>
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
                      <HelpTooltip className="ml-1" tip="Savitzky-Golay window size in points; larger odd values smooth more aggressively, while smaller values preserve local peaks." />
                    </label>
                    <input type="number" className="input"
                      value={filter.window_length ?? 5} min={1}
                      onChange={(e) => setDSP(['filter', 'window_length'], parseInt(e.target.value, 10) || 5)}
                    />
                  </div>
                  <div>
                    <label className="label flex items-center">
                      polyorder
                      <HelpTooltip className="ml-1" tip="Polynomial degree for Savitzky-Golay smoothing; increase it to preserve sharper curvature, but keep it below window_length to avoid unstable fits." />
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
                      <HelpTooltip className="ml-1" tip="Controls boundary handling at sequence edges; use interp in most cases, and try mirror or nearest only if edge behavior looks distorted." />
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
