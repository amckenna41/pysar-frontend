/**
 * Shared dataset fixtures for E2E tests.
 *
 * These are plain text buffers used with Playwright's setInputFiles() to
 * simulate file uploads without needing real files on disk.
 */

/** 20-row thermostability-like CSV: sequence (standard AA) + T50 activity */
export const THERMO_CSV = [
  'sequence,T50',
  'ACDEFGHIKLMNPQRSTVWY,55.0',
  'CDEFGHIKLMNPQRSTVWYA,60.3',
  'DEFGHIKLMNPQRSTVWYAC,50.1',
  'EFGHIKLMNPQRSTVWYACD,65.7',
  'FGHIKLMNPQRSTVWYACDE,58.2',
  'GHIKLMNPQRSTVWYACDEF,72.0',
  'HIKLMNPQRSTVWYACDEFG,48.9',
  'IKLMNPQRSTVWYACDEFGH,61.5',
  'KLMNPQRSTVWYACDEFGHI,54.3',
  'LMNPQRSTVWYACDEFGHIK,69.8',
  'MNPQRSTVWYACDEFGHIKL,57.6',
  'NPQRSTVWYACDEFGHIKLM,63.1',
  'PQRSTVWYACDEFGHIKLMN,52.4',
  'QRSTVWYACDEFGHIKLMNP,66.9',
  'RSTVWYACDEFGHIKLMNPQ,51.2',
  'STVWYACDEFGHIKLMNPQR,70.4',
  'TVWYACDEFGHIKLMNPQRS,49.7',
  'VWYACDEFGHIKLMNPQRST,64.2',
  'WYACDEFGHIKLMNPQRSTV,53.8',
  'YACDEFGHIKLMNPQRSTVW,67.3',
].join('\n')

/** Small 3-row CSV for fast upload tests */
export const SMALL_CSV = [
  'sequence,T50',
  'ACDE,55.0',
  'FGHI,60.0',
  'KLMN,65.0',
].join('\n')

/** CSV with an invalid amino acid character in row 2 */
export const INVALID_AA_CSV = [
  'sequence,T50',
  'ACDE,55.0',
  'AC123DE,60.0',
  'FGHI,65.0',
].join('\n')

/** CSV with one duplicate sequence */
export const DUPLICATE_CSV = [
  'sequence,T50',
  'ACDE,55.0',
  'ACDE,61.3',
  'FGHI,60.0',
].join('\n')

/** Buffer helper: convert a string to a Buffer for setInputFiles */
export function toBuffer(str) {
  return Buffer.from(str, 'utf-8')
}
