# z402 private agent purchases

An experimental, self-hosted GET purchase protocol: signed offers, bounded native
Zcash signing, purchase-bound payment disclosures, encrypted delivery, and portable
merchant acknowledgments. The current native bridge uses Zally's Ironwood disclosure
profile, pinned to a source revision. This is a proposed `z402-shielded-v1` payment
scheme carried in x402 v2-shaped headers, not a registered x402 payment scheme or an
audited privacy protocol. Existing payment-adapter production gates stay closed.

See [the runbook](../../docs/Z402_RUNBOOK.md) for setup, the threat model, recovery,
and verification. Node 24 or later is required. The native companion is a separate
Rust executable under `tools/z402-wallet`.

```js
import {
  AgentClient, NativeWallet, PrivateStore, torTransport,
} from '@helicopter-humans/z402'

const client = new AgentClient({
  store: new PrivateStore(databasePath, storageKey, { budgetZat: '1000000' }),
  native: new NativeWallet({ binary: absoluteBinaryPath, configFile: nativeConfigPath }),
  transport: torTransport({ proxy: 'socks5h://127.0.0.1:9050' }),
  merchants: { 'https://merchant.example': pinnedMerchantPublicKey },
  maxAmountZat: '100000',
  feeCapZat: '100000',
})
const purchaseId = client.newPurchaseId() // persist before starting the purchase
const result = await client.purchase(resourceUrl, { purchaseId })
// A pending result must be retried with the same ID, URL, and local journal.
```

The merchant pins its quote to the buyer's purchase-specific Ed25519 key and
X25519 response key. The buyer signs its payment envelope; the native disclosure
and decrypted output memo bind the exact offer hash. The merchant durably claims
the selected transaction output once. A receipt combines the offer, native
disclosure, and signed resource/ciphertext digests. `verifyReceipt` uses a separate
native verifier against the operator's local consensus node; no payer seed or
merchant service is needed.

`PrivateStore` encrypts payloads with AES-GCM and serializes local reservations
with SQLite. It is intended for a single wallet runtime on one machine, with
multiple local processes coordinated through the same files. Budgets are cumulative
and persist across restarts. Failed or uncertain payments retain reservations;
there is no automatic refund or unsafe release of signed payments.

Merchants must serve bounded, idempotent GET resources and preserve their signing
key, storage key, quote records, output claims, and encrypted responses. An arbitrary
side effect in the resource callback cannot be made transactional by this package.

## Donate

If you found this to be useful, consider donating by sending magic internet monies to:

```text
sol: 79TNuyFNZWhDeFF1RUNA5Xk9Pccvb7xPYqLukBxCeWbb
evm: 0xa2c0abd1a1fcb5aee12f80651ae7f646371a66ed
```
