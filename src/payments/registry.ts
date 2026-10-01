import { createZcashAdapter, ZCASH_ADAPTER_ID } from './adapters/zcash.js'
import { disabledAdapter } from './disabled.js'
import type { PaymentAdapter } from './types.js'

// Register new adapters here, one factory per id.
const ADAPTERS: Record<string, () => PaymentAdapter> = {
  [disabledAdapter.id]: () => disabledAdapter,
  [ZCASH_ADAPTER_ID]: createZcashAdapter,
}

export function getAdapter(id: string | undefined): PaymentAdapter {
  const factory = id && Object.hasOwn(ADAPTERS, id) ? ADAPTERS[id] : undefined
  return factory ? factory() : disabledAdapter
}

export function adapterIds(): string[] {
  return Object.keys(ADAPTERS)
}
