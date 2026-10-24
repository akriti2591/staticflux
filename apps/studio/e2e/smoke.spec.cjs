// Smoke: boot reaches running, a router navigation renders a feature, the assistant opens.
const { test, expect } = require('playwright/test');

test('boot → navigate → open chat', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-sf-boot', /running|degraded/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Welcome to Studio' })).toBeVisible();

  // Client-side navigation through the router (wizard steps are view sub-routes).
  await page.getByRole('link', { name: 'Start the tour' }).first().click();
  await expect(page).toHaveURL(/\/onboarding\/step\/1$/);
  await expect(page.locator('onboarding-wizard h1')).toBeVisible();

  // The assistant panel mounts the agent-chat feature (lazy chunk).
  await page.getByTestId('open-chat').click();
  await expect(page.getByTestId('chat-draft')).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});
