import { describe, it, expect } from 'vitest'
import { buildLeaderboard } from '../../components/JobsPanel'

describe('buildLeaderboard', () => {
  it('ranks completed jobs by best metric descending', () => {
    const rows = buildLeaderboard([
      { id: 'a', status: 'completed', best_metric: 0.7, strategy: 'aai', algorithm: 'ridge' },
      { id: 'b', status: 'completed', best_metric: 0.9, strategy: 'descriptor', algorithm: 'randomforest' },
      { id: 'c', status: 'completed', best_metric: 0.5, strategy: 'aai', algorithm: 'lasso' },
    ])
    expect(rows.map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(rows[0].metric).toBe(0.9)
  })

  it('excludes non-completed and metric-less jobs', () => {
    const rows = buildLeaderboard([
      { id: 'a', status: 'running', best_metric: 0.9 },
      { id: 'b', status: 'completed', best_metric: null, best_r2: null },
      { id: 'c', status: 'completed', best_metric: 0.4 },
    ])
    expect(rows.map((r) => r.id)).toEqual(['c'])
  })

  it('falls back to best_r2 when best_metric is absent', () => {
    const rows = buildLeaderboard([{ id: 'a', status: 'completed', best_r2: 0.8 }])
    expect(rows[0].metric).toBe(0.8)
  })

  it('carries classification metric name', () => {
    const rows = buildLeaderboard([
      { id: 'a', status: 'completed', best_metric: 0.88, task_type: 'classification', metric_name: 'Accuracy' },
    ])
    expect(rows[0].metric_name).toBe('Accuracy')
    expect(rows[0].task_type).toBe('classification')
  })

  it('returns an empty array for no input', () => {
    expect(buildLeaderboard()).toEqual([])
    expect(buildLeaderboard([])).toEqual([])
  })
})
