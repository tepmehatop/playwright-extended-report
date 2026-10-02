import { test, expect } from '@playwright/test';

test('login form is visible', async ({ page }) => {
  await page.setContent(`<form><input name="user"><input name="password" type="password"><button>Sign in</button></form>`);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('user can log in', async ({ page }) => {
  await test.step('open login page', async () => {
    await page.setContent(`<form><input name="user"><button>Sign in</button></form>`);
  });
  await test.step('submit credentials', async () => {
    await page.locator('input[name=user]').fill('demo');
    await page.getByRole('button', { name: 'Sign in' }).click();
  });
  await test.step('check greeting', async () => {
    await expect(page.getByText('Welcome, demo')).toBeVisible({ timeout: 1000 });
  });
});
