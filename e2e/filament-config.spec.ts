import { test, expect } from '@playwright/test';

test.describe('Filament Configuration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // The converter stays inert until the material catalog has loaded.
    await expect(page.locator('input[type="color"]').first()).toBeVisible();
  });

  test('filament config panel is visible in settings', async ({ page }) => {
    await expect(page.getByRole('combobox', { name: 'Filament Preset' })).toBeVisible();
  });

  test('default preset lists at least four filament colors', async ({ page }) => {
    expect(await page.locator('input[type="color"]').count()).toBeGreaterThanOrEqual(4);
  });

  test('can add a filament color', async ({ page }) => {
    const colorInputs = page.locator('input[type="color"]');
    const initialCount = await colorInputs.count();

    await page.getByRole('button', { name: /Add Color/i }).click();

    await expect(colorInputs).toHaveCount(initialCount + 1);
  });

  test('a fresh custom color starts invalid and the row flags it until the TD is fixed', async ({ page }) => {
    await page.getByRole('button', { name: /Add Color/i }).click();

    // TD=0 is rejected by the API; the row surfaces that before any request —
    // visibly: the border switches to the error color while aria-invalid holds.
    const tdInput = page.getByRole('spinbutton', { name: /transmission distance/ }).last();
    const borderColor = () => tdInput.evaluate(el => getComputedStyle(el).borderColor);
    await expect(tdInput).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText(/positive TD/i)).toBeVisible();

    // Learn the valid border color, then break it again: the states must be
    // visually distinct and reversible.
    await tdInput.fill('3');
    await expect(tdInput).toHaveAttribute('aria-invalid', 'false');
    const validBorder = await borderColor();
    await tdInput.fill('0');
    await expect(tdInput).toHaveAttribute('aria-invalid', 'true');
    expect(await borderColor()).not.toBe(validBorder);
    await tdInput.fill('3');
    await expect(tdInput).toHaveAttribute('aria-invalid', 'false');
    expect(await borderColor()).toBe(validBorder);
  });

  test('can load a preset', async ({ page }) => {
    const presetSelect = page.getByRole('combobox', { name: 'Filament Preset' });
    await presetSelect.selectOption('bambu_cmyw');

    await expect(presetSelect).toHaveValue('bambu_cmyw');
    await expect(page.locator('input[type="color"]')).toHaveCount(4);
  });

  test('filament gamut preview section exists', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Achievable Filament Gamut' })).toBeVisible();
  });

  test('palette library section exists', async ({ page }) => {
    await expect(page.getByText(/Palette Library/i)).toBeVisible();
  });
});
