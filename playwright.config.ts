import { defineConfig, devices } from '@playwright/test'

const CHECKOUT = /checkout\.spec\.ts/

export default defineConfig({
  testDir: 'e2e',
  webServer: [
    {
      // The production build. VITE_CHECKOUT_URL is set to prove a build variable cannot open checkout.
      command: 'npm run build && npm run preview -- --port 4173 --strictPort',
      url: 'http://localhost:4173',
      reuseExistingServer: false,
      env: { VITE_CHECKOUT_URL: 'https://pay.example.com/should-never-open', VITE_PRICE_LABEL: '' },
    },
    {
      // Local fixture runtime: real route handlers with a simulated provider and in-memory store.
      command: 'npx vite --port 4175 --strictPort',
      url: 'http://localhost:4175/checkout.html',
      reuseExistingServer: false,
      env: { CHECKOUT_MODE: 'fixture' },
    },
  ],
  projects: [
    { name: 'desktop', testIgnore: CHECKOUT, use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4173' } },
    { name: 'mobile', testIgnore: CHECKOUT, use: { ...devices['Pixel 7'], baseURL: 'http://localhost:4173' } },
    { name: 'checkout-desktop', testMatch: CHECKOUT, use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4175' } },
    { name: 'checkout-mobile', testMatch: CHECKOUT, use: { ...devices['Pixel 7'], baseURL: 'http://localhost:4175' } },
  ],
})
