/**
 * E2E tests for Step 3 — Encode.
 *
 * Tests strategy selection, AAI index search, ETA display,
 * and the submission flow (mocked backend via route interception).
 *
 * The backend route `/api/encode` is mocked so pySAR is never invoked.
 */
import { test, expect } from '@playwright/test'
import { SMALL_CSV, toBuffer } from './fixtures/datasets.js'

// ── helpers ────────────────────────────────────────────────────────────────────

async function goToStep3(page) {
  await page.goto('/')
  const cta = page.getByRole('button', { name: /enter|get started|start|launch/i })
    .or(page.getByRole('link', { name: /enter|get started|start|launch/i }))
  await cta.first().click()

  // Step 1: upload a file
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

  // Wait for Step 3 content
  await expect(page.getByText(/strategy|encode/i).first()).toBeVisible({ timeout: 5000 })
}

test.describe('Step 3 — Encode', () => {
  test.beforeEach(async ({ page }) => {
    // Intercept the encode endpoint so pySAR is never invoked
    await page.route('**/api/encode', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ job_id: 'mock-job-id-1234' }),
      })
    )
    // Mock polling endpoint — return a running job that completes after 2 polls
    let pollCount = 0
    await page.route('**/api/jobs/mock-job-id-1234', (route) => {
      pollCount++
      const status = pollCount >= 2 ? 'completed' : 'running'
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          job_id: 'mock-job-id-1234',
          status,
          progress: pollCount >= 2 ? 100 : 30,
          log: ['Dataset loaded: 3 rows', 'Strategy: aai'],
          strategy: 'aai',
          algorithm: 'plsregression',
          created_at: new Date().toISOString(),
          results: pollCount >= 2 ? [{ index: 'ALTS910101', R2: 0.9 }] : null,
          best_model_predictions: pollCount >= 2 ? {
            model_name: 'ALTS910101',
            actual: [55, 60, 65],
            predicted: [54, 61, 64],
          } : null,
        }),
      })
    })
    await goToStep3(page)
  })

  // ── Strategy selection ─────────────────────────────────────────────────────

  test('AAI strategy option is visible', async ({ page }) => {
    const aaiOption = page.getByText(/^AAI$|^AAI encoding|^Amino Acid Index/i).first()
      .or(page.getByRole('radio', { name: /aai/i }))
    await expect(aaiOption).toBeVisible()
  })

  test('Descriptor strategy option is visible', async ({ page }) => {
    const descOption = page.getByText(/descriptor/i).first()
      .or(page.getByRole('radio', { name: /descriptor/i }))
    await expect(descOption).toBeVisible()
  })

  test('selecting descriptor strategy updates the UI', async ({ page }) => {
    const descOption = page.getByRole('radio', { name: /descriptor/i })
      .or(page.getByText(/^descriptor$/i))
    if (await descOption.count() > 0) {
      await descOption.first().click()
      // Descriptor-specific UI should appear (e.g. descriptor picker)
      await expect(page.getByText(/select descriptor|descriptor combo/i).first())
        .toBeVisible({ timeout: 3000 })
    }
  })

  // ── AAI search dropdown ────────────────────────────────────────────────────

  test('AAI index search input is visible in AAI mode', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search|filter|AAI/i).first()
      .or(page.locator('input[type="search"]').first())
    if (await searchInput.count() > 0) {
      await expect(searchInput).toBeVisible()
    }
  })

  // ── Model estimate ─────────────────────────────────────────────────────────

  test('estimated model count is displayed', async ({ page }) => {
    // The ETA or estimate count should be shown
    await expect(page.getByText(/model|estimate|566/i).first()).toBeVisible()
  })

  // ── Job submission ─────────────────────────────────────────────────────────

  test('Submit / Run button is visible', async ({ page }) => {
    const submitBtn = page.getByRole('button', { name: /run|submit|start encoding|encode/i }).first()
    await expect(submitBtn).toBeVisible()
  })

  test('clicking Submit triggers job polling and shows progress', async ({ page }) => {
    const submitBtn = page.getByRole('button', { name: /run|submit|start encoding|encode/i }).first()
    await submitBtn.click()
    // Progress or status indicator should appear
    await expect(page.getByText(/running|progress|pending|loading/i).first())
      .toBeVisible({ timeout: 5000 })
  })

  test('job completes and results are shown', async ({ page }) => {
    const submitBtn = page.getByRole('button', { name: /run|submit|start encoding|encode/i }).first()
    await submitBtn.click()
    // Wait for completed status to appear
    await expect(page.getByText(/complete|results|R²|R2/i).first())
      .toBeVisible({ timeout: 15000 })
  })

  // ── Log panel ──────────────────────────────────────────────────────────────

  test('log panel shows log entries after submission', async ({ page }) => {
    const submitBtn = page.getByRole('button', { name: /run|submit|start encoding|encode/i }).first()
    await submitBtn.click()
    await expect(page.getByText(/Dataset loaded|Strategy:/i).first())
      .toBeVisible({ timeout: 10000 })
  })
})
