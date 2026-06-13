export default function HelpTooltip({ tip, className = '' }) {
  return (
    <span className={`relative ml-1 group inline-flex items-center align-middle ${className}`.trim()}>
      <button
        type="button"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold leading-none text-gray-500 hover:border-indigo-400 hover:text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        aria-label="Show parameter help"
        onClick={(e) => e.preventDefault()}
      >
        ?
      </button>
      <span className="pointer-events-none absolute left-1/2 top-full z-[9999] mt-2 hidden w-64 max-w-[calc(100vw-1rem)] -translate-x-1/2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-left text-xs leading-relaxed text-gray-700 shadow-lg group-hover:block group-focus-within:block dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
        {tip}
      </span>
    </span>
  )
}
