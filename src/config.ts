// Build-time public config. Variable names are documented in README.md and .env.example.
function clean(value: string | undefined): string {
  return (value ?? '').trim()
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

export const config = {
  checkoutUrl: safeUrl(clean(import.meta.env.VITE_CHECKOUT_URL)),
  priceLabel: clean(import.meta.env.VITE_PRICE_LABEL),
}
