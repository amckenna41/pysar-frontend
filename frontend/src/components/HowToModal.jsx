import { useEffect, useRef } from 'react'
import {
  XMarkIcon,
  CloudArrowUpIcon,
  Cog6ToothIcon,
  BoltIcon,
  ChartBarIcon,
  LightBulbIcon,
} from '@heroicons/react/24/outline'

const STEPS = [
  {
    id: 1,
    Icon: CloudArrowUpIcon,
    color: 'indigo',
    title: 'Upload Dataset',
    bullets: [
      'Drag & drop or browse for a .txt, .csv, or .tsv file containing protein sequences and activity values.',
      'pySAR auto-detects your sequence and activity columns — confidence badges show how certain the detection is. Use the dropdowns to correct if needed.',
      'Data quality banners flag issues automatically: missing values (with options to impute mean/median or remove rows), duplicate sequences (with one-click deduplication), outliers (>3σ), and non-standard amino acid characters.',
      'The activity distribution histogram and sequence length distribution chart appear after upload to help you understand your dataset.',
      'Try a built-in sample dataset (thermostability, absorption, etc.) via the "Try a sample dataset" link if you don\'t have your own file ready.',
      'Any fix operation (deduplicate, impute, etc.) saves a snapshot so you can restore the original data at any time.',
    ],
  },
  {
    id: 2,
    Icon: Cog6ToothIcon,
    color: 'violet',
    title: 'Configure',
    bullets: [
      'Four tabs let you configure every aspect of the pipeline: Model, Descriptors, DSP, and Config Preview.',
      'Model tab: choose from 10+ regression algorithms (PLSRegression, Random Forest, SVR, Ridge, etc.) and set hyperparameters and train/test split.',
      'Descriptors tab: select which of the 15 protpy descriptors to include and adjust per-descriptor metaparameters (e.g. autocorrelation lag, CTD properties).',
      'DSP tab: enable Digital Signal Processing to convert AAIndex-encoded sequences into protein spectra. Choose spectrum type (power, real, imaginary, absolute) and apply windowing or filter functions.',
      'Config Preview tab: inspect the full JSON configuration that will be sent to the backend before encoding begins.',
    ],
  },
  {
    id: 3,
    Icon: BoltIcon,
    color: 'amber',
    title: 'Encode & Train',
    bullets: [
      'Choose an encoding strategy: AAI (AAIndex indices only), Descriptor (protpy descriptors only), or AAI + Descriptor (combined).',
      'For AAI strategies, select specific indices from the 566-index AAIndex1 database or leave empty to scan all indices. Use the AAI Explorer panel to browse, filter by category, and add indices to your selection.',
      'For Descriptor strategies, check the descriptors you want to include — long names wrap correctly inside the grid.',
      'Warnings highlight if selected autocorrelation descriptors exceed your shortest sequence length.',
      'A live encoding summary at the bottom of the page confirms your selected strategy, indices, and descriptors before you run.',
      'Progress is streamed in real time. Jobs are queued and visible in the Jobs panel.',
    ],
  },
  {
    id: 4,
    Icon: ChartBarIcon,
    color: 'green',
    title: 'Results',
    bullets: [
      'The Top Model card displays the best-performing model in large text with its full metric breakdown (R², RMSE, MSE, MAE, RPD, Explained Variance).',
      '"Use this model" pre-fills Step 3 with that index or descriptor so you can re-run with refined settings.',
      'Pin rows in the results table to compare multiple models side-by-side in the Pinned Comparison panel, with deltas shown relative to the overall best.',
      'Sort the table by any metric column and toggle between chart views to visualise performance across runs.',
      'Download results as CSV for offline analysis.',
    ],
  },
]

const COLOR_MAP = {
  indigo: { bg: 'bg-indigo-100 dark:bg-indigo-900/40', text: 'text-indigo-600 dark:text-indigo-400', badge: 'bg-indigo-600' },
  violet: { bg: 'bg-violet-100 dark:bg-violet-900/40', text: 'text-violet-600 dark:text-violet-400', badge: 'bg-violet-600' },
  amber:  { bg: 'bg-amber-100 dark:bg-amber-900/40',  text: 'text-amber-600 dark:text-amber-400',  badge: 'bg-amber-500'  },
  green:  { bg: 'bg-green-100 dark:bg-green-900/40',  text: 'text-green-600 dark:text-green-400',  badge: 'bg-green-600'  },
}

export default function HowToModal({ onClose }) {
  const panelRef = useRef(null)

  // Close on Escape key
  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  // Focus trap: auto-focus first element and cycle Tab within the modal
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    const all = () => Array.from(panel.querySelectorAll(FOCUSABLE))
    // Move focus into modal on open
    all()[0]?.focus()
    function trapTab(e) {
      if (e.key !== 'Tab') return
      const els = all()
      if (!els.length) return
      const first = els[0]
      const last  = els[els.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus() }
      } else {
        if (document.activeElement === last)  { e.preventDefault(); first.focus() }
      }
    }
    panel.addEventListener('keydown', trapTab)
    return () => panel.removeEventListener('keydown', trapTab)
  }, [])

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* Modal panel */}
      <div ref={panelRef} className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-gray-900 shadow-2xl border border-gray-200 dark:border-gray-700">

        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <LightBulbIcon className="w-5 h-5 text-indigo-500" />
            <h2 className="text-base font-bold text-gray-900 dark:text-white">How to use pySAR</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label="Close"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Steps */}
        <div className="px-6 py-4 space-y-4">
          {STEPS.map(({ id, Icon, color, title, bullets }) => {
            const c = COLOR_MAP[color]
            return (
              <div key={id} className="flex gap-4 p-4 rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700/50">
                {/* Icon + step number */}
                <div className="flex flex-col items-center gap-1.5 shrink-0">
                  <div className={`flex items-center justify-center w-9 h-9 rounded-lg ${c.bg}`}>
                    <Icon className={`w-5 h-5 ${c.text}`} />
                  </div>
                  <span className={`text-[10px] font-bold text-white px-1.5 py-0.5 rounded-full ${c.badge}`}>
                    {id}
                  </span>
                </div>
                {/* Content */}
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-2">{title}</h3>
                  <ul className="space-y-1.5 list-disc list-outside pl-4">
                    {bullets.map((b, i) => (
                      <li key={i} className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{b}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )
          })}
        </div>

        {/* Tips */}
        <div className="mx-6 mb-6 p-4 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-100 dark:border-indigo-800/40">
          <p className="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-1.5">Tips</p>
          <ul className="text-xs text-indigo-600 dark:text-indigo-400 space-y-1 list-disc list-inside">
            <li>The sidebar shows your current progress and lets you jump between steps at any time.</li>
            <li>Re-run encoding with different strategies or indices without re-uploading your dataset.</li>
            <li>Use the AAI Explorer to browse all 566 indices, filter by category, and build your selection before encoding.</li>
            <li>The Descriptor Explorer shows feature counts and descriptions for all 15 protpy descriptors.</li>
            <li>Data fixes (impute, deduplicate, remove outliers) are non-destructive — restore original data with one click.</li>
            <li>Pin models in the Results table to compare them side-by-side with delta values shown vs. the best.</li>
            <li>Hover over truncated sequences in the dataset preview to see the full sequence in a tooltip.</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
