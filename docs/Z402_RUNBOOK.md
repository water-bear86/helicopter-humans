# Private agent purchases: local verification runbook

## Scope

This slice adds an experimental cooperative merchant and payer to the existing
privacy tools. It settles native shielded ZEC, discloses one selected output, binds
spend authority and the output memo to a signed purchase, and retains a merchant
acknowledgment of the returned bytes. It does not turn an arbitrary x402 merchant
into a shielded merchant. The scheme is `z402-shielded-v1`; interoperable registration
and a cryptographic audit remain outstanding. No hosted payment verifier, merchant
account, API key, token, or full viewing key is sent to a facilitator.

## Dependency and version pins

These are security conditions, not preferences. Upgrading any of them is a
deliberate change that requires rerunning the live evidence.

The native companion pins [Zally](https://github.com/gustavovalverde/zally) at
`4eaa0bbaf562d7cfb0629618b30db50200dedfef` and its Zinder SDK at
`71f49e5ebb260287647c6894d5a718c28d82d4c1`. These are experimental upstreams.
The Ironwood disclosure is a Zally profile, not finalized ZIP 311. Node control-flow
tests use an explicitly fake native bridge; they do not demonstrate settlement.
The separately gated live test requires an actual wallet, local node, mined payment,
and native verification.

| Pin | Current | Rule |
| --- | --- | --- |
| `orchard` | 0.15.4 in `Cargo.lock` | A July 2026 advisory documents an under-constrained Orchard gadget permitting invalid spends and counterfeiting; the fix requires `halo2_gadgets >= 0.5.0` and `orchard >= 0.14.0`. Never resolve below the fixed version. Re-verify the checksum and non-yanked status on each bump. |
| Bundle version | `ironwood_v3()` | Use the current pool for any local slice. |
| Circuit version | `PostNu6_3` | Required for the post-NU6.3 restrictions. **Refuse `InsecurePreNu6_2` explicitly** — it is a historical circuit API still exposed by the crate and must never be selected by a config default. |
| Zally / Zinder | git rev, see above | The crate does not choose activation heights or consensus branches for the application. Do not change the activation schedule without updating the companion and rerunning native evidence. |

`orchard` is `MIT OR Apache-2.0`. Choose a license for this repository and preserve
the required notices for the Rust dependency tree; the transitive license inventory
is still outstanding. Note that Zellic's July 2026 Ironwood assessment covered source
commit `30c4ea27`, which is **not** the commit resolved in this lockfile — treat it
as review evidence for the construction, not as certification of this build.

Mainnet is rejected. Testnet is accepted as a configuration value but has not passed
the live acceptance gate; it requires compatible network activation and funded
Ironwood notes. Regtest enables all upgrades through NU6.3 at height 2. Do not change
the activation schedule without updating the companion and rerunning native evidence.

## Privacy boundary

The merchant receives an ephemeral buyer key, a shielded transaction ID, one selected
recipient/amount/memo disclosure, and proof that the spender authorized the offer.
It does not receive the funding address, full viewing key, seed, or other output
disclosures. The merchant knows what was bought and what it charged. A disclosure
is intentionally shareable evidence of that purchase; keep it private when sharing
would expose the purchase.

Remote HTTP requests use Tor with remote DNS, per-purchase SOCKS credentials,
normalized headers, bounded responses, rejected redirects, and no direct fallback.
Configure Tor's SOCKS listener with `IsolateSOCKSAuth`. The package cannot inspect or
guarantee a proxy's implementation. Local regtest HTTP uses explicit loopback transport
and makes no network anonymity claim. Run the local Zinder and Zebra inside the same
trusted operator boundary; a remote indexer can observe wallet synchronization.

Timing, amounts, content, cookies supplied outside this transport, local operators,
compromised agents/hosts, global traffic analysis, and chain statistical analysis
are outside this initial claim. SQLite record contents are encrypted in the Node
journal, but identifiers and accounting rows remain local metadata. The native seed
is Age-encrypted; native PCZT and wallet metadata are protected by a private directory
and file permissions, not by full database encryption. Back up and protect the whole
private directory, including the Age identity sidecar. Encryption does not protect
against an administrator who can read the decryption key.

## Native companion

```sh
npm ci
cargo build --locked --manifest-path tools/z402-wallet/Cargo.toml
```

The native config is an operator-owned JSON file with absolute paths:

```json
{
  "network": "zcash:regtest",
  "walletDir": "/absolute/private/wallet",
  "zinder": "http://127.0.0.1:29102",
  "zebra": "http://127.0.0.1:29232",
  "paramsDir": "/absolute/private/params/ZcashParams",
  "maxAmountZat": "100000",
  "feeCapZat": "100000",
  "budgetZat": "1000000",
  "merchants": {}
}
```

Populate `merchants` with the exact origin and authenticated Ed25519 SPKI public key
of each permitted merchant. Merchant allowlisting, price/fee limits, and the cumulative
budget are checked again in Rust. The native signer accepts only the exact PCZT that
it proposed and persisted for that signed offer. It serializes wallet operations with
a process lock and preserves signed bytes before returning them to Node. The operator
must restrict the agent's access to this directory, config, seed, signing process,
and keys; running arbitrary agent code as the wallet owner bypasses this boundary.

Commands accept JSON on stdin; secret material is never passed through shell arguments.
`init` emits a receive address and stores a sealed seed, without printing a mnemonic.
`propose`, `sign`, `submit`, and `disclose` are separate durable steps. `verify` never
opens a payer wallet. `preflight`, `sync`, and `address` are operator diagnostics.
Native errors are deliberately generic to avoid emitting payment material into logs.

On macOS, `paramsDir` must end in `ZcashParams`. `params` downloads the Sapling parameter
files through the official library and validates their sizes and hashes. Zally also
requires those verification parameters for extracting Ironwood transactions. On Linux,
install verified parameters in the platform default `$HOME/.zcash-params` and set
`paramsDir` to that same path. The automated local bootstrap currently targets macOS.

## Local chain and live acceptance

Use `npm run z402:regtest` to bootstrap the isolated Docker chain and native wallet.
Then run:

```sh
Z402_REGTEST=1 npm run test:z402:live -- .z402-local/agent-native.json
```

All generated identities, wallets, proving parameters, encrypted journals, resources,
and receipts live under gitignored `.z402-local/`. The live test serves a cooperative
merchant on loopback, pays it from shielded Ironwood notes, mines the pending payment,
decrypts its response, shuts down the merchant, restarts the client, and independently
verifies the portable receipt without a payer seed. It rejects a tampered disclosure.
It also rejects altered unsigned and signed PCZTs at the native boundary. Repeated
runs mine three setup blocks to make trusted change spendable before a new purchase.
The evidence file labels the environment `local-regtest-only`. Regtest coins have no
economic value. The live test's bootstrap deposit is transparent and then shielded;
the actual purchase refuses all transparent inputs and outputs.

Docker services publish only loopback ports. Bootstrap copies configuration into a
named volume instead of binding Documents into Docker. It never deletes wallets or
volumes. Bulk mining is performed while indexers are stopped, followed by canonical
catch-up; avoid advancing more than the indexer's retained event window while wallet
projection is running. Monitor all three readiness endpoints before issuing payments.

## Recovery and receipts

Persist the purchase ID before the first request. After a timeout or restart, retry
the same ID, URL, keys, journal, and signed transaction. Never create a new purchase
just because delivery or broadcast timed out. Native retry uses the same ZIP-244
transaction effects, and duplicate broadcast cannot pay again.

Budget is charged only after verification and decryption; pending reservations count
against the limit. Abandoned, expired, rejected, and unknown transactions fail closed
and can hold capacity. Recovery needs an operator to establish chain state and release
input locks safely. Automated expiry cancellation and refunds are not implemented.
A crash before an unsigned proposal reaches the native purchase journal can leave
wallet input locks requiring operator recovery; it cannot authorize another payment.

Merchant fulfillment is a bounded, idempotent GET. Delivery callback retries must use
the supplied purchase ID. Signed receipts attest to the exact returned byte digest;
they do not prove the answer is correct, useful, or complete. Confirmations are checked
fresh against the local consensus node. A later reorg can invalidate current settlement;
the receipt retains historical acknowledgment, not immutable chain finality.

To verify a portable receipt against your own local node, save the independently
authenticated merchant SPKI public key as plain base64 in `merchant-key.txt`, then run:

```sh
node examples/z402/verify-receipt.mjs \
  tools/z402-wallet/target/debug/z402-wallet \
  /absolute/private/verifier-native.json \
  /absolute/private/receipt.json /absolute/private/merchant-key.txt
```

The verifier config can point `walletDir` at an unused directory; verification never
opens it. The command prints only the verification status. It exits with code 2 for
insufficient confirmations and code 1 when verification is refused. Authenticate the
merchant key independently rather than trusting the key inside a received receipt.

Do not delete quote/claim records while matching transactions or receipts remain usable.
Restoring an older ledger snapshot can undermine replay protection and spending budgets.
Keep consistent backups and do not clone a funded wallet into independent live signers.

## Checks

```sh
npm run check
cargo fmt --manifest-path tools/z402-wallet/Cargo.toml --check
cargo clippy --locked --manifest-path tools/z402-wallet/Cargo.toml -- -D warnings
cargo test --locked --manifest-path tools/z402-wallet/Cargo.toml
```

The new package is private and unpublished. The Rust lockfile and Docker image digests
pin the tested dependency graph; upgrade them deliberately and repeat live verification.
The existing hosted CipherPay adapter and checkout stay gated independently.
