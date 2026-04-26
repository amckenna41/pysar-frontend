import { useRef, useState, useMemo } from 'react'
import { ArrowLeftIcon, ArrowRightIcon, ArrowUpTrayIcon, ArrowDownTrayIcon, XMarkIcon, ArrowPathIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { useAppStore, DEFAULT_CONFIG } from '../store/appStore'
import ModelConfig from '../components/ModelConfig'
import DescriptorConfig from '../components/DescriptorConfig'
import DSPConfig from '../components/DSPConfig'
import ConfigPreview from '../components/ConfigPreview'
import { validateConfig, countDiffs } from '../utils/configValidation'

export default function Step2Configure() {
  const { setStep, config, importConfig, resetConfig } = useAppStore()
  const [activeTab, setActiveTab] = useState('model')
  const [importedFilename, setImportedFilename] = useState(null) // tracks uploaded config name
  const [importErrors, setImportErrors] = useState([])           // validation errors from last import
  const fileInputRef = useRef(null)

  // Count settings changed from defaults — drives the badge on the Config Preview tab
  const diffCount = useMemo(() => countDiffs(config, DEFAULT_CONFIG), [config])

  const TABS = [
    { id: 'model',       label: 'Model' },
    { id: 'descriptors', label: 'Descriptors' },
    { id: 'dsp',         label: 'DSP' },
    { id: 'preview',     label: 'Config Preview', badge: diffCount > 0 ? diffCount : null },
  ]

  // ── Parse, validate, and apply uploaded JSON config file ──────────────────
  function handleConfigFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.name.endsWith('.json')) {
      toast.error('Config file must be a .json file')
      e.target.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result)
        // Validate against expected schema before applying
        const errors = validateConfig(parsed)
        setImportErrors(errors)
        if (errors.length > 0) {
          // Surface errors but still apply the config (warn, don't block)
          toast.error(`Config loaded with ${errors.length} warning(s) — review below`, { duration: 5000 })
        } else {
          toast.success(`Config loaded from ${file.name}`)
        }
        importConfig(parsed)
        setImportedFilename(file.name)
      } catch {
        toast.error('Invalid JSON — could not parse config file')
        setImportErrors([])
      }
    }
    reader.readAsText(file)
    e.target.value = '' // allow re-uploading same file
  }

  // ── Clear imported config and revert to defaults ──────────────────────────
  function clearImportedConfig() {
    resetConfig()
    setImportedFilename(null)
    setImportErrors([])
    toast('Config reset to defaults')
  }

  // ── Download current config as .json file ─────────────────────────────────
  function handleExportConfig() {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'pysar_config.json'
    a.click()
  }

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Set the model algorithm, descriptor metaparameters and optional DSP settings.
        All parameters follow the pySAR JSON config schema.
      </p>

      {/* ── Config file upload + export ── */}
      <div className="card p-4 flex items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={handleConfigFile}
        />
        {importedFilename ? (
          // Loaded state — show filename + clear button
          <>
            <ArrowUpTrayIcon className="w-5 h-5 text-indigo-500 shrink-0" />
            <span className="text-sm text-gray-700 flex-1">
              Config loaded from <span className="font-mono font-semibold">{importedFilename}</span>
            </span>
            <button
              type="button"
              onClick={handleExportConfig}
              className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700 font-medium"
            >
              <ArrowDownTrayIcon className="w-4 h-4" /> Export
            </button>
            <button
              type="button"
              onClick={clearImportedConfig}
              className="flex items-center gap-1 text-xs text-red-600 hover:text-red-700 font-medium"
            >
              <XMarkIcon className="w-4 h-4" /> Remove
            </button>
          </>
        ) : (
          // Default state — upload prompt + export button
          <>
            <ArrowUpTrayIcon className="w-5 h-5 text-gray-400 shrink-0" />
            <span className="text-sm text-gray-500 flex-1">
              Optionally upload a pySAR <span className="font-mono">.json</span> config file to pre-fill all settings
            </span>
            <button
              type="button"
              onClick={handleExportConfig}
              className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700 font-medium"
              title="Export current config as JSON"
            >
              <ArrowDownTrayIcon className="w-4 h-4" /> Export
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="btn-secondary text-xs py-1.5 px-3 shrink-0"
            >
              Upload config
            </button>
          </>
        )}
      </div>

      {/* Config import validation errors — shown when the uploaded file has issues */}
      {importErrors.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 px-4 py-3">
          <div className="flex items-start gap-2">
            <ExclamationTriangleIcon className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300 mb-1">
                Config loaded with {importErrors.length} warning{importErrors.length !== 1 ? 's' : ''}
              </p>
              <ul className="space-y-0.5">
                {importErrors.map((err, i) => (
                  <li key={i} className="text-xs text-amber-700 dark:text-amber-400 font-mono">• {err}</li>
                ))}
              </ul>
              <p className="text-xs text-amber-600 mt-1.5">
                The config was applied as-is. Correct these values before running an encoding job.
              </p>
            </div>
            <button
              type="button"
              className="text-amber-400 hover:text-amber-600 shrink-0"
              onClick={() => setImportErrors([])}
              aria-label="Dismiss warnings"
            >
              <XMarkIcon className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Tab bar + reset button */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-1 p-1 bg-gray-100 dark:bg-gray-800 rounded-lg">
          {TABS.map(({ id, label, badge }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`${activeTab === id ? 'tab-btn-active' : 'tab-btn-inactive'} relative flex items-center gap-1`}
            >
              {label}
              {/* Orange badge showing count of settings changed from defaults */}
              {badge != null && (
                <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 rounded-full bg-amber-500 text-white text-[10px] font-bold px-1">
                  {badge}
                </span>
              )}
            </button>
          ))}
        </div>
        {/* Reset all config parameters to defaults */}
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 font-medium border border-red-200 hover:border-red-400 rounded-lg px-3 py-2 transition-colors"
          onClick={() => { resetConfig(); setImportedFilename(null); toast('Config reset to defaults') }}
          title="Reset all configuration parameters to defaults"
        >
          <ArrowPathIcon className="w-3.5 h-3.5" /> Reset
        </button>
      </div>

      {/* Tab content */}
      <div className="card p-5">
        {activeTab === 'model'       && <ModelConfig />}
        {activeTab === 'descriptors' && <DescriptorConfig />}
        {activeTab === 'dsp'         && <DSPConfig />}
        {activeTab === 'preview'     && <ConfigPreview />}
      </div>

      {/* Navigation */}
      <div className="flex justify-between">
        <button className="btn-secondary" onClick={() => setStep(1)}>
          <ArrowLeftIcon className="w-4 h-4" /> Back
        </button>
        <button className="btn-primary" onClick={() => setStep(3)}>
          Continue to Encoding <ArrowRightIcon className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
