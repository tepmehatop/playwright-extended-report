import { test, expect, type Page } from '@playwright/test';

// A fake app served through page.route(): no real server needed.
// DEMO_RUN (set by `npm run demo`) changes behaviour between runs to show history features:
// flaky across runs, a brand new failure in the latest run, a duration regression.
const demoRun = Number(process.env.DEMO_RUN || 0);

async function openApp(page: Page, options: { cartStatus?: number, profileBroken?: boolean } = {}) {
  await page.route('http://demo.local/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/cart') {
      const status = options.cartStatus ?? 200;
      await route.fulfill({ status, contentType: 'application/json', body: status === 200 ? '{"items":["Book"]}' : '{"error":"Internal Server Error"}' });
      return;
    }
    await route.fulfill({
      contentType: 'text/html',
      body: `
        <h1>Demo app</h1>
        <ul id="items"></ul>
        <div id="profile"></div>
        <script>
          fetch('/api/cart').then(async r => {
            if (!r.ok) { console.error('Failed to load cart: HTTP ' + r.status); return; }
            const { items } = await r.json();
            document.getElementById('items').innerHTML = items.map(i => '<li>' + i + '</li>').join('');
          });
          ${options.profileBroken ? 'const user = undefined; document.getElementById("profile").textContent = user.name;' : 'document.getElementById("profile").textContent = "Demo user";'}
        </script>`,
    });
  });
  await page.goto('http://demo.local/');
}

test.describe('app', () => {
  test('cart items are loaded from api', async ({ page }) => {
    // Backend answers 500 -> classified as an environment / backend problem.
    await openApp(page, { cartStatus: 500 });
    await expect(page.getByRole('listitem').filter({ hasText: 'Book' })).toBeVisible({ timeout: 1000 });
  });

  test('profile shows user name', async ({ page }) => {
    // Uncaught TypeError in the app -> classified as a product bug.
    await openApp(page, { profileBroken: true });
    await expect(page.locator('#profile')).toHaveText('Demo user', { timeout: 1000 });
  });

  test('recommendations widget', async ({ page }) => {
    await openApp(page);
    // Fails on every odd demo run: unstable across runs, not within one run.
    expect(demoRun % 2, 'recommendations did not render').toBe(0);
  });

  test('new checkout banner', async ({ page }) => {
    await openApp(page);
    // Starts failing from demo run 5: a *new* failure.
    await expect(page.getByText(demoRun >= 5 ? 'Free shipping' : 'Demo app')).toBeVisible({ timeout: 1000 });
  });

  test('promo banner', async ({ page }) => {
    await openApp(page);
    // Broken only in demo run 4 -> shows up as "fixed since previous run" in run 5.
    expect(demoRun === 4 ? 'missing' : 'shown', 'promo banner state').toBe('shown');
  });

  test('search is fast', async ({ page }) => {
    await openApp(page);
    // Becomes slow from demo run 4: duration regression.
    await page.waitForTimeout(demoRun >= 4 ? 1500 : 150);
  });
});
