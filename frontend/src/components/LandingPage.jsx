import { useEffect, useRef, useState, useCallback } from 'react'
import {
  BeakerIcon,
  CpuChipIcon,
  ChartBarIcon,
  ArrowRightIcon,
  SignalIcon,
  TableCellsIcon,
  BoltIcon,
  AcademicCapIcon,
  PlayIcon,
} from '@heroicons/react/24/outline'
import { useAppStore } from '../store/appStore'
import { loadExampleDataset } from '../utils/api'
import toast from 'react-hot-toast'

/* Inline GitHub SVG mark */
function GitHubIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844a9.59 9.59 0 012.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  )
}

// ── Animated counter hook (IntersectionObserver + count-up) ───────────────────
function useCountUp(target, duration = 1200) {
  const [count, setCount] = useState(0)
  const ref = useRef(null)
  const started = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !started.current) {
        started.current = true
        const num = parseInt(target, 10)
        if (isNaN(num)) { setCount(target); return }
        const start = performance.now()
        const step = (now) => {
          const t = Math.min((now - start) / duration, 1)
          // Ease-out cubic
          const eased = 1 - Math.pow(1 - t, 3)
          setCount(Math.round(eased * num))
          if (t < 1) requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      }
    }, { threshold: 0.3 })
    observer.observe(el)
    return () => observer.disconnect()
  }, [target, duration])

  return { ref, count }
}

// ── Stat pill with animated count ────────────────────────────────────────────
function StatPill({ value, label }) {
  const numericPart = value.replace(/\D+$/, '')
  const suffix = value.replace(/^\d+/, '')
  const { ref, count } = useCountUp(numericPart)

  return (
    <div ref={ref} className="flex flex-col items-center px-5 py-3 rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm">
      <span className="text-2xl font-extrabold text-indigo-600 dark:text-indigo-400 tabular-nums">
        {count}{suffix}
      </span>
      <span className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{label}</span>
    </div>
  )
}

const FEATURES = [
  {
    Icon: TableCellsIcon,
    color: 'indigo',
    title: 'AAIndex Physicochemical Descriptors',
    description:
      'Encode protein sequences using 566 numerical indices from the Amino Acid Index (AAI) database via the custom-built aaindex package, covering physicochemical and biochemical properties of amino acids.',
  },
  {
    Icon: BeakerIcon,
    color: 'violet',
    title: 'Protein Descriptors',
    description:
      'Calculate a broad range of structural, physicochemical and biochemical descriptors via the custom-built protpy package — including autocorrelation, CTD, quasi-sequence order and more.',
  },
  {
    Icon: SignalIcon,
    color: 'amber',
    title: 'Digital Signal Processing',
    description:
      'Optionally transform encoded sequences into protein spectra using FFT, with support for power, imaginary, real and absolute spectra, plus windowing and filter functions.',
  },
  {
    Icon: CpuChipIcon,
    color: 'green',
    title: 'Regression ML Models',
    description:
      'Build predictive regression models (PLSRegression, Random Forest, SVM and more) trained on encoded sequences to accurately predict activity values of unseen proteins.',
  },
]

const APP_STEPS = [
  { n: '01', label: 'Upload Dataset',   desc: 'Load a labelled dataset of protein sequences with corresponding activity values.', step: 1 },
  { n: '02', label: 'Configure',        desc: 'Set your regression algorithm, descriptor parameters and optional DSP settings.', step: 2 },
  { n: '03', label: 'Encode & Train',   desc: 'Encode sequences using selected descriptors and train the predictive model.', step: 3 },
  { n: '04', label: 'View Results',     desc: 'Analyse R², RMSE, MAE, RPD and other metrics across all encoding runs.', step: 4 },
]

const COLOR = {
  indigo: { bg: 'bg-indigo-50 dark:bg-indigo-900/20', icon: 'text-indigo-500 dark:text-indigo-400', border: 'border-indigo-100 dark:border-indigo-800/40' },
  violet: { bg: 'bg-violet-50 dark:bg-violet-900/20', icon: 'text-violet-500 dark:text-violet-400', border: 'border-violet-100 dark:border-violet-800/40' },
  amber:  { bg: 'bg-amber-50 dark:bg-amber-900/20',   icon: 'text-amber-500 dark:text-amber-400',   border: 'border-amber-100 dark:border-amber-800/40'   },
  green:  { bg: 'bg-green-50 dark:bg-green-900/20',   icon: 'text-green-500 dark:text-green-400',   border: 'border-green-100 dark:border-green-800/40'   },
}

// ── Smooth scroll helper ─────────────────────────────────────────────────────
function scrollTo(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const ABSTRACT = `Accurately establishing the connection between a protein sequence and its function remains a focal point within the field of protein engineering, especially in the context of predicting the effects of mutations. From this, there has been a continued drive to build accurate and reliable predictive models via machine learning that allow for the virtual screening of many protein mutant sequences, measuring the relationship between sequence and 'fitness' or 'activity', commonly known as a Sequence-Activity-Relationship (SAR). An important preliminary stage in the building of these predictive models is the encoding of the chosen sequences. Evaluated in this work is a plethora of encoding strategies using the Amino Acid Index database, where the indices are transformed into their spectral form via Digital Signal Processing (DSP) techniques, as well as numerous protein structural and physiochemical descriptors. The encoding strategies are explored on a dataset curated to measure the thermostability of various mutants from a recombination library, designed from parental cytochrome P450s. In this work it was concluded that the implementation of protein spectra in concatenation with protein descriptors, together with the Partial Least Squares Regression (PLS) algorithm, gave the most noteworthy increase in the quality of the predictive models (as described in Encoding Strategy C), highlighting their utility in identifying an SAR. The accompanying software produced for this paper is termed pySAR (Python Sequence-Activity-Relationship), which allows for a user to find the optimal arrangement of structural and or physiochemical properties to encode their specific mutant library dataset; the source code is available at: https://github.com/amckenna41/pySAR.`

function ResearchUseCase() {
  const [showAbstract, setShowAbstract] = useState(false)

  return (
    <section className="max-w-4xl mx-auto px-6 py-10">
      <div className="p-6 rounded-2xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 shrink-0">
            <BeakerIcon className="w-5 h-5 text-indigo-500" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-gray-900 dark:text-white mb-1.5">Research Use Case</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
              pySAR was validated on predicting the <strong className="text-gray-700 dark:text-gray-300">thermostability (T50)</strong> of cytochrome P450 mutant protein sequences — the temperature at which 50% of a protein is irreversibly denatured after 10 minutes of incubation. It is designed for use in <strong className="text-gray-700 dark:text-gray-300">Protein Engineering</strong>, <strong className="text-gray-700 dark:text-gray-300">Directed Evolution</strong> and <strong className="text-gray-700 dark:text-gray-300">Drug Discovery</strong>, where in vitro experimentally determined activity values are available for a library of mutant sequences.
            </p>

            {/* Abstract toggle */}
            <button
              onClick={() => setShowAbstract(v => !v)}
              className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-200 transition-colors"
            >
              <AcademicCapIcon className="w-3.5 h-3.5" />
              {showAbstract ? 'Hide abstract' : 'View abstract'}
              <svg className={`w-3 h-3 transition-transform ${showAbstract ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {/* Collapsible abstract */}
            {showAbstract && (
              <div className="mt-3 p-4 rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700">
                <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">{ABSTRACT}</p>
              </div>
            )}

            {/* Publication metrics */}
            <div className="flex flex-wrap gap-3 mt-4">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-800/40">
                <AcademicCapIcon className="w-3.5 h-3.5" />
                Journal of Biomedical Informatics
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400 border border-green-100 dark:border-green-800/40">
                Peer Reviewed
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700">
                DOI: 10.1016/j.jbi.2022.104016
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

export default function LandingPage() {
  const { enterApp, setStep, setDataset } = useAppStore()
  const [loadingDemo, setLoadingDemo] = useState(false)

  // Navigate to a specific step
  const goToStep = useCallback((step) => {
    enterApp()
    setStep(step)
  }, [enterApp, setStep])

  // Load sample dataset and jump to results-ready state
  async function handleTryDemo() {
    setLoadingDemo(true)
    try {
      const result = await loadExampleDataset('thermostability')
      setDataset({ ...result, seq_col: result.seq_col_guess, act_col: result.act_col_guess })
      enterApp()
      setStep(1)
      toast.success(`Loaded demo dataset: ${result.filename} — configure & run to see results`)
    } catch {
      toast.error('Failed to load demo dataset')
    } finally {
      setLoadingDemo(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 overflow-x-hidden">

      {/* ── Top bar with smooth-scroll nav + dark mode toggle ── */}
      <header className="sticky top-0 z-20 grid grid-cols-3 items-center px-6 py-3 bg-white/80 dark:bg-gray-900/80 backdrop-blur border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-3">
          <img src="/pySAR1.png" alt="pySAR" className="w-11 h-11 object-contain" />
          <span className="text-xl font-bold tracking-tight">pySAR</span>
        </div>

        {/* Nav links (smooth scroll) — centred column */}
        <nav className="hidden md:flex items-center justify-center gap-8 text-sm font-medium text-gray-500 dark:text-gray-400">
          {[
            { label: 'About', id: 'about' },
            { label: 'Features', id: 'features' },
            { label: 'How It Works', id: 'how-it-works' },
            { label: 'Strategies', id: 'strategies' },
          ].map(({ label, id }) => (
            <button
              key={id}
              onClick={() => scrollTo(id)}
              className="hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="flex items-center justify-end gap-2">
          <a
            href="https://github.com/amckenna41/pySAR"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            <GitHubIcon className="w-4 h-4" />
            GitHub
          </a>
          <a
            href="https://doi.org/10.1016/j.jbi.2022.104016"
            target="_blank"
            rel="noreferrer"
            className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            Research Paper
          </a>
          <button
            onClick={enterApp}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors"
          >
            Launch App <ArrowRightIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* ── Hero (animated entrance) ── */}
      <section className="relative flex flex-col items-center text-center px-6 pt-20 pb-16 overflow-hidden">
        {/* Subtle radial glow */}
        <div className="absolute inset-0 -z-10 flex items-start justify-center pointer-events-none">
          <div className="w-[600px] h-[400px] rounded-full bg-indigo-400/10 dark:bg-indigo-500/10 blur-3xl" />
        </div>

        {/* Logo — staggered animation */}
        <img
          src="/pySAR.png"
          alt="pySAR logo"
          className="w-80 h-80 object-contain mb-4 drop-shadow-md anim-fade-up"
        />

        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight mb-4 leading-tight anim-fade-up-1">
          Python{' '}
          <span className="text-indigo-600 dark:text-indigo-400">Sequence Activity</span>
          <br />
          <span className="text-indigo-600 dark:text-indigo-400">Relationship</span> Analysis
        </h1>

        <p className="max-w-2xl text-base sm:text-lg text-gray-500 dark:text-gray-400 mb-8 leading-relaxed anim-fade-up-2">
          pySAR is a library for analysing <strong className="text-gray-700 dark:text-gray-200">Sequence–Activity Relationships (SARs)</strong> of protein sequences.
          Numerically encode protein datasets using physicochemical descriptors and AAIndex features, then build
          predictive regression models to estimate the activity of unseen sequences.
        </p>

        <div className="flex flex-col sm:flex-row items-center gap-3 anim-fade-up-3">
          <button
            onClick={enterApp}
            className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-500/20 transition-all"
          >
            Get Started <ArrowRightIcon className="w-4 h-4" />
          </button>
          {/* Live demo button */}
          <button
            onClick={handleTryDemo}
            disabled={loadingDemo}
            className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-all disabled:opacity-50"
          >
            <PlayIcon className="w-4 h-4" />
            {loadingDemo ? 'Loading…' : 'Try Demo Dataset'}
          </button>
          <a
            href="https://doi.org/10.1016/j.jbi.2022.104016"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-all"
          >
            <AcademicCapIcon className="w-4 h-4" />
            Read the Paper
          </a>
        </div>

        {/* Animated stat pills */}
        <div className="flex flex-wrap justify-center gap-4 mt-10 text-sm anim-fade-up-4">
          <StatPill value="566" label="AAIndex Indices" />
          <StatPill value="30+" label="Protein Descriptors" />
          <StatPill value="10+" label="ML Algorithms" />
          <StatPill value="3" label="Encoding Strategies" />
        </div>
      </section>

      {/* ── Introduction ── */}
      <section id="about" className="max-w-4xl mx-auto px-6 py-10 scroll-mt-20">
        <h2 className="text-xl font-bold text-center mb-2">About pySAR</h2>
        <p className="text-sm text-center text-gray-500 dark:text-gray-400 mb-8">A Python library for Sequence Activity Relationship analysis of protein sequences.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

          {/* What it is */}
          <div className="p-5 rounded-2xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-900/30 shrink-0">
                <CpuChipIcon className="w-4 h-4 text-indigo-500" />
              </div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">What is pySAR?</h3>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
              pySAR is a Python library for analysing <strong className="text-gray-700 dark:text-gray-300">Sequence Activity Relationships (SARs)</strong> and{' '}
              <strong className="text-gray-700 dark:text-gray-300">Sequence Function Relationships (SFRs)</strong> of protein sequences. It provides extensive
              functionalities for numerically encoding protein sequence datasets using a large range of available methodologies and features — drawing on physicochemical
              and biochemical properties from the{' '}
              <strong className="text-gray-700 dark:text-gray-300">Amino Acid Index (AAI)</strong> database as well as structural and physiochemical{' '}
              <strong className="text-gray-700 dark:text-gray-300">protein descriptors</strong>.
            </p>
          </div>

          {/* How it's used */}
          <div className="p-5 rounded-2xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-violet-50 dark:bg-violet-900/30 shrink-0">
                <ChartBarIcon className="w-4 h-4 text-violet-500" />
              </div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Predictive ML Models</h3>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
              Once an optimal encoding strategy is found, pySAR builds a{' '}
              <strong className="text-gray-700 dark:text-gray-300">predictive regression ML model</strong> using the encoded sequences as feature data and
              in vitro experimentally determined activity values as labels. This model can then accurately predict the activity of new unseen sequences — ideal for
              virtual screening within <strong className="text-gray-700 dark:text-gray-300">Protein Engineering</strong>,{' '}
              <strong className="text-gray-700 dark:text-gray-300">Directed Evolution</strong>, and{' '}
              <strong className="text-gray-700 dark:text-gray-300">Drug Discovery</strong>.
            </p>
          </div>

          {/* Companion packages */}
          <div className="p-5 rounded-2xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm md:col-span-2">
            <div className="flex items-center gap-2 mb-3">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 shrink-0">
                <BoltIcon className="w-4 h-4 text-emerald-500" />
              </div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Companion Packages</h3>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
              Two custom-built packages were developed alongside pySAR.{' '}
              <a href="https://github.com/amckenna41/aaindex" target="_blank" rel="noreferrer" className="font-medium text-indigo-600 dark:text-indigo-400 hover:underline">aaindex</a>{' '}
              is used for parsing the Amino Acid Index database — a collection of numerical indices representing physicochemical and biochemical properties of amino acids and amino acid pairs.{' '}
              <a href="https://github.com/amckenna41/protpy" target="_blank" rel="noreferrer" className="font-medium text-indigo-600 dark:text-indigo-400 hover:underline">protpy</a>{' '}
              is used for calculating a series of physiochemical, biochemical and structural protein descriptors. Both packages are integrated into pySAR but can also be used independently.
            </p>
          </div>

        </div>
      </section>

      {/* ── Research use case + publication metrics ── */}
      <ResearchUseCase />

      {/* ── Features ── */}
      <section id="features" className="max-w-4xl mx-auto px-6 py-10 scroll-mt-20">
        <h2 className="text-xl font-bold text-center mb-2">Key Capabilities</h2>
        <p className="text-sm text-center text-gray-500 dark:text-gray-400 mb-8">Everything you need to encode sequences and build predictive models.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {FEATURES.map(({ Icon, color, title, description }) => {
            const c = COLOR[color]
            return (
              <div key={title} className={`p-5 rounded-xl border ${c.border} ${c.bg}`}>
                <div className="flex items-center gap-3 mb-2">
                  <Icon className={`w-5 h-5 ${c.icon}`} />
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{description}</p>
              </div>
            )
          })}
        </div>
      </section>

      {/* ── Encoding strategies with inline SVG diagrams ── */}
      <section id="strategies" className="max-w-4xl mx-auto px-6 py-10 scroll-mt-20">
        <h2 className="text-xl font-bold text-center mb-2">Encoding Strategies</h2>
        <p className="text-sm text-center text-gray-500 dark:text-gray-400 mb-8">Three complementary approaches for representing protein sequences numerically.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            {
              Icon: TableCellsIcon,
              title: 'AAIndex Encoding',
              badge: 'AAI',
              badgeColor: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400',
              desc: 'Each amino acid in a sequence is replaced by a numerical value from a chosen AAIndex record, generating a feature vector representing the physicochemical profile of the sequence.',
            },
            {
              Icon: BeakerIcon,
              title: 'Descriptor Encoding',
              badge: 'DESC',
              badgeColor: 'bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-400',
              desc: 'Protein descriptors (e.g. autocorrelation, CTD, quasi-sequence order) are computed for each sequence, producing fixed-length feature vectors suitable for ML.',
            },
            {
              Icon: BoltIcon,
              title: 'AAI + Descriptor',
              badge: 'COMBO',
              badgeColor: 'bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400',
              desc: 'Combines AAIndex-encoded spectra with protein descriptor features, providing a richer feature representation for improved predictive performance.',
            },
          ].map(({ Icon, title, badge, badgeColor, desc }) => (
            <div key={title} className="flex flex-col p-5 rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <Icon className="w-5 h-5 text-gray-500 dark:text-gray-400" />
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeColor}`}>{badge}</span>
              </div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1.5">{title}</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works (interactive — click to jump to step) ── */}
      <section id="how-it-works" className="max-w-4xl mx-auto px-6 py-10 scroll-mt-20">
        <h2 className="text-xl font-bold text-center mb-2">How It Works</h2>
        <p className="text-sm text-center text-gray-500 dark:text-gray-400 mb-8">A guided four-step pipeline from raw sequences to model predictions. Click any step to jump in.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {APP_STEPS.map(({ n, label, desc, step }, i) => (
            <button
              key={n}
              onClick={() => goToStep(step)}
              className="relative flex flex-col p-5 rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm text-left hover:border-indigo-300 dark:hover:border-indigo-700 hover:shadow-md transition-all group"
            >
              {/* Connector arrow (desktop) */}
              {i < APP_STEPS.length - 1 && (
                <ArrowRightIcon className="hidden lg:block absolute -right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-300 dark:text-gray-600 z-10" />
              )}
              <span className="text-2xl font-black text-indigo-100 dark:text-indigo-900/60 mb-3 leading-none group-hover:text-indigo-200 dark:group-hover:text-indigo-800/60 transition-colors">{n}</span>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">{label}</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{desc}</p>
              <span className="mt-2 text-[10px] font-semibold text-indigo-500 dark:text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity">
                Go to step →
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="max-w-4xl mx-auto px-6 py-10">
        <div className="flex flex-col items-center text-center p-10 rounded-2xl bg-indigo-600 dark:bg-indigo-700 shadow-xl shadow-indigo-500/20">
          <ChartBarIcon className="w-10 h-10 text-indigo-200 mb-4" />
          <h2 className="text-xl font-bold text-white mb-2">Ready to analyse your sequences?</h2>
          <p className="text-sm text-indigo-200 mb-6 max-w-md">
            Upload your labelled protein dataset and start building predictive models in minutes.
          </p>
          <button
            onClick={enterApp}
            className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold text-indigo-600 bg-white hover:bg-indigo-50 shadow transition-all"
          >
            Get Started <ArrowRightIcon className="w-4 h-4" />
          </button>
        </div>
      </section>

      {/* ── Footer (expanded links) ── */}
      <footer className="border-t border-gray-200 dark:border-gray-800 mt-6 py-6 px-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-sm text-gray-400 dark:text-gray-500">
        <span>© 2026 AJ McKenna</span>
        <div className="flex items-center gap-4">
          <a href="https://github.com/amckenna41/pySAR" target="_blank" rel="noreferrer" className="hover:text-gray-600 dark:hover:text-gray-300 transition-colors">GitHub</a>
          <a href="https://pypi.org/project/pySAR/" target="_blank" rel="noreferrer" className="hover:text-gray-600 dark:hover:text-gray-300 transition-colors">PyPI</a>
          <a href="https://doi.org/10.1016/j.jbi.2022.104016" target="_blank" rel="noreferrer" className="hover:text-gray-600 dark:hover:text-gray-300 transition-colors">DOI</a>
          <a href="https://pySAR.readthedocs.io" target="_blank" rel="noreferrer" className="hover:text-gray-600 dark:hover:text-gray-300 transition-colors">Docs</a>
        </div>
      </footer>

    </div>
  )
}
