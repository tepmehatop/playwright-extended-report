import { test, expect } from '@playwright/test';

// Deliberately broken tests that share root causes, to demo failure clustering.

const shopPage = `
  <h1>Shop</h1>
  <button id="buy">Buy</button>
  <div class="cart">Cart: 0</div>
`;

test.describe('cart', () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(shopPage);
  });

  test('shows the page title', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Shop' })).toBeVisible();
  });

  test('adds item to cart', async ({ page }) => {
    await page.getByRole('button', { name: 'Buy' }).click();
    // Same broken locator in three tests -> one cluster.
    await expect(page.getByTestId('cart-counter')).toHaveText('Cart: 1', { timeout: 1000 });
  });

  test('removes item from cart', async ({ page }) => {
    await expect(page.getByTestId('cart-counter')).toHaveText('Cart: 0', { timeout: 1000 });
  });

  test('cart survives reload', async ({ page }) => {
    await page.reload();
    await expect(page.getByTestId('cart-counter')).toHaveText('Cart: 0', { timeout: 1000 });
  });

  test('applies discount @slow', async ({ page }) => {
    test.skip(true, 'Discounts are not implemented yet');
  });
});

test.describe('checkout', () => {
  test('total is calculated', async () => {
    expect(2 + 2, 'total price').toBe(5);
  });

  test('flaky payment widget', async ({ page }, testInfo) => {
    await page.setContent('<div id="payment">ready</div>');
    // Fails on the first attempt, passes on retry -> "flaky".
    expect(testInfo.retry, 'payment widget did not load').toBeGreaterThan(0);
    await expect(page.locator('#payment')).toHaveText('ready');
  });
});
