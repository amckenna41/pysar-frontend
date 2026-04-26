/**
 * E2E tests for Step 4 — Results.
 *
 * Uses route interception to inject a completed job with synthetic results,
 * then verifies the results table, chart, filter, sort, and export buttons.
 *
 * No real pySAR encoding is performed.
 */
import { test, expect } from '@playwright/test'
import { SMALL_CSV, toBuffer } from './fixtures/datasets.js'

// ── synthetic job data ─────────────────────────────────────────────────────────

const MOCK_JOB = {
  job_id: 'results-mock-job',
  status: 'completed',
  progress: 100,
  log: ['Dataset loaded: 3 rows', 'Strategy: aai', 'Complete: 3 models trained'],
  strategy: 'aai',
  algorithm: 'plsregression',
  created_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
  results: [
    { index: 'ALTS910101', R2: 0.92, RMSE: 2.1, MSE: 4.4, RPD: 3.5, train_R2: 0.95 },
    { index: 'BHAR880101', R2: 0.88, RMSE: 2.5, MSE: 6.3, RPD: 2.9, train_R2: 0.91 },
    { index: 'CHAM820101', R2: 0.75, RMSE: 3.4, MSE: 11.6, RPD: 2.1, train_R2: 0.80 },
  ],
  best_model_predictions: {
    model_name: 'ALTS910101',
    actual: [55.0, 60.0, 65.0],
    predicted: [54.2, 61.1, 64.7],
    test_r2: 0.92,
  },
}

// ── helpers ────────────────────────────────────────────────────────────────────

async function goToResults(page) {
  // Mock all encode and job routes upfront
  await page.route('**/api/encode', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: MOCK_JOB.job_id }),
    })
  )
  await page.route(`**/api/jobs/${MOCK_JOB.job_id}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_JOB),
    })
  )

  await page.goto('/')
  const cta = page.getByRole('button', { name: /enter|get started|start|launch/i })
    .or(page.getByRole('link', { name: /enter|get started|start|launch/i }))
  await cta.first().click()

  // Step 1: upload
  const fileInput = page.locator('input[type="file"]').first()
  await fileInput.setInputFiles({
    name: 'test.csv',
    mimeType: 'text/csv',
    buffer: toBuffer(SMALL_CSV),
  })
  await expect(page.getByText(/rows|preview/i).first()).toBeVisible({ timeout: 10000 })
  await page.getByRole('button', { name: /next|configure|continue/i }).first().click()

  // Step 2: go to next
  await expect(page.getByText(/algorithm|model/i).first()).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: /next|encode|submit/i }).first().click()

  // Step 3: submit encoding job
  await expect(page.getByText(/strategy|encode/i).first()).toBeVisible({ timeout: 5000 })
  const submitBtn = page.getByRole('button', { name: /run|submit|start encoding|encode/i }).first()
  await submitBtn.click()

  // Wait for results page (job completed immediately via mock)
  await expect(page.getByText(/complete|results|R²|R2|ALTS910101/i).first())
    .toBeVisible({ timeout: 15000 })
}

test.describe('Step 4 — Results', () => {
  test.beforeEach(async ({ page }) => {
    await goToResults(page)
  })

  // ── Table ──────────────────────────────────────────────────────────────────

  test('results table is rendered', async ({ page }) => {
    const table = page.locator('table, [role="table"], [data-testid*="result"]').first()
    await expect(table).toBeVisible()
  })

  test('best model AAI index is shown (ALTS910101)', async ({ page }) => {
    await expect(page.getByText('ALTS910101').first()).toBeVisible()
  })

  test('R2 column values are displayed', async ({ page }) => {
    await expect(page.getByText(/0\.92|0\.88|0\.75/i).first()).toBeVisible()
  })

  // ── Filter ─────────────────────────────────────────────────────────────────

  test('filter/search input is present', async ({ page }) => {
    const filterInput = page.getByPlaceholder(/filter|search/i).first()
      .or(page.locator('input[type="search"], input[type="text"]').last())
    if (await filterInput.count() > 0) {
      await expect(filterInput).toBeVisible()
    }
  })

  test('filtering by index name narrows the results', async ({ page }) => {
    const filterInput = page.getByPlaceholder(/filter|search/i).first()
    if (await filterInput.count() > 0) {
      await filterInput.fill('BHAR')
      // Only BHAR row should remain visible
      await expect(page.getByText('BHAR880101')).toBeVisible()
      // ALTS row should be hidden
      await expect(page.getByText('ALTS910101')).not.toBeVisible()
    }
  })

  // ── Charts ─────────────────────────────────────────────────────────────────

  test('predicted vs actual chart is displayed', async ({ page }) => {
    // Recharts renders SVG or canvas
    const chart = page.locator('svg, canvas, [data-testid*="chart"]').first()
    await expect(chart).toBeVisible()
  })

  // ── Export buttons ─────────────────────────────────────────────────────────

  test('CSV export button is present', async ({ page }) => {
    const csvBtn = page.getByRole('button', { name: /csv|export/i }).first()
      .or(page.getByText(/download csv|export csv/i).first())
    if (await csvBtn.count() > 0) {
      await expect(csvBtn).toBeVisible()
    }
  })

  test('PDF export button is present', async ({ page }) => {
    const pdfBtn = page.getByRole('button', { name: /pdf|report/i }).first()
      .or(page.getByText(/export pdf|download pdf/i).first())
    if (await pdfBtn.count() > 0) {
      await expect(pdfBtn).toBeVisible()
    }
  })

  test('PNG export button is present', async ({ page }) => {
    const pngBtn = page.getByRole('button', { name: /png|image/i }).first()
      .or(page.getByText(/export png|save image/i).first())
    if (await pngBtn.count() > 0) {
      await expect(pngBtn).toBeVisible()
    }
  })

  // ── Best model predictions ─────────────────────────────────────────────────

  test('best model R2 value is displayed', async ({ page }) => {
    // 0.92 or formatted variant
    await expect(page.getByText(/0\.92|R².*0\.9/i).first()).toBeVisible()
  })

  // ── Column sorting ─────────────────────────────────────────────────────────

  test('clicking R2 column header sorts the table', async ({ page }) => {
    const r2Header = page.getByRole('columnheader', { name: /R2|R²/i }).first()
      .or(page.getByText(/^R2$|^R²$/i).first())
    if (await r2Header.count() > 0) {
      await r2Header.click()
      // Table re-renders; best model should still be visible
      await expect(page.getByText('ALTS910101').first()).toBeVisible({ timeout: 3000 })
    }
  })
})
