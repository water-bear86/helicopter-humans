import { disabledAdapter } from './disabled.js'
import type { PaymentAdapter } from './types.js'

// Register new adapters here. The payment adapter PR adds one entry and nothing else in this file.
const ADAPTERS: Record<string, PaymentAdapter> = {
  [disabledAdapter.id]: disabledAdapter,
}

export function getAdapter(id: string | undefined): PaymentAdapter {
  return (id && ADAPTERS[id]) || disabledAdapter
}

export function adapterIds(): string[] {
  return Object.keys(ADAPTERS)
}
