/**
 * Global test setup — imported before every Vitest test file.
 *
 * - Extends expect() with @testing-library/jest-dom matchers
 *   (toBeInTheDocument, toHaveClass, toBeDisabled, etc.)
 * - Installs a minimal localStorage stub for jsdom
 */
import '@testing-library/jest-dom'

// jsdom provides localStorage but doesn't persist across calls in some
// configurations. Wrap to ensure a clean Map-backed implementation.
const _localStorageStore = new Map()
const localStorageMock = {
  getItem: (k) => _localStorageStore.get(k) ?? null,
  setItem: (k, v) => _localStorageStore.set(k, String(v)),
  removeItem: (k) => _localStorageStore.delete(k),
  clear: () => _localStorageStore.clear(),
  get length() { return _localStorageStore.size },
  key: (i) => [..._localStorageStore.keys()][i] ?? null,
}
Object.defineProperty(window, 'localStorage', { value: localStorageMock })

// Clear localStorage before every test
beforeEach(() => localStorageMock.clear())

// Polyfill Blob.prototype.text for jsdom environments where it is not implemented.
// File inherits from Blob, so this also fixes File.prototype.text.
if (typeof Blob !== 'undefined' && typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error)
      reader.readAsText(this)
    })
  }
}
