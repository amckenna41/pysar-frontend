import { useState, useEffect, useRef } from 'react'
import {
  CloudArrowUpIcon,
  Cog6ToothIcon,
  BoltIcon,
  ChartBarIcon,
  CheckCircleIcon,
  QuestionMarkCircleIcon,
  ClockIcon,
  TagIcon,
  CubeIcon,
  CpuChipIcon,
  Bars3Icon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { useAppStore } from '../store/appStore'
import { getJob } from '../utils/api'
import HowToModal from './HowToModal'

const NAV_STEPS = [
  { id: 1, label: 'Upload Dataset',     Icon: CloudArrowUpIcon },
  { id: 2, label: 'Configure',          Icon: Cog6ToothIcon },
  { id: 3, label: 'Encode & Train',     Icon: BoltIcon },
  { id: 4, label: 'Results',            Icon: ChartBarIcon },
]

export default function Layout({ children }) {
  const {
    step, setStep, dataset, results, enterLanding,
    showJobs, setShowJobs, jobHistory,
    showModelExplorer, setShowModelExplorer,
    showAaiExplorer, setShowAaiExplorer,
    showDescriptorExplorer, setShowDescriptorExplorer,
    job, updateJob, setResults, updateJobHistoryStatus,
  } = useAppStore()
  const [showHowTo, setShowHowTo] = useState(false)
  // Mobile sidebar toggle
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  // Track previous job status to detect transitions
  const prevJobStatus = useRef(null)
  // Badge shown on the step 3 nav item when a job completes while user is elsewhere
  const [jobDoneFlag, setJobDoneFlag] = useState(false)

  // ── Global keyboard shortcuts ─────────────────────────────────────────────
  useEffect(() => {
    function onKey(e) {
      // Escape: close any open overlay panel
      if (e.key === 'Escape') {
        setShowHowTo(false)
        setShowJobs(false)
        setShowModelExplorer(false)
        setShowAaiExplorer(false)
        setShowDescriptorExplorer(false)
        setMobileSidebarOpen(false)
      }
      // Alt+1..4: navigate steps (only when no overlay open)
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const num = parseInt(e.key, 10)
        if (num >= 1 && num <= 4 && isAccessible(num)) {
          e.preventDefault()
          navToStep(num)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ── Page title updates ────────────────────────────────────────────────────
  useEffect(() => {
    const titles = { 1: 'Upload Dataset', 2: 'Configure', 3: 'Encode & Train', 4: 'Results' }
    const panel = showDescriptorExplorer ? 'Descriptor Explorer'
      : showAaiExplorer ? 'AAI Explorer'
      : showModelExplorer ? 'Model Explorer'
      : showJobs ? 'Jobs'
      : null
    document.title = panel ? `pySAR — ${panel}` : `pySAR — ${titles[step] ?? 'App'}`
  }, [step, showJobs, showModelExplorer, showAaiExplorer, showDescriptorExplorer])

  // ── Background job polling (when user has navigated away from Step 3) ─────
  // Uses exponential backoff: 3s → 5s → 10s → 20s → 30s (capped)
  useEffect(() => {
    if (!job?.job_id || step === 3) return
    if (job.status !== 'pending' && job.status !== 'running') return
    const INTERVALS = [3000, 5000, 10000, 20000, 30000]
    let attempt = 0
    let tid = null
    let cancelled = false

    async function poll() {
      if (cancelled) return
      // Skip tick if tab is hidden; reschedule without advancing backoff
      if (!document.hidden) {
        try {
          const data = await getJob(job.job_id)
          if (cancelled) return
          updateJob(data)
          if (data.status === 'completed' && prevJobStatus.current !== 'completed') {
            prevJobStatus.current = 'completed'
            setJobDoneFlag(true)
            toast.success(`Encoding complete — ${data.results?.length ?? 0} models evaluated`)
            setResults(data.results, data.columns)
            updateJobHistoryStatus(job.job_id, {
              status: 'completed',
              best_r2: data.results?.[0]?.R2 ?? null,
              completed_at: new Date().toISOString(),
            })
            return  // terminal state — stop polling
          }
          if (data.status === 'failed' && prevJobStatus.current !== 'failed') {
            prevJobStatus.current = 'failed'
            toast.error(`Encoding failed: ${data.error ?? 'Unknown error'}`)
            updateJobHistoryStatus(job.job_id, {
              status: 'failed',
              error: data.error,
              completed_at: new Date().toISOString(),
            })
            return  // terminal state — stop polling
          }
          // Still running — advance backoff
          attempt = Math.min(attempt + 1, INTERVALS.length - 1)
        } catch {
          // Network error — retry at current interval
        }
      }
      tid = setTimeout(poll, INTERVALS[attempt])
    }

    tid = setTimeout(poll, INTERVALS[0])
    return () => { cancelled = true; clearTimeout(tid) }
  }, [job?.job_id, job?.status, step])

  // Clear all overlay panels and navigate to a step
  function navToStep(id) {
    setStep(id)
    setShowJobs(false)
    setShowModelExplorer(false)
    setShowAaiExplorer(false)
    setShowDescriptorExplorer(false)
    // Dismiss job-done badge when user navigates to encode or results
    if (id === 3 || id === 4) setJobDoneFlag(false)
  }

  // Determine which steps are accessible
  function isAccessible(id) {
    if (id === 1) return true
    if (id === 2) return !!dataset
    if (id === 3) return !!dataset
    if (id === 4) return !!results
    return false
  }

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      {/* ── Mobile sidebar overlay backdrop ── */}
      {mobileSidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/40 md:hidden"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      {/* ── Sidebar ── */}
      <aside className={[
        'flex flex-col w-56 shrink-0 border-r border-gray-200 bg-white',
        'fixed inset-y-0 left-0 z-30 transition-transform duration-200',
        'md:relative md:translate-x-0',
        mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full',
      ].join(' ')}>
        {/* Logo — click to return to landing page */}
        <div className="flex items-center border-b border-gray-100">
          <button
            onClick={enterLanding}
            className="flex items-center gap-2 px-5 py-4 hover:bg-gray-50 transition-colors flex-1 text-left"
            title="Back to home"
          >
            <img src="/pySAR1.png" alt="pySAR" className="w-8 h-8 object-contain" />
            <span className="text-base font-bold text-gray-900 tracking-tight">pySAR</span>
          </button>
          {/* Mobile close button */}
          <button
            onClick={() => setMobileSidebarOpen(false)}
            className="md:hidden p-2 mr-2 rounded-lg text-gray-400 hover:bg-gray-100"
            aria-label="Close sidebar"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Step navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV_STEPS.map(({ id, label, Icon }) => {
            const accessible = isAccessible(id)
            const active = step === id
            const completed = step > id

            return (
              <button
                key={id}
                onClick={() => { accessible && navToStep(id) }}
                disabled={!accessible}
                className={[
                  'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  active && completed
                    ? 'bg-green-50 text-green-700'
                    : active
                    ? 'bg-indigo-50 text-indigo-700'
                    : completed && accessible
                    ? 'text-gray-700 hover:bg-gray-50'
                    : accessible
                    ? 'text-gray-600 hover:bg-gray-50'
                    : 'text-gray-300 cursor-not-allowed',
                ].join(' ')}
              >
                {/* Step number / check badge */}
                <span
                  className={[
                    'flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold shrink-0',
                    active && completed
                      ? 'bg-green-500 text-white'
                      : active
                      ? 'bg-indigo-600 text-white'
                      : completed
                      ? 'bg-green-500 text-white'
                      : 'bg-gray-200 text-gray-500',
                  ].join(' ')}
                >
                  {completed ? <CheckCircleIcon className="w-4 h-4" /> : id}
                </span>
                <span className="truncate">{label}</span>
                {/* Green dot badge when a job completes while user is on a different step */}
                {id === 3 && jobDoneFlag && (
                  <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" title="Job completed" />
                )}
              </button>
            )
          })}
        </nav>

        {/* ── Explorer + utility buttons ── */}
        <div className="px-3 pb-2 space-y-1">
          {/* Jobs history button */}
          <button
            onClick={() => { setShowJobs(!showJobs); setShowAaiExplorer(false); setShowDescriptorExplorer(false) }}
            className={[
              'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
              showJobs
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-600 hover:bg-gray-50',
            ].join(' ')}
          >
            <ClockIcon className={`w-5 h-5 shrink-0 ${showJobs ? 'text-indigo-600' : 'text-gray-400'}`} />
            <span className="flex-1 text-left">Jobs</span>
            {jobHistory.length > 0 && (
              <span className="text-xs font-semibold bg-gray-200 text-gray-600 rounded-full px-1.5 py-0.5">
                {jobHistory.length}
              </span>
            )}
          </button>
          {/* Model Explorer button */}
          <button
            onClick={() => { setShowModelExplorer(!showModelExplorer); setShowJobs(false); setShowAaiExplorer(false); setShowDescriptorExplorer(false) }}
            className={[
              'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
              showModelExplorer
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-600 hover:bg-gray-50',
            ].join(' ')}
          >
            <CpuChipIcon className={`w-5 h-5 shrink-0 ${showModelExplorer ? 'text-indigo-600' : 'text-gray-400'}`} />
            <span className="flex-1 text-left">Model Explorer</span>
          </button>
          {/* AAI Explorer button */}
          <button
            onClick={() => { setShowAaiExplorer(!showAaiExplorer); setShowJobs(false); setShowModelExplorer(false); setShowDescriptorExplorer(false) }}
            className={[
              'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
              showAaiExplorer
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-600 hover:bg-gray-50',
            ].join(' ')}
          >
            <TagIcon className={`w-5 h-5 shrink-0 ${showAaiExplorer ? 'text-indigo-600' : 'text-gray-400'}`} />
            <span className="flex-1 text-left">AAI Explorer</span>
          </button>
          {/* Descriptor Explorer button */}
          <button
            onClick={() => { setShowDescriptorExplorer(!showDescriptorExplorer); setShowJobs(false); setShowModelExplorer(false); setShowAaiExplorer(false) }}
            className={[
              'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
              showDescriptorExplorer
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-600 hover:bg-gray-50',
            ].join(' ')}
          >
            <CubeIcon className={`w-5 h-5 shrink-0 ${showDescriptorExplorer ? 'text-indigo-600' : 'text-gray-400'}`} />
            <span className="flex-1 text-left">Descriptor Explorer</span>
          </button>
        </div>

      </aside>

      {/* ── Main area ── */}
      <main className="flex-1 overflow-y-auto md:ml-0">
        {/* Top header bar */}
        <header className="sticky top-0 z-10 flex items-center justify-between px-4 md:px-6 py-3 bg-white/80 backdrop-blur border-b border-gray-200">
          <div className="flex items-center gap-3">
            {/* Hamburger button — visible on mobile only */}
            <button
              onClick={() => setMobileSidebarOpen((o) => !o)}
              className="md:hidden p-1.5 rounded-lg text-gray-500 hover:bg-gray-100"
              aria-label="Open sidebar menu"
            >
              <Bars3Icon className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-base font-semibold text-gray-900">
                {showDescriptorExplorer ? 'Descriptor Explorer'
                  : showAaiExplorer ? 'AAI Explorer'
                  : showModelExplorer ? 'Model Explorer'
                  : showJobs ? 'Jobs'
                  : NAV_STEPS.find((s) => s.id === step)?.label}
              </h1>
              <p className="text-sm text-gray-400">
                {showDescriptorExplorer ? 'Browse physicochemical & structural descriptors'
                  : showAaiExplorer ? 'Browse the AAIndex1 database'
                  : showModelExplorer ? 'Compare and select ML algorithms'
                  : showJobs ? `${jobHistory.length} job${jobHistory.length !== 1 ? 's' : ''} in history`
                  : `Step ${step} of ${NAV_STEPS.length}`}
              </p>
            </div>
          </div>

          {/* How to button */}
          <button
            onClick={() => setShowHowTo(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 transition-colors"
            aria-label="Open how-to guide"
          >
            <QuestionMarkCircleIcon className="w-4 h-4" />
            <span className="hidden sm:inline">How to</span>
          </button>
        </header>

        {/* How-to guide modal */}
        {showHowTo && <HowToModal onClose={() => setShowHowTo(false)} />}

        {/* Page content */}
        <div className="p-6">{children}</div>
      </main>
    </div>
  )
}
