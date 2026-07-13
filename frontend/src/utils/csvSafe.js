/**
 * Spreadsheet formula-injection guard.
 *
 * Excel / Google Sheets evaluate any cell whose text begins with = + - @ (or a
 * leading tab / carriage return) as a formula, so a value like `=cmd|…` pulled from a
 * user-supplied filename or label becomes live code when the exported CSV/XLSX is
 * opened. Prefixing such strings with a single quote forces them to be treated as text.
 *
 * Only strings are touched — numbers pass through untouched so numeric metric columns
 * (including negatives like -0.5) stay real numbers in the sheet.
 */
export function csvSafeCell(value) {
  if (typeof value !== 'string') return value
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}
