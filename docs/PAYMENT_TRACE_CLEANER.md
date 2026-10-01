# Local payment-trace cleaner

Find possible x402 payment traces in a local LangGraph SQLite checkpoint database, review the affected threads, and remove explicitly selected threads. Python 3.10 or later with its standard `sqlite3` module is the only runtime requirement. No model, network service, wallet, account or administrator privilege is required. Inspect `memory-cleaner.py` before running it.

The script includes its MIT license and schema-contract attribution. The download's SHA-256 manifest checks byte consistency; a checksum fetched from the same server is not independent authentication or a security audit.

This first release supports the dedicated two-table `SqliteSaver` layout verified with `langgraph-checkpoint-sqlite==3.1.1` and `langgraph-checkpoint==4.2.0`. It does not scan Codex/Claude sessions, arbitrary folders, hosted agent databases, wallet files or accounting databases. A schema with extra tables, views, triggers or altered definitions is refused. A matching layout cannot prove which library created a database; choose your application's known checkpoint file.

## Try it with invented data

Download `memory-cleaner.py` and this guide. Run the commands in a new working folder. No existing file is overwritten. The demo makes no payment and plants only invented markers.

```sh
python3 memory-cleaner.py demo --db demo.sqlite
python3 memory-cleaner.py audit --db demo.sqlite --plan demo-audit.json
python3 memory-cleaner.py clean --db demo.sqlite --plan demo-audit.json --thread thread-0001
```

The last command is a preview. It shows three checkpoints and one pending write selected for removal, including an old snapshot and a subgraph namespace. `thread-0002` is ordinary work and should be preserved. To apply to this invented demo:

```sh
python3 memory-cleaner.py clean --db demo.sqlite --plan demo-audit.json --thread thread-0001 --apply --agent-stopped --confirm DELETE-SELECTED-THREADS
python3 memory-cleaner.py audit --db demo.sqlite --plan demo-after.json
```

## Your own supported store

1. Stop the application first and prevent it from starting or writing again during cleanup. The `--agent-stopped` flag is your attestation, not automatic process detection. The SQLite transaction refuses an existing competing writer and checks that the audit has not gone stale, but cannot prevent a restarted application from saving traces later.
2. Locate the dedicated checkpoint database from your application's configuration. Pass that exact local file as `--db`. The tool does not search your home folder or request wallet keys.
3. Run `audit` with a new `--plan` filename. Audit opens SQLite in read-only mode and changes no application records. SQLite may create/update its coordination sidecars; it is not a promise of zero filesystem metadata changes. Reports omit stored thread IDs, URLs, addresses, amounts, signatures and token values. The local plan contains opaque thread handles, counts, candidate categories, file identity and a salted content fingerprint; it is created with owner-only permissions on POSIX systems. Use a private folder; permissions on other platforms also depend on that folder's ACLs.
4. To find a known application thread without putting its identifier into shell history or reports, run `identify --db ... --plan ...` in an interactive terminal. Enter the thread identifier at the hidden prompt. The tool returns its opaque handle. Handle numbering belongs to this audit; never reuse a handle from an older plan.
5. Preview `clean --db ... --plan ... --thread thread-0001`. Repeat `--thread` for another selection. Read the counts and scope. Apply only if losing **all saved history and pending writes of those threads, across all namespaces**, is acceptable. Selective editing of a serialized checkpoint can break graph state or leave older copies; this version removes the whole selected thread. Unselected threads remain intact. There is no undo or automatic backup containing the deleted material.
6. Add `--apply --agent-stopped --confirm DELETE-SELECTED-THREADS` to that reviewed command. Cleanup validates the same store and complete logical contents again, deletes within one transaction, verifies the selected records are absent, and closes the store. An edited/stale plan, unknown handle, unsupported schema or lock is refused. Verification failures roll back the transaction. Run a fresh audit afterwards with another plan filename.

Keep the database path out of shared screenshots if the path itself contains private information. The tool's error messages do not echo private paths or database values. Exit status 0 means the requested operation completed within this scope; 2 means refusal. Neither means that every payment trace has been found or erased everywhere.

## What discovery covers

Payment candidates include current HTTP `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE` headers, legacy `X-PAYMENT`/`X-PAYMENT-RESPONSE`, the `x402Version` field, receipt/invoice markers, and co-occurring `transaction`, `network` and `payer` fields. Generic credential signatures are also reported. The x402 header meanings come from the [official HTTP transport specification](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md).

The scanner examines checkpoint rows, metadata, pending writes and identifiers, including older snapshots and subgraph namespaces. It scans raw bytes and extracts bounded MessagePack primitive string/binary slices without reconstructing application classes. It never invokes pickle or LangGraph object deserialization. Extension contents remain inert bytes. It also examines one layer of base64/base64url text for x402 message/receipt markers: tokens of 24–65,536 encoded characters, at most 256 token candidates and about 1 MiB decoded per stored value. MessagePack extraction is limited to depth 64 and 100,000 nodes; malformed or unsupported encodings fall back to raw signatures. Limits are 256 MiB database, 64 MiB aggregate payload, 8 MiB per value, 100,000 rows and 1,000 threads. Exceeding a store limit refuses the audit without producing a partial plan.

These are heuristics. Documentation, unsuccessful challenges and attempted authorizations can match. **A candidate is not proof a payment occurred.** A zero-match result is not proof no payment occurred. Encoded/escaped, compressed, encrypted, nested extension data, private prose, unsupported stores and unmarked transactions can be missed. Counts can repeat one event across multiple saved snapshots.

## Privacy boundary

Removal stops these selected application records from appearing through the supported local store. It is logical deletion, not forensic disk/RAM erasure. SQLite pages/WAL, backups, exported logs, summaries, embeddings, separate long-term memory, running process context, cloud/provider records and the blockchain are outside scope. The source store may remain physically recoverable. Nobody should describe this tool as making an existing on-chain payment anonymous or hiding activity from a person with full access to the agent's machine.

The proposed z402 product will need to prevent payment-to-agent linkage during the payment/transport workflow. That system is separate from this local cleanup tool and is not implemented by it. See `docs/Z402_DESIGN.md` in the repository.

## Reproduce validation

From the repository:

```sh
python3 -m unittest discover -s tools/memory-cleaner/tests -p 'test_*.py' -v
```

For the separate real-store fixture probe, create an isolated test environment and install `langgraph-checkpoint-sqlite==3.1.1` and `langgraph-checkpoint==4.2.0`. Run `tools/memory-cleaner/tests/real_store_probe.py` with that environment's Python. This test plants invented protocol traces through the real saver, removes old/current/child checkpoints and writes, verifies the other thread remains readable and can continue, and makes no model/provider/payment call. These dependencies are test-only; the distributed cleaner requires none.
