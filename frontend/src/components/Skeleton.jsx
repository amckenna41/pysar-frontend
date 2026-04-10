// Reusable skeleton shimmer components

export function SkeletonLine({ className = '' }) {
  return (
    <div className={`animate-pulse bg-gray-200 dark:bg-gray-700 rounded ${className}`} />
  )
}

export function SkeletonCard({ rows = 3, className = '' }) {
  return (
    <div className={`card p-4 space-y-3 ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonLine key={i} className={`h-4 ${i === 0 ? 'w-1/2' : i === rows - 1 ? 'w-3/4' : 'w-full'}`} />
      ))}
    </div>
  )
}

export function SkeletonTable({ cols = 5, rowCount = 8 }) {
  return (
    <div className="card overflow-hidden">
      {/* Header */}
      <div className="flex gap-4 px-4 py-3 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700">
        {Array.from({ length: cols }).map((_, i) => (
          <SkeletonLine key={i} className="h-3 flex-1 animate-pulse" />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rowCount }).map((_, i) => (
        <div key={i} className="flex gap-4 px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-b-0">
          {Array.from({ length: cols }).map((_, j) => (
            <SkeletonLine key={j} className={`h-3 flex-1 ${j === 0 ? 'w-2/3' : ''}`} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function SkeletonResultsSummary() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="card p-3 text-center space-y-2">
          <SkeletonLine className="h-6 w-16 mx-auto" />
          <SkeletonLine className="h-3 w-12 mx-auto" />
        </div>
      ))}
    </div>
  )
}
