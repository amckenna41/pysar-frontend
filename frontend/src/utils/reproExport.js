/**
 * Reproducibility export (feature 7).
 *
 * Turns a completed job + its encoding parameters into a runnable pySAR Python snippet
 * and the exact JSON config, so a result can be reproduced outside the app (e.g. for a
 * paper's methods section). Pure functions — no React, no network — so they're unit tested.
 */

/** Build the pySAR JSON config object that the backend assembled for this job. */
export function buildPysarConfig(params) {
  const {
    filePath = 'your_dataset.txt',
    sequenceCol = 'sequence',
    activityCol = 'activity',
    algorithm = 'plsregression',
    modelParameters = {},
    testSplit = 0.2,
    useCv = false,
    cvFolds = 5,
    descriptorsConfig = {},
    dspConfig = { use_dsp: 0 },
  } = params || {}

  return {
    dataset: { dataset: filePath, sequence_col: sequenceCol, activity: activityCol },
    model: {
      algorithm,
      parameters: modelParameters || {},
      test_split: testSplit,
      use_cv: useCv,
      cv_folds: cvFolds,
    },
    descriptors: descriptorsConfig || {},
    pyDSP: dspConfig || { use_dsp: 0 },
  }
}

function pyRepr(value) {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`
  return `'${String(value).replace(/'/g, "\\'")}'`
}

/**
 * Generate a runnable Python snippet reproducing a job's encoding.
 * @param {object} job     the completed job object (strategy, algorithm, best_config…)
 * @param {object} params  encoding parameters (aaiIndices, selectedDescriptors, descCombo…)
 * @returns {string} Python source
 */
export function generatePythonSnippet(job = {}, params = {}) {
  const strategy = job.strategy || params.strategy || 'aai'
  const config = buildPysarConfig(params)
  // Embed the config as a JSON literal and json.loads it — correct without hand-rolling
  // Python dict syntax. Triple-quoted so the multi-line JSON stays valid Python.
  const configJson = JSON.stringify(config, null, 2)

  const lines = []
  lines.push('"""')
  lines.push('Reproduce this pySAR encoding run.')
  lines.push('Requires: pip install "pysar @ git+https://github.com/amckenna41/pySAR.git"')
  if (job.best_model_name) lines.push(`Best model from the app run: ${job.best_model_name}`)
  lines.push('"""')
  lines.push('import json')
  lines.push('from pySAR.encoding import Encoding')
  lines.push('')
  lines.push('# 1. The exact config the app generated (edit the dataset path as needed).')
  lines.push(`config = json.loads(r'''`)
  lines.push(configJson)
  lines.push(`''')`)
  lines.push('')
  lines.push("with open('repro_config.json', 'w') as fh:")
  lines.push('    json.dump(config, fh, indent=2)')
  lines.push('')
  lines.push("encoding = Encoding(config_file='repro_config.json', verbose=True)")
  lines.push('')

  if (job.task_type === 'classification') {
    lines.push('# NOTE: classification is provided by the app\'s parallel sklearn layer,')
    lines.push('# not pySAR itself (pySAR is regression-only).')
  }

  lines.push('# 2. Run the same encoding strategy the app used.')
  if (strategy === 'aai') {
    const idx = params.aaiIndices && params.aaiIndices.length ? pyRepr(params.aaiIndices) : 'None'
    lines.push(`results = encoding.aai_encoding(aai_indices=${idx}, sort_by=${pyRepr(params.sortBy || 'R2')}, export_best_model=True)`)
  } else if (strategy === 'descriptor') {
    const desc = params.selectedDescriptors && params.selectedDescriptors.length ? pyRepr(params.selectedDescriptors) : 'None'
    lines.push(`results = encoding.descriptor_encoding(descriptors=${desc}, desc_combo=${params.descCombo || 1}, sort_by=${pyRepr(params.sortBy || 'R2')}, export_best_model=True)`)
  } else if (strategy === 'aai_descriptor') {
    const idx = params.aaiIndices && params.aaiIndices.length ? pyRepr(params.aaiIndices) : 'None'
    const desc = params.selectedDescriptors && params.selectedDescriptors.length ? pyRepr(params.selectedDescriptors) : 'None'
    lines.push(`results = encoding.aai_descriptor_encoding(aai_indices=${idx}, descriptors=${desc}, desc_combo=${params.descCombo || 1}, sort_by=${pyRepr(params.sortBy || 'R2')}, export_best_model=True)`)
  } else if (strategy === 'embedding') {
    lines.push('# The embedding strategy is app-specific (protein language-model features):')
    lines.push('#   from backend.embeddings import embed_sequences')
    lines.push(`#   X = embed_sequences(sequences, ${pyRepr(params.embeddingModel || 'facebook/esm2_t6_8M_UR50D')})`)
    lines.push('# then fit any sklearn estimator on X.')
  }
  lines.push('')
  lines.push('print(results.head(10))')
  return lines.join('\n')
}
