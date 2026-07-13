import { describe, it, expect } from 'vitest'
import { csvSafeCell } from '../../utils/csvSafe'

describe('csvSafeCell', () => {
  it('prefixes formula-triggering strings with a single quote', () => {
    expect(csvSafeCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)")
    expect(csvSafeCell('+1')).toBe("'+1")
    expect(csvSafeCell('-cmd')).toBe("'-cmd")
    expect(csvSafeCell('@ref')).toBe("'@ref")
    expect(csvSafeCell('\tfoo')).toBe("'\tfoo")
  })

  it('leaves ordinary strings untouched', () => {
    expect(csvSafeCell('CIDH920105')).toBe('CIDH920105')
    expect(csvSafeCell('amino_acid_composition')).toBe('amino_acid_composition')
  })

  it('passes numbers through unchanged (including negatives)', () => {
    expect(csvSafeCell(-0.5)).toBe(-0.5)
    expect(csvSafeCell(42)).toBe(42)
    expect(csvSafeCell(null)).toBe(null)
    expect(csvSafeCell(undefined)).toBe(undefined)
  })
})
