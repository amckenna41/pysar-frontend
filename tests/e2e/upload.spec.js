/**
 * E2E tests for Step 1 — Dataset Upload.
 *
 * Covers: file input, drag-and-drop area, stat cards, validation panels,
 * example dataset loading, and the "Next" button state.
 *
 * The backend is expected to be running at http://localhost:8000.
 * If the backend is unavailable, upload tests that hit the API will be skipped.
 */
import { test, expect } from '@playwright/test'
import { THERMO_CSV, SMALL_CSV, INVALID_AA_CSV, DUPLICATE_CSV, toBuffer } from './fixtures/datasets.js'

// Navigate past the landing page before every test
async function enterApp(page) {
  await page.goto('/')
  const cta = page.getByRole('button', { name: /enter|get started|start|launch/i })
    .or(page.getByRole('link', { name: /enter|get started|start|launch/i }))
  await cta.first().click()
  // Wait for the upload step to appear
  await expect(page.getByText(/upload|drop/i).first()).toBeVisible({ timeout: 5000 })
}

test.describe('Step 1 — Upload', () => {
  test.beforeEach(async ({ page }) => {
    await enterApp(page)
  })

  // ── UI presence ────────────────────────────────────────────────────────────

  test('drop zone / file input is rendered', async ({ page }) => {
    const dropzone = page.locator('[data-testid="dropzone"], .dropzone, input[type="file"]').first()
    await expect(dropzone).toBeVisible()
  })

  test('example dataset buttons are visible', async ({ page }) => {
    // Each example dataset should have a clickable button or link
    await expect(page.getByText(/thermostability/i).first()).toBeVisible()
  })

  // ── File upload ────────────────────────────────────────────────────────────

  test('uploading a valid CSV shows dataset preview', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.setInputFiles({
      name: 'test.csv',
      mimeType: 'text/csv',
      buffer: toBuffer(SMALL_CSV),
    })
    // Preview table or row count should appear
    await expect(page.getByText(/3 rows|3 sequences|preview/i).first()).toBeVisible({ timeout: 10000 })
  })

  test('uploading a valid CSV shows activity stats card', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.setInputFiles({
      name: 'test.csv',
      mimeType: 'text/csv',
      buffer: toBuffer(THERMO_CSV),
    })
    await expect(page.getByText(/activity|T50/i).first()).toBeVisible({ timeout: 10000 })
  })

  test('sequence column is auto-guessed as "sequence"', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.setInputFiles({
      name: 'test.csv',
      mimeType: 'text/csv',
      buffer: toBuffer(SMALL_CSV),
    })
    // The column selector should show "sequence" selected
    await expect(page.getByText('sequence').first()).toBeVisible({ timeout: 10000 })
  })

  test('invalid amino acid file shows validation warning', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.setInputFiles({
      name: 'bad.csv',
      mimeType: 'text/csv',
      buffer: toBuffer(INVALID_AA_CSV),
    })
    await expect(
      page.getByText(/invalid|character|amino acid/i).first()
    ).toBeVisible({ timeout: 10000 })
  })

  test('duplicate sequence file shows duplicate warning', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.setInputFiles({
      name: 'dups.csv',
      mimeType: 'text/csv',
      buffer: toBuffer(DUPLICATE_CSV),
    })
    await expect(
      page.getByText(/duplicate/i).first()
    ).toBeVisible({ timeout: 10000 })
  })

  // ── Example datasets ───────────────────────────────────────────────────────

  test('clicking thermostability example loads dataset', async ({ page }) => {
    const btn = page.getByRole('button', { name: /thermostability/i })
      .or(page.getByText(/thermostability/i))
    await btn.first().click()
    // Preview should appear without a file upload
    await expect(
      page.getByText(/rows|sequences|preview/i).first()
    ).toBeVisible({ timeout: 15000 })
  })

  // ── Next step gating ───────────────────────────────────────────────────────

  test('"Next" or "Configure" button is disabled before any upload', async ({ page }) => {
    const nextBtn = page.getByRole('button', { name: /next|configure|continue/i }).first()
    // The button should either be disabled or absent until a file is uploaded
    const isDisabled = await nextBtn.isDisabled().catch(() => true)
    expect(isDisabled).toBe(true)
  })

  test('"Next" button is enabled after uploading a valid file', async ({ page }) => {
    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.setInputFiles({
      name: 'test.csv',
      mimeType: 'text/csv',
      buffer: toBuffer(SMALL_CSV),
    })
    // Wait for upload to complete
    await expect(page.getByText(/rows|preview/i).first()).toBeVisible({ timeout: 10000 })
    const nextBtn = page.getByRole('button', { name: /next|configure|continue/i }).first()
    await expect(nextBtn).toBeEnabled({ timeout: 5000 })
  })
})
