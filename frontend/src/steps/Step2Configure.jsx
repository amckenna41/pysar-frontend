import { useRef, useState } from 'react'
import { ArrowLeftIcon, ArrowRightIcon, ArrowUpTrayIcon, ArrowDownTrayIcon, XMarkIcon, ArrowPathIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { useAppStore } from '../store/appStore'
import ModelConfig from '../components/ModelConfig'
import DescriptorConfig from '../components/DescriptorConfig'
import DSPConfig from '../components/DSPConfig'
import ConfigPreview from '../components/ConfigPreview'

const TABS = [
  { id: 'model',       label: 'Model' },
  { id: 'descriptors', label: 'Descriptors' },
  { id: 'dsp',         label: 'DSP' },
  { id: 'preview',     label: 'Config Preview' },
]

export default function Step2Configure() {
  const { setStep, config, importConfig, resetConfig } = useAppStore()
  const [activeTab, setActiveTab] = useState('model')
  const [importedFilename, setImportedFilename] = useState(null) // tracks uploaded config name
  const fileInputRef = useRef(null)

  // ── Parse and apply uploaded JSON config file ─────────────────────────────
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
        importConfig(parsed)
        setImportedFilename(file.name)
        toast.success(`Config loaded from ${file.name}`)
      } catch {
        toast.error('Invalid JSON — could not parse config file')
      }
    }
    reader.readAsText(file)
    e.target.value = '' // allow re-uploading same file
  }

  // ── Clear imported config and revert to defaults ──────────────────────────
  function clearImportedConfig() {
    resetConfig()
    setImportedFilename(null)
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

      {/* Tab bar + reset button */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-1 p-1 bg-gray-100 dark:bg-gray-800 rounded-lg">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={activeTab === id ? 'tab-btn-active' : 'tab-btn-inactive'}
            >
              {label}
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
