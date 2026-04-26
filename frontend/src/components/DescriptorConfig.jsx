import { useState, useRef, useCallback } from 'react'
import {
  ChevronDownIcon, ChevronRightIcon, MagnifyingGlassIcon,
  ArrowTopRightOnSquareIcon, ArrowUpTrayIcon, XMarkIcon,
  DocumentTextIcon, TableCellsIcon,
} from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { useAppStore } from '../store/appStore'
import { uploadDescriptorsCSV } from '../utils/api'

// Common AAI property codes used in autocorrelation descriptors
const COMMON_AAI_PROPS = [
  'CIDH920105', 'BHAR880101', 'CHAM820101', 'CHAM820102',
  'CHOC760101', 'BIGC670101', 'CHAM810101', 'DAYM780201',
]

const CTD_PROPERTIES = [
  'hydrophobicity', 'normalized_vdwv', 'polarity', 'charge',
  'secondary_struct', 'solvent_accessibility', 'polarizability',
]

const DISTANCE_MATRICES = ['schneider-wrede', 'grantham']

// Descriptor metadata: which params each descriptor exposes
export const DESCRIPTORS = [
  { key: 'aggregation_propensity',              group: 'Composition',         label: 'Aggregation Propensity',              params: [] },
  { key: 'aliphatic_index',                     group: 'Composition',         label: 'Aliphatic Index',                     params: [] },
  { key: 'amino_acid_composition',              group: 'Composition',         label: 'Amino Acid Composition',              params: [] },
  { key: 'amino_acid_pair_composition',         group: 'Composition',         label: 'Amino Acid Pair Composition',         params: [] },
  { key: 'amphiphilic_pseudo_amino_acid_composition', group: 'Pseudo-AA',    label: 'Amphiphilic PAAC',                   params: ['lambda', 'weight'] },
  { key: 'aromaticity',                         group: 'Composition',         label: 'Aromaticity',                         params: [] },
  { key: 'boman_index',                         group: 'Composition',         label: 'Boman Index',                         params: [] },
  { key: 'charge_distribution',                 group: 'Composition',         label: 'Charge Distribution',                 params: ['ph'] },
  { key: 'conjoint_triad',                      group: 'Conjoint Triad',      label: 'Conjoint Triad',                      params: [] },
  { key: 'ctd',                                 group: 'CTD',                 label: 'CTD (Composition/Transition/Dist.)',  params: ['ctd_property', 'ctd_all'] },
  { key: 'ctd_composition',                     group: 'CTD',                 label: 'CTD Composition',                     params: ['ctd_property', 'ctd_all'] },
  { key: 'ctd_distribution',                    group: 'CTD',                 label: 'CTD Distribution',                    params: ['ctd_property', 'ctd_all'] },
  { key: 'ctd_transition',                      group: 'CTD',                 label: 'CTD Transition',                      params: ['ctd_property', 'ctd_all'] },
  { key: 'dipeptide_composition',               group: 'Composition',         label: 'Dipeptide Composition',               params: [] },
  { key: 'extinction_coefficient',              group: 'Composition',         label: 'Extinction Coefficient',              params: [] },
  { key: 'geary_autocorrelation',               group: 'Autocorrelation',     label: 'Geary Autocorrelation',               params: ['lag', 'properties', 'normalize'] },
  { key: 'gravy',                               group: 'Composition',         label: 'GRAVY (Grand Average Hydropathicity)', params: [] },
  { key: 'hydrophobic_moment',                  group: 'Composition',         label: 'Hydrophobic Moment',                  params: ['window', 'angle'] },
  { key: 'hydrophobic_polar_charged_composition',group: 'Composition',        label: 'Hydrophobic/Polar/Charged Composition', params: [] },
  { key: 'instability_index',                   group: 'Composition',         label: 'Instability Index',                   params: [] },
  { key: 'isoelectric_point',                   group: 'Composition',         label: 'Isoelectric Point',                   params: [] },
  { key: 'kmer_composition',                    group: 'Composition',         label: 'k-mer Composition',                   params: ['k'] },
  { key: 'molecular_weight',                    group: 'Composition',         label: 'Molecular Weight',                    params: [] },
  { key: 'moran_autocorrelation',               group: 'Autocorrelation',     label: 'Moran Autocorrelation',               params: ['lag', 'properties', 'normalize'] },
  { key: 'moreaubroto_autocorrelation',         group: 'Autocorrelation',     label: 'Moreau-Broto Autocorrelation',        params: ['lag', 'properties', 'normalize'] },
  { key: 'motif_composition',                   group: 'Composition',         label: 'Motif Composition',                   params: [] },
  { key: 'pseudo_amino_acid_composition',       group: 'Pseudo-AA',           label: 'Pseudo Amino Acid Composition',       params: ['lambda', 'weight'] },
  { key: 'quasi_sequence_order',                group: 'Quasi-Sequence-Order',label: 'Quasi-Sequence Order',               params: ['lag', 'weight', 'distance_matrix'] },
  { key: 'reduced_alphabet_composition',        group: 'Composition',         label: 'Reduced Alphabet Composition',        params: ['alphabet_size'] },
  { key: 'secondary_structure_propensity',      group: 'Composition',         label: 'Secondary Structure Propensity',      params: [] },
  { key: 'sequence_order_coupling_number',      group: 'Quasi-Sequence-Order',label: 'Sequence Order Coupling Number',      params: ['lag', 'distance_matrix'] },
  { key: 'shannon_entropy',                     group: 'Composition',         label: 'Shannon Entropy',                     params: [] },
  { key: 'tripeptide_composition',              group: 'Composition',         label: 'Tripeptide Composition',              params: [] },
]

const GROUP_COLORS = {
  'Composition':         'badge-indigo',
  'Autocorrelation':     'badge-amber',
  'Conjoint Triad':      'badge-green',
  'CTD':                 'badge-green',
  'Quasi-Sequence-Order':'badge-gray',
  'Pseudo-AA':           'badge-gray',
}

export default function DescriptorConfig() {
  const { config, setConfigValue, setShowDescriptorExplorer } = useAppStore()
  const [expanded, setExpanded] = useState({})
  const [search, setSearch] = useState('')
  const [csvUploading, setCsvUploading] = useState(false)
  const [csvProgress, setCsvProgress] = useState(0)
  const [csvMeta, setCsvMeta] = useState(null)       // { filename, columns, numeric_columns, shape, preview }
  const [showPreview, setShowPreview] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const csvInputRef = useRef(null)
  const desc = config.descriptors

  const toggle = (key) => setExpanded((s) => ({ ...s, [key]: !s[key] }))

  // Filter descriptors by search query (name, group, or key)
  const filtered = DESCRIPTORS.filter(({ key, label, group }) => {
    const q = search.toLowerCase()
    return !q || label.toLowerCase().includes(q) || group.toLowerCase().includes(q) || key.toLowerCase().includes(q)
  })

  // Expand all visible descriptors that have configurable params
  function expandAll() {
    const next = {}
    filtered.filter((d) => d.params.length > 0).forEach((d) => { next[d.key] = true })
    setExpanded((s) => ({ ...s, ...next }))
  }

  // Collapse all visible descriptors
  function collapseAll() {
    const next = {}
    filtered.forEach((d) => { next[d.key] = false })
    setExpanded((s) => ({ ...s, ...next }))
  }

  const anyExpanded = filtered.some((d) => expanded[d.key])

  function setDesc(path, val) {
    setConfigValue(['descriptors', ...path], val)
  }

  // Toggle an AAI property in the properties array for autocorrelation descriptors
  function toggleProp(descKey, prop) {
    const current = desc[descKey]?.properties ?? []
    const next = current.includes(prop)
      ? current.filter((p) => p !== prop)
      : [...current, prop]
    setDesc([descKey, 'properties'], next)
  }

  // Handle descriptors CSV file selection or drop
  const handleCsvFile = useCallback(async (file) => {
    if (!file) return
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!['csv', 'tsv', 'txt'].includes(ext)) {
      toast.error('Only .csv, .tsv, and .txt files are supported')
      return
    }
    setCsvUploading(true)
    setCsvProgress(0)
    try {
      const data = await uploadDescriptorsCSV(file, setCsvProgress)
      // Store the server-side path so encoding can find the file
      setDesc(['descriptors_csv'], data.file_path)
      setCsvMeta({ filename: data.filename, columns: data.columns, numeric_columns: data.numeric_columns, shape: data.shape, preview: data.preview })
      toast.success(`Descriptors CSV uploaded — ${data.shape[0]} rows × ${data.shape[1]} columns`)
    } catch (err) {
      const msg = err?.response?.data?.detail ?? err.message ?? 'Upload failed'
      toast.error(msg)
    } finally {
      setCsvUploading(false)
      setCsvProgress(0)
    }
  }, [setDesc])

  // Remove uploaded descriptors CSV
  function clearCsv() {
    setDesc(['descriptors_csv'], '')
    setCsvMeta(null)
    setShowPreview(false)
    if (csvInputRef.current) csvInputRef.current.value = ''
  }

  // Drag-and-drop handlers
  function onDragOver(e) { e.preventDefault(); setDragOver(true) }
  function onDragLeave() { setDragOver(false) }
  function onDrop(e) { e.preventDefault(); setDragOver(false); handleCsvFile(e.dataTransfer.files?.[0]) }

  // Whether a CSV is currently loaded (either via upload or path typed manually)
  const hasCsv = !!(desc.descriptors_csv)

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-800">Descriptor parameters</h3>

      {/* ── Pre-calculated descriptors CSV upload ── */}
      <div className="space-y-2">
        <label className="label">
          Pre-calculated descriptors CSV
          <span className="ml-1 text-gray-400 font-normal">(optional — skips recalculation)</span>
        </label>

        {!hasCsv ? (
          /* Drop zone when no CSV loaded */
          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => csvInputRef.current?.click()}
            className={[
              'w-full border-2 border-dashed rounded-xl px-6 py-8 flex flex-col items-center gap-2 cursor-pointer transition-colors',
              dragOver ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 bg-gray-50 hover:border-gray-300',
            ].join(' ')}
          >
            <ArrowUpTrayIcon className="w-8 h-8 text-gray-300" />
            <p className="text-sm text-gray-500 font-medium">
              {csvUploading ? `Uploading… ${csvProgress}%` : 'Drop a descriptors CSV here, or click to browse'}
            </p>
            <p className="text-xs text-gray-400">Supports .csv, .tsv, .txt</p>
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv,.tsv,.txt"
              className="hidden"
              onChange={(e) => handleCsvFile(e.target.files?.[0])}
            />
            {csvUploading && (
              <div className="w-48 h-1.5 bg-gray-200 rounded-full overflow-hidden mt-1">
                <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${csvProgress}%` }} />
              </div>
            )}
          </div>
        ) : (
          /* File info card when CSV is loaded */
          <div className="card px-4 py-3 space-y-2">
            <div className="flex items-center gap-3">
              <DocumentTextIcon className="w-5 h-5 text-indigo-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-700 truncate">
                  {csvMeta?.filename ?? desc.descriptors_csv}
                </p>
                {csvMeta && (
                  <p className="text-xs text-gray-400">
                    {csvMeta.shape[0]} rows × {csvMeta.shape[1]} columns ({csvMeta.numeric_columns.length} numeric)
                  </p>
                )}
              </div>
              {/* Preview toggle */}
              {csvMeta?.preview && (
                <button
                  type="button"
                  onClick={() => setShowPreview((v) => !v)}
                  className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700 font-medium shrink-0"
                >
                  <TableCellsIcon className="w-3.5 h-3.5" />
                  {showPreview ? 'Hide preview' : 'Preview'}
                </button>
              )}
              {/* Replace */}
              <button
                type="button"
                onClick={() => csvInputRef.current?.click()}
                className="text-xs text-gray-500 hover:text-indigo-600 font-medium shrink-0"
              >
                Replace
              </button>
              {/* Remove */}
              <button type="button" onClick={clearCsv} className="text-gray-400 hover:text-red-500 shrink-0" title="Remove descriptors CSV">
                <XMarkIcon className="w-4 h-4" />
              </button>
              {/* Hidden file input for replace */}
              <input
                ref={csvInputRef}
                type="file"
                accept=".csv,.tsv,.txt"
                className="hidden"
                onChange={(e) => handleCsvFile(e.target.files?.[0])}
              />
            </div>

            {/* Preview table */}
            {showPreview && csvMeta?.preview?.length > 0 && (
              <div className="overflow-x-auto border border-gray-200 rounded-lg mt-2 max-h-56 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-100 sticky top-0">
                    <tr>
                      {csvMeta.columns.map((col) => (
                        <th key={col} className="px-3 py-1.5 text-left font-medium text-gray-500 whitespace-nowrap">
                          {col}
                          {csvMeta.numeric_columns.includes(col) && (
                            <span className="ml-1 text-indigo-400 font-normal">#</span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {csvMeta.preview.map((row, ri) => (
                      <tr key={ri} className={ri % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                        {csvMeta.columns.map((col) => (
                          <td key={col} className="px-3 py-1 text-gray-600 whitespace-nowrap font-mono">
                            {row[col] ?? ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Note about skipping recalculation */}
            <p className="text-xs text-amber-600 bg-amber-50 rounded px-2 py-1.5">
              When a descriptors CSV is provided, pySAR will use these pre-calculated values instead of recalculating from sequences.
            </p>
          </div>
        )}
      </div>

      {/* Search + expand/collapse all */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <MagnifyingGlassIcon className="absolute left-3 top-2.5 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            className="input pl-9"
            placeholder="Filter descriptors…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          onClick={anyExpanded ? collapseAll : expandAll}
          className="text-xs px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:border-indigo-400 hover:text-indigo-700 bg-white transition-colors whitespace-nowrap"
        >
          {anyExpanded ? 'Collapse all ▲' : 'Expand all ▼'}
        </button>
      </div>

      <p className="text-xs text-gray-500">
        Showing {filtered.length} of {DESCRIPTORS.length} descriptors. Expand to configure metaparameters.
      </p>

      {/* Accordion */}
      <div className="space-y-2">
        {filtered.map(({ key, label, group, params }) => {
          const isOpen = expanded[key]
          const hasParams = params.length > 0

          return (
            <div key={key} className="border border-gray-200 rounded-lg overflow-hidden">
              <button
                onClick={() => hasParams && toggle(key)}
                className={[
                  'w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-gray-50 transition-colors',
                  !hasParams ? 'cursor-default' : '',
                ].join(' ')}
              >
                <div className="flex items-center gap-2">
                  <span className={GROUP_COLORS[group] ?? 'badge-gray'}>{group}</span>
                  <span className="text-sm font-medium text-gray-700">{label}</span>
                </div>
                <div className="flex items-center gap-2">
                  {/* Open in Descriptor Explorer shortcut */}
                  <span
                    role="button"
                    tabIndex={0}
                    title="Open in Descriptor Explorer"
                    onClick={(e) => { e.stopPropagation(); setShowDescriptorExplorer(true) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setShowDescriptorExplorer(true) } }}
                    className="text-gray-300 hover:text-indigo-500 transition-colors"
                  >
                    <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                  </span>
                  {hasParams && (
                    isOpen
                      ? <ChevronDownIcon className="w-4 h-4 text-gray-400" />
                      : <ChevronRightIcon className="w-4 h-4 text-gray-400" />
                  )}
                </div>
              </button>

              {isOpen && hasParams && (
                <div className="px-4 pb-4 pt-2 bg-gray-50 space-y-3 border-t border-gray-200">
                  <DescriptorParams
                    descKey={key}
                    params={params}
                    desc={desc}
                    setDesc={setDesc}
                    toggleProp={toggleProp}
                  />
                </div>
              )}
            </div>
          )
        })}
        {filtered.length === 0 && (
          <p className="text-center py-8 text-sm text-gray-400">No descriptors match your search.</p>
        )}
      </div>
    </div>
  )
}

function DescriptorParams({ descKey, params, desc, setDesc, toggleProp }) {
  const values = desc[descKey] ?? {}

  return (
    <div className="space-y-3">
      {params.includes('lag') && (
        <div>
          <label className="label">Lag (max lag for autocorrelation)</label>
          <input
            type="number" className="input w-32"
            value={values.lag ?? 30} min={1} max={50}
            onChange={(e) => setDesc([descKey, 'lag'], parseInt(e.target.value, 10) || 30)}
          />
        </div>
      )}

      {params.includes('lambda') && (
        <div>
          <label className="label">Lambda</label>
          <input
            type="number" className="input w-32"
            value={values.lambda ?? 30} min={1}
            onChange={(e) => setDesc([descKey, 'lambda'], parseInt(e.target.value, 10) || 30)}
          />
        </div>
      )}

      {params.includes('weight') && (
        <div>
          <label className="label">Weight (correlation weighting factor)</label>
          <input
            type="number" className="input w-32"
            value={values.weight ?? 0.1} min={0} max={1} step={0.01}
            onChange={(e) => setDesc([descKey, 'weight'], parseFloat(e.target.value) || 0.1)}
          />
        </div>
      )}

      {params.includes('normalize') && (
        <div className="flex items-center gap-2">
          <input
            id={`norm-${descKey}`} type="checkbox"
            checked={!!values.normalize}
            onChange={(e) => setDesc([descKey, 'normalize'], e.target.checked ? 1 : 0)}
            className="w-4 h-4 accent-indigo-600"
          />
          <label htmlFor={`norm-${descKey}`} className="text-sm text-gray-700 cursor-pointer">
            Normalize autocorrelation values
          </label>
        </div>
      )}

      {params.includes('properties') && (
        <div>
          <label className="label">AAI physicochemical properties</label>
          <div className="grid grid-cols-2 gap-1.5 mt-1">
            {COMMON_AAI_PROPS.map((prop) => {
              const checked = (values.properties ?? []).includes(prop)
              return (
                <label key={prop} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox" checked={checked}
                    onChange={() => toggleProp(descKey, prop)}
                    className="accent-indigo-600"
                  />
                  <span className="text-xs font-mono text-gray-600">{prop}</span>
                </label>
              )
            })}
          </div>
        </div>
      )}

      {params.includes('ctd_property') && (
        <div>
          <label className="label">CTD physicochemical property</label>
          <select
            className="input"
            value={values.property ?? 'hydrophobicity'}
            onChange={(e) => setDesc([descKey, 'property'], e.target.value)}
          >
            {CTD_PROPERTIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      )}

      {params.includes('ctd_all') && (
        <div className="flex items-center gap-2">
          <input
            id={`ctd-all-${descKey}`} type="checkbox"
            checked={!!values.all}
            onChange={(e) => setDesc([descKey, 'all'], e.target.checked ? 1 : 0)}
            className="w-4 h-4 accent-indigo-600"
          />
          <label htmlFor={`ctd-all-${descKey}`} className="text-sm text-gray-700 cursor-pointer">
            Use all 7 physicochemical properties (147 features total)
          </label>
        </div>
      )}

      {params.includes('distance_matrix') && (
        <div>
          <label className="label">Distance matrix</label>
          <select
            className="input"
            value={values.distance_matrix ?? 'schneider-wrede'}
            onChange={(e) => setDesc([descKey, 'distance_matrix'], e.target.value)}
          >
            {DISTANCE_MATRICES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      )}

      {/* ── New params for pySAR v2.5.1 descriptors ── */}

      {params.includes('ph') && (
        <div>
          <label className="label">pH (for charge calculation, default 7.4)</label>
          <input
            type="number" className="input w-32"
            value={values.ph ?? 7.4} min={0} max={14} step={0.1}
            onChange={(e) => setDesc([descKey, 'ph'], parseFloat(e.target.value) || 7.4)}
          />
        </div>
      )}

      {params.includes('k') && (
        <div>
          <label className="label">k (k-mer length, e.g. 2 = dipeptides → 400 features)</label>
          <input
            type="number" className="input w-32"
            value={values.k ?? 2} min={1} max={5} step={1}
            onChange={(e) => setDesc([descKey, 'k'], parseInt(e.target.value, 10) || 2)}
          />
        </div>
      )}

      {params.includes('alphabet_size') && (
        <div>
          <label className="label">Alphabet size (reduced residue groups)</label>
          <select
            className="input w-32"
            value={values.alphabet_size ?? 6}
            onChange={(e) => setDesc([descKey, 'alphabet_size'], parseInt(e.target.value, 10))}
          >
            {[2, 3, 4, 6].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      )}

      {params.includes('window') && (
        <div>
          <label className="label">Window size (sliding window, default 11)</label>
          <input
            type="number" className="input w-32"
            value={values.window ?? 11} min={3} max={50} step={1}
            onChange={(e) => setDesc([descKey, 'window'], parseInt(e.target.value, 10) || 11)}
          />
        </div>
      )}

      {params.includes('angle') && (
        <div>
          <label className="label">Angle in degrees (helical rotation, default 100 for α-helix)</label>
          <input
            type="number" className="input w-32"
            value={values.angle ?? 100} min={1} max={360} step={1}
            onChange={(e) => setDesc([descKey, 'angle'], parseInt(e.target.value, 10) || 100)}
          />
        </div>
      )}
    </div>
  )
}
