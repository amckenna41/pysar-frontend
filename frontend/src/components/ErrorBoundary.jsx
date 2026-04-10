import { Component } from 'react'
import { ExclamationTriangleIcon, ArrowPathIcon } from '@heroicons/react/24/outline'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    this.setState({ info })
    console.error('[pySAR ErrorBoundary]', error, info)
  }

  handleReset() {
    this.setState({ hasError: false, error: null, info: null })
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-6">
        <div className="max-w-md w-full text-center space-y-4">
          <div className="flex justify-center">
            <span className="flex items-center justify-center w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/30">
              <ExclamationTriangleIcon className="w-8 h-8 text-red-500" />
            </span>
          </div>
          <h1 className="text-lg font-bold text-gray-900 dark:text-white">Something went wrong</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            An unexpected error occurred. You can try refreshing the page or resetting this view.
          </p>
          {/* Error detail (collapsed) */}
          {this.state.error && (
            <details className="text-left bg-gray-100 dark:bg-gray-800 rounded-lg p-3">
              <summary className="text-xs font-semibold text-gray-500 cursor-pointer select-none">
                Error details
              </summary>
              <pre className="mt-2 text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap break-all">
                {this.state.error.message}
                {this.state.info?.componentStack}
              </pre>
            </details>
          )}
          <div className="flex justify-center gap-3">
            <button
              onClick={() => this.handleReset()}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors"
            >
              <ArrowPathIcon className="w-4 h-4" /> Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    )
  }
}
