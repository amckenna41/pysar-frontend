import { describe, it, expect } from 'vitest'
import { buildPysarConfig, generatePythonSnippet } from '../../utils/reproExport'

describe('buildPysarConfig', () => {
  it('maps params to the pySAR config shape', () => {
    const cfg = buildPysarConfig({
      filePath: '/data/x.csv', sequenceCol: 'seq', activityCol: 'T50',
      algorithm: 'randomforest', testSplit: 0.3, useCv: true, cvFolds: 10,
    })
    expect(cfg.dataset).toEqual({ dataset: '/data/x.csv', sequence_col: 'seq', activity: 'T50' })
    expect(cfg.model.algorithm).toBe('randomforest')
    expect(cfg.model.test_split).toBe(0.3)
    expect(cfg.model.use_cv).toBe(true)
    expect(cfg.model.cv_folds).toBe(10)
    expect(cfg.pyDSP).toEqual({ use_dsp: 0 })
  })

  it('applies defaults when params are omitted', () => {
    const cfg = buildPysarConfig({})
    expect(cfg.model.algorithm).toBe('plsregression')
    expect(cfg.model.test_split).toBe(0.2)
  })
})

describe('generatePythonSnippet', () => {
  it('emits an aai_encoding call for the aai strategy', () => {
    const src = generatePythonSnippet({ strategy: 'aai', best_model_name: 'CIDH920105' },
      { aaiIndices: ['CIDH920105'], sortBy: 'R2' })
    expect(src).toContain('from pySAR.encoding import Encoding')
    expect(src).toContain('encoding.aai_encoding(')
    expect(src).toContain("'CIDH920105'")
    expect(src).toContain('CIDH920105')  // referenced in the docstring
  })

  it('emits descriptor_encoding with desc_combo for the descriptor strategy', () => {
    const src = generatePythonSnippet({ strategy: 'descriptor' },
      { selectedDescriptors: ['amino_acid_composition', 'ctd'], descCombo: 2 })
    expect(src).toContain('encoding.descriptor_encoding(')
    expect(src).toContain('desc_combo=2')
    expect(src).toContain("'amino_acid_composition'")
  })

  it('embeds a json.loads config block that parses back to the config', () => {
    const src = generatePythonSnippet({ strategy: 'aai' }, { filePath: '/data/x.csv', algorithm: 'ridge' })
    const m = src.match(/json\.loads\(r'''\n([\s\S]*?)\n'''\)/)
    expect(m).toBeTruthy()
    const cfg = JSON.parse(m[1])
    expect(cfg.model.algorithm).toBe('ridge')
    expect(cfg.dataset.dataset).toBe('/data/x.csv')
  })

  it('notes the classification caveat', () => {
    const src = generatePythonSnippet({ strategy: 'aai', task_type: 'classification' }, {})
    expect(src.toLowerCase()).toContain('classification')
  })

  it('notes the embedding strategy is app-specific', () => {
    const src = generatePythonSnippet({ strategy: 'embedding' }, { embeddingModel: 'facebook/esm2_t6_8M_UR50D' })
    expect(src).toContain('embed_sequences')
  })
})
