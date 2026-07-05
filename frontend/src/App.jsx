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
import { checkBackend } from './utils/api'

// Read-only shared results are keyed off a ?share=<token> query param (feature 10).
const SHARE_TOKEN = new URLSearchParams(window.location.search).get('share')

const STEPS = {
  1: Step1Upload,
  2: Step2Configure,
  3: Step3Encode,
  4: Step4Results,
}

export default function App() {
  const { step, showLanding, showJobs, showModelExplorer, showAaiExplorer, showDescriptorExplorer, setBackendOnline } = useAppStore()

  // Probe backend once on mount and cache the result so all components can
  // skip backend calls immediately and fall back to static assets when offline.
  useEffect(() => {
    checkBackend().then(setBackendOnline)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to top whenever the encoding step changes.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [step])

  // A ?share=<token> link opens the read-only shared results, bypassing the app shell.
  if (SHARE_TOKEN) {
    return (
      <ErrorBoundary>
        <SharedResults token={SHARE_TOKEN} />
      </ErrorBoundary>
    )
  }

  // Show landing page before entering the app
  if (showLanding) return <LandingPage />

  const StepComponent = STEPS[step] || Step1Upload

  // Overlay panels take priority over step content
  const content = showDescriptorExplorer ? <DescriptorExplorer />
    : showAaiExplorer ? <AaiExplorer />
    : showModelExplorer ? <ModelExplorer />
    : showJobs ? <JobsPanel />
    : <StepComponent />

  return (
    <ErrorBoundary>
      <Layout>
        {content}
      </Layout>
    </ErrorBoundary>
  )
}
