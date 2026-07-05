import { useEffect } from 'react'
import { useAppStore } from './store/appStore'
import Layout from './components/Layout'
import LandingPage from './components/LandingPage'
import JobsPanel from './components/JobsPanel'
import ModelExplorer from './components/ModelExplorer'
import AaiExplorer from './components/AaiExplorer'
import DescriptorExplorer from './components/DescriptorExplorer'
import ErrorBoundary from './components/ErrorBoundary'
import Step1Upload from './steps/Step1Upload'
import Step2Configure from './steps/Step2Configure'
import Step3Encode from './steps/Step3Encode'
import Step4Results from './steps/Step4Results'
import SharedResults from './components/SharedResults'
import { wakeBackend } from './utils/api'

// Read-only shared results are keyed off a ?share=<token> query param (feature 10).
const SHARE_TOKEN = new URLSearchParams(window.location.search).get('share')

const STEPS = {
  1: Step1Upload,
  2: Step2Configure,
  3: Step3Encode,
  4: Step4Results,
}

export default function App() {
  const { step, showLanding, showJobs, showModelExplorer, showAaiExplorer, showDescriptorExplorer, setBackendOnline, backendWaking, setBackendWaking } = useAppStore()

  // Probe backend once on mount, actively waking a cold (spun-down) backend so the
  // first upload/encode doesn't hard-fail. Show a "waking up…" banner while it warms.
  useEffect(() => {
    let cancelled = false
    wakeBackend(() => { if (!cancelled) setBackendWaking(true) }).then((up) => {
      if (cancelled) return
      setBackendWaking(false)
      setBackendOnline(up)
    })
    return () => { cancelled = true }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to top whenever the encoding step changes.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [step])

  // A ?share=<token> link opens the read-only shared results, bypassing the app shell.
  let view
  if (SHARE_TOKEN) {
    view = (
      <ErrorBoundary>
        <SharedResults token={SHARE_TOKEN} />
      </ErrorBoundary>
    )
  } else if (showLanding) {
    view = <LandingPage />
  } else {
    const StepComponent = STEPS[step] || Step1Upload
    // Overlay panels take priority over step content
    const content = showDescriptorExplorer ? <DescriptorExplorer />
      : showAaiExplorer ? <AaiExplorer />
      : showModelExplorer ? <ModelExplorer />
      : showJobs ? <JobsPanel />
      : <StepComponent />
    view = (
      <ErrorBoundary>
        <Layout>
          {content}
        </Layout>
      </ErrorBoundary>
    )
  }

  return (
    <>
      {backendWaking && <WakingBanner />}
      {view}
    </>
  )
}

// Thin top strip shown while a cold backend is warming up (see wakeBackend).
function WakingBanner() {
  return (
    <div
      role="status"
      className="fixed top-0 inset-x-0 z-50 flex items-center justify-center gap-2 bg-indigo-600 text-white text-sm px-4 py-2 shadow-md"
    >
      <svg className="w-4 h-4 animate-spin shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      <span>Waking up the server… this can take up to a minute on first visit.</span>
    </div>
  )
}
