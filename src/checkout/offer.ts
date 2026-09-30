// The offer an order is created against. Server-owned: the browser names nothing but the order.
// This is a DRAFT awaiting Angus's approval (49TH-20 / offer-and-setup.md, 30 September 2026). It is
// only served by the local fixture runtime and must not be published as accepted terms.

export interface Offer {
  id: string
  // Stored on every order, so a later change of terms never rewrites what an earlier buyer saw.
  version: string
  approved: boolean
  title: string
  // Integer minor units. The provider takes a float `amount`; we derive it at the call site only.
  fiatAmountCents: number
  fiatCurrency: 'USD'
  priceLabel: string
  // Sent to CipherPay as `product_name`. Public metadata on the provider's invoice page.
  providerProductName: string
  summary: string
  refundTerms: string
}

export const DRAFT_OFFER: Offer = Object.freeze({
  id: 'founding-agent-pass',
  version: '2026-09-30-draft-1',
  approved: false,
  title: 'Founding Agent Pass (preorder)',
  fiatAmountCents: 900,
  fiatCurrency: 'USD',
  priceLabel: 'US$9 once',
  providerProductName: 'Founding Agent Pass preorder',
  summary:
    'Founding Agent Pass: US$9 preorder. Get first access when our paid privacy relay launches and US$9 in relay usage credit. ' +
    'The relay is not available yet, and we have not promised a launch date. The free browser redactor is available now. ' +
    'This purchase does not provide anonymous browsing, a working relay or an x402-to-Zcash swap. No subscription. ' +
    'Your wallet shows the ZEC amount and network fee before you approve payment.',
  refundTerms:
    'You can cancel before using your relay credit. Keep your private order recovery code: it lets you manage this order and request a refund. ' +
    'We refund the ZEC amount we received for the order to a shielded receiving address you provide through your authenticated order page. ' +
    'Its dollar value may have changed since purchase. Your original network fee is not refundable; we cover the outgoing refund network fee. ' +
    'Refunds are handled manually within seven calendar days after we verify the request. ' +
    'A transaction ID or public invoice number alone cannot authorize a refund. This policy does not limit mandatory consumer rights.',
})

// Amount sent to the provider's `amount` field. 900 cents -> 9. Exact for every whole-cent value.
export function providerAmount(offer: Offer): number {
  if (!Number.isSafeInteger(offer.fiatAmountCents) || offer.fiatAmountCents <= 0) throw new RangeError('offer amount must be positive integer cents')
  return offer.fiatAmountCents / 100
}
