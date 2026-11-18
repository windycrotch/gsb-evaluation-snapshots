/**
 * E2E tests for the param search (Compare settings) modal.
 * Covers: button visibility, modal open/close, config phase UI.
 * The modal state test mocks the API; full-size search is verified separately
 * with a local photo against the running service.
 */
import { test, expect } from '@playwright/test';
import { uploadAndProcess } from './helpers';

test.describe('Param Search Modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('Compare settings button is hidden before image upload', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Compare settings/ })).not.toBeVisible();
  });

  test('Compare settings button appears after processing an image', async ({ page }) => {
    await uploadAndProcess(page);
    await expect(page.getByRole('button', { name: /Compare settings/ })).toBeVisible();
  });

  test('clicking Compare settings opens the modal with config phase', async ({ page }) => {
    await uploadAndProcess(page);

    await page.getByRole('button', { name: /Compare settings/ }).click();

    // Modal should be visible
    await expect(page.getByRole('dialog', { name: /Compare settings/ })).toBeVisible();

    // Config phase elements
    await expect(page.getByLabel(/Target longest edge/)).toBeVisible();
    // No filament selector inside the search dialog (it reuses the
    // converter's current configuration).
    expect(await page.getByLabel(/Filament preset/).count()).toBe(0);
    await expect(page.getByRole('button', { name: /Generate options/ })).toBeVisible();
  });

  test('modal closes when clicking the ✕ button', async ({ page }) => {
    await uploadAndProcess(page);
    await page.getByRole('button', { name: /Compare settings/ }).click();

    await expect(page.getByRole('dialog')).toBeVisible();

    // Click the header close button (aria-label="Close")
    await page.getByRole('button', { name: 'Close' }).first().click();

    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('modal closes on Escape key', async ({ page }) => {
    await uploadAndProcess(page);
    await page.getByRole('button', { name: /Compare settings/ }).click();

    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('search reuses the converter’s current filament configuration', async ({ page }) => {
    // The modal carries no preset selector (removed by design): the search
    // runs against whatever the main UI has selected. With Clear CMYW
    // active, starting a search must not reset the converter configuration.
    await uploadAndProcess(page);
    await page.locator('select').nth(1).selectOption('clear_cmyw');
    await page.waitForTimeout(600);

    await page.getByRole('button', { name: /Compare settings/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await page.getByLabel(/Filament preset/).count()).toBe(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();

    // The converter still runs the Clear CMYW preset.
    const selected = await page.locator('select').nth(1).inputValue();
    expect(selected).toBe('clear_cmyw');
  });

  test('target size input accepts numeric input', async ({ page }) => {
    await uploadAndProcess(page);
    await page.getByRole('button', { name: /Compare settings/ }).click();

    const sizeInput = page.getByLabel(/Target longest edge/);
    await sizeInput.fill('150');
    await expect(sizeInput).toHaveValue('150');
  });

  test('an invalid filament TD blocks the search with feedback until repaired', async ({ page }) => {
    const searchRequests: string[] = [];
    const preview = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    // Serve a minimal job so a repaired search completes without the real backend.
    await page.route('**/api/param-search', async route => {
      searchRequests.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ job_id: 'recovered-job', completed: 0, total: 1, status: 'running', results: [] }),
      });
    });
    await page.route('**/api/param-search/progress/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          job_id: 'recovered-job', completed: 1, total: 1, status: 'done', error: null,
          results: [
            { candidate_id: 1, is_baseline: true, mode: 'pixel',
              params: { max_colors: 10, color_threshold: 40 }, preview_image: preview, score: 9.9 },
          ],
        }),
      });
    });

    await uploadAndProcess(page);
    await expect(page.getByRole('button', { name: /Compare settings/ })).toBeVisible();

    // A fresh custom color starts at TD=0: field feedback shows, the entry
    // disappears, and no search request may leave the browser.
    await page.getByRole('button', { name: /Add Color/i }).click();
    const tdInput = page.getByRole('spinbutton', { name: /transmission distance/ }).last();
    await expect(tdInput).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText(/positive TD/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Compare settings/ })).not.toBeVisible();
    expect(searchRequests).toHaveLength(0);

    // Repair the TD: feedback clears, the entry returns, and a started search
    // fires exactly one POST /api/param-search.
    await tdInput.fill('3');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: /Compare settings/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: /Generate options/ }).click();
    await expect(page.getByText('1 / 1')).toBeVisible({ timeout: 15_000 });
    expect(searchRequests).toHaveLength(1);
  });

  test('clicking Generate options transitions to running phase', async ({ page }) => {
    // Starting a search returns a job immediately; previews arrive in polls.
    await page.route('**/api/param-search', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          job_id: 'test-job-123',
          completed: 0,
          total: 21,
          status: 'running',
          results: [
          ],
        }),
      });
    });

    // Completed full-resolution previews become visible, closest match first,
    // while the remaining evaluations are still running.
    const preview = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await page.route('**/api/param-search/progress/**', async (route) => {
      const after = Number(new URL(route.request().url()).searchParams.get('after'));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          job_id: 'test-job-123', completed: 2, total: 21, status: 'running', error: null,
          results: [
            { candidate_id: 1, is_baseline: true, mode: 'pixel', params: { max_colors: 10, color_threshold: 40 },
              preview_image: preview, score: 10.68 },
            { candidate_id: 2, is_baseline: false, mode: 'pixel', params: { max_colors: 64, color_threshold: 10 },
              preview_image: preview, score: 8.85 },
          ].filter((result) => result.candidate_id > after),
        }),
      });
    });

    await uploadAndProcess(page);
    await page.getByRole('button', { name: /Compare settings/ }).click();
    await page.getByRole('button', { name: /Generate options/ }).click();

    await expect(page.getByAltText('Current settings')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('2 / 21')).toBeVisible();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('img')).toHaveCount(2);
    await expect(dialog.getByRole('img').first()).toHaveAttribute('alt', 'Option 2');
    await expect(dialog.getByText('Best so far')).toBeVisible();
    await expect(dialog.getByText('1.83 closer than current')).toBeVisible();
  });
});
