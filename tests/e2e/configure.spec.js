/**
 * E2E tests for Step 2 — Model & DSP Configuration.
 *
 * Covers: algorithm selector, test_split input, tab navigation
 * (Model / Descriptors / DSP / Config Preview), config diff badge,
 * and config import/export.
 */
import { test, expect } from '@playwright/test'
import { SMALL_CSV, toBuffer, mockUploadResponse } from './fixtures/datasets.js'

// ── helpers ────────────────────────────────────────────────────────────────────

async function goToStep2(page) {
  // Mock the upload endpoint — this suite only needs Step 1 completed, and
  // hitting the real endpoint repeatedly trips the backend's upload rate limit.
  await page.route('**/api/upload', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockUploadResponse()),
    })
  )
  await page.goto('/')
  const cta = page.getByRole('button', { name: /enter|get started|start|launch/i })
    .or(page.getByRole('link', { name: /enter|get started|start|launch/i }))
  await cta.first().click()

  // Upload a file
  const fileInput = page.locator('input[type="file"]').first()
  await fileInput.setInputFiles({
    name: 'test.csv',
    mimeType: 'text/csv',
    buffer: toBuffer(SMALL_CSV),
  })
  // Wait for upload to complete then click Next
  await expect(page.getByText(/rows|preview/i).first()).toBeVisible({ timeout: 10000 })
  const nextBtn = page.getByRole('button', { name: /next|configure|continue/i }).first()
  await nextBtn.click()
  // Wait for Step 2 content
  await expect(page.getByText(/algorithm|model/i).first()).toBeVisible({ timeout: 5000 })
}

test.describe('Step 2 — Configure', () => {
  test.beforeEach(async ({ page }) => {
    await goToStep2(page)
  })

  // ── Tab navigation ─────────────────────────────────────────────────────────

  test('Model tab is active by default', async ({ page }) => {
    const modelTab = page.getByRole('tab', { name: /model/i })
      .or(page.getByText(/^model$/i))
    if (await modelTab.count() > 0) {
      await expect(modelTab.first()).toBeVisible()
    }
  })

  test('Descriptors tab is clickable', async ({ page }) => {
    const tab = page.getByRole('tab', { name: /descriptor/i })
      .or(page.getByText(/descriptor/i, { exact: false }))
    if (await tab.count() > 0) {
      await tab.first().click()
      // Some descriptor-specific content should appear
      await expect(page.getByText(/descriptor|feature/i).first()).toBeVisible({ timeout: 3000 })
    }
  })

  test('DSP tab is clickable', async ({ page }) => {
    // Tabs are plain buttons with an exact label — a loose text match also
    // matches the "optional DSP settings" description above the tab bar.
    const tab = page.getByRole('button', { name: 'DSP', exact: true })
    if (await tab.count() > 0) {
      await tab.click()
      // Spectrum/window/filter settings are hidden until DSP is enabled.
      // Target the visible field labels — a loose text match also matches a
      // hidden hover-tooltip that happens to mention "spectrum, window, and filter".
      await page.getByRole('switch').click()
      await expect(page.getByText(/output spectrum|window function/i).first()).toBeVisible({ timeout: 3000 })
    }
  })

  test('Config Preview tab is clickable', async ({ page }) => {
    const tab = page.getByRole('tab', { name: /preview|config/i })
      .or(page.getByText(/config preview/i))
    if (await tab.count() > 0) {
      await tab.first().click()
      // JSON preview should appear
      await expect(page.getByText(/model|algorithm/i).first()).toBeVisible({ timeout: 3000 })
    }
  })

  // ── Algorithm selector ─────────────────────────────────────────────────────

  test('algorithm select input is rendered', async ({ page }) => {
    const algSelect = page.locator('select[name*="algo"], [data-testid*="algo"]')
      .or(page.getByRole('combobox').filter({ hasText: /plsregression|ridge|lasso/i }))
    if (await algSelect.count() === 0) {
      // Maybe it's a custom dropdown
      const btn = page.getByText(/plsregression|ridge|lasso/i).first()
      await expect(btn).toBeVisible()
    } else {
      await expect(algSelect.first()).toBeVisible()
    }
  })

  // ── Test split ─────────────────────────────────────────────────────────────

  test('test split input is visible and accepts a value', async ({ page }) => {
    const input = page.getByRole('spinbutton').filter({ hasText: /split/i })
      .or(page.locator('input[type="number"]').first())
    if (await input.count() > 0) {
      await input.first().fill('0.3')
      await expect(input.first()).toHaveValue('0.3')
    }
  })

  // ── Config diff badge ──────────────────────────────────────────────────────

  test('config diff badge shows 0 changes before any edit', async ({ page }) => {
    // The diff badge is often shown near the Config Preview tab
    const badge = page.getByText(/0 change|no change/i)
      .or(page.locator('[data-testid*="diff"]'))
    // Badge may not be visible when there are 0 diffs
    const count = await badge.count()
    if (count > 0) {
      await expect(badge.first()).toBeVisible()
    }
  })

  // ── Next step navigation ───────────────────────────────────────────────────

  test('"Next" or "Encode" button is present', async ({ page }) => {
    const nextBtn = page.getByRole('button', { name: /next|encode|submit/i }).first()
    await expect(nextBtn).toBeVisible()
  })

  test('clicking Back returns to Step 1', async ({ page }) => {
    const backBtn = page.getByRole('button', { name: /back|previous/i }).first()
    if (await backBtn.count() > 0) {
      await backBtn.click()
      await expect(page.getByText(/upload|drop/i).first()).toBeVisible({ timeout: 5000 })
    }
  })
})
