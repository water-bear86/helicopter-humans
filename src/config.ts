// Build-time public config. Variable names are documented in README.md and .env.example.
// There is deliberately no checkout URL: a public build variable must never be able to open payment.
function clean(value: string | undefined): string {
  return (value ?? '').trim()
}

export const config = {
  priceLabel: clean(import.meta.env.VITE_PRICE_LABEL),
}
