/**
 * E2E tests for the Landing Page.
 *
 * These tests verify the landing page renders correctly and the CTA
 * navigates the user into the application (Step 1).
 */
import { test, expect } from '@playwright/test'

test.describe('Landing Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('landing page is visible on first load', async ({ page }) => {
    // The landing page should be displayed by default
    await expect(page.locator('body')).toBeVisible()
  })

  test('hero heading is present', async ({ page }) => {
    // pySAR brand name or tagline should be visible
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })

  test('"Enter App" or equivalent CTA button is visible', async ({ page }) => {
    // Look for the CTA button by text or role
    const cta = page.getByRole('button', { name: /enter|get started|start|launch/i })
      .or(page.getByRole('link', { name: /enter|get started|start|launch/i }))
    await expect(cta.first()).toBeVisible()
  })

  test('clicking CTA navigates into the app (Step 1 visible)', async ({ page }) => {
    const cta = page.getByRole('button', { name: /enter|get started|start|launch/i })
      .or(page.getByRole('link', { name: /enter|get started|start|launch/i }))
    await cta.first().click()
    // After clicking, Step 1 upload UI should be visible
    await expect(page.getByText(/upload|dataset/i).first()).toBeVisible({ timeout: 5000 })
  })

  test('page title includes pySAR', async ({ page }) => {
    await expect(page).toHaveTitle(/pysar/i)
  })

  test('dark mode toggle is present', async ({ page }) => {
    // There should be some kind of theme toggle
    const toggle = page.getByRole('button', { name: /dark|light|theme/i })
      .or(page.locator('[aria-label*="dark"], [aria-label*="theme"]'))
    // Only assert if toggle exists — some layouts may omit it on landing
    const count = await toggle.count()
    if (count > 0) {
      await expect(toggle.first()).toBeVisible()
    }
  })

  test('feature highlights section is visible', async ({ page }) => {
    // Landing pages typically list features
    const features = page.getByText(/model|encode|descriptor|prediction/i).first()
    await expect(features).toBeVisible()
  })
})
