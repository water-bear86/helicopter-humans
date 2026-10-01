# Helicopter Humans traces

A guided local utility for finding possible x402/payment traces in saved agent history, then explicitly choosing which whole threads to remove. Start with a preview. No account, wallet, payment, telemetry or upload of history.

## Start

Install **Node.js 24 or newer** from [nodejs.org](https://nodejs.org/en/download), then paste this into your terminal:

```sh
npx --yes https://helicopter-humans.vercel.app/helicopter-humans-traces-0.1.0.tgz
```

This is a versioned npm package archive hosted by the project. The package is **not published to the npm registry** yet. Do not use the short registry package command until registry publication is confirmed. `npx --yes` approves downloading the package, **not deleting history**. npm contacts the download host to install it; the utility itself makes no network requests. No Python, system SQLite executable or additional dependency is needed.

Not sure what this does? Use the same command with `--demo` at the end. Every finding in that demo is invented; its temporary files are discarded when it exits. Use `--preview` to stop after the summary, `--help` for options or `--version` for the version. Node 24 may print an experimental SQLite warning; this comes from Node, not a payment request or an upload.

The published archive's SHA-256 is in [traces-sha256.json](https://helicopter-humans.vercel.app/traces-sha256.json). [Source and tests](https://github.com/water-bear86/helicopter-humans/tree/feat/49th-8-agent-memory-cleaner/packages/traces).

## Guided flow

1. Choose one candidate history file, enter its configured path, or choose **invented demo**. Only your chosen file is opened.
2. Read the supported-source summary and candidate counts. Saved secret values and raw thread IDs are never printed. Temporary `thread-0001` labels identify threads within this preview; counts include all checkpoints and pending writes. Marker categories can have false positives and cannot prove a payment happened.
3. Explicitly select thread numbers. Review the number of whole threads, checkpoints and pending writes affected.
4. Stop the agent/app using this history. Confirm this, then type `DELETE-SELECTED-THREADS`. Anything else cancels. Empty selection, EOF, normal discovery and preview never remove data.

**Removal deletes each selected thread's entire saved history**, including snapshots and pending writes across all its namespaces. It does not remove just one receipt or one message. Other threads remain saved. If you cannot confidently identify which thread you want to lose, cancel. Keep your own backup if you want an undo; this tool does not copy saved secrets into a backup.

You can choose a store directly:

```sh
npx --yes https://helicopter-humans.vercel.app/helicopter-humans-traces-0.1.0.tgz --store "/path/to/your/history.sqlite" --preview
```

## What is supported

Local **LangGraph SqliteSaver 3.1.1 two-table SQLite history**, tested with `langgraph-checkpoint==4.2.0`. Exact schema is validated before reading/removing content. Additional tables, indexes, triggers, changed layouts, encrypted databases and other agent history sources are refused. No plugin or auto-detection for ChatGPT, Claude, Codex, browsers, provider dashboards or blockchain history is implemented.

The utility checks only these exact conventional candidates, without recursion:

- In the directory you run it from: `checkpoints.sqlite`, `checkpoints.db`, `langgraph.sqlite`, `langgraph.db`, `.langgraph/checkpoints.sqlite`, `.langgraph/checkpoints.db`.
- In your home directory: `.langgraph/checkpoints.sqlite`, `.langgraph/checkpoints.db`.
- On Windows, if `LOCALAPPDATA` is set: `LangGraph/checkpoints.sqlite` inside that directory.

These are **filename guesses, not a universal LangGraph default**. LangGraph apps configure their own history path. If none is found, the prompt offers demo, a path or cancellation. Ask the app's owner for its saved-history path. The tool does not search your whole machine, request general disk access or read unrelated files. `--discover` only lists candidate paths without opening stores. Permissions are needed only for the selected file; removal additionally needs write access to its folder for a private operation receipt.

The byte scanner checks saved checkpoint fields, metadata, identifiers and pending writes for v1/v2 payment headers, `x402Version`, receipt fields, bounded base64 payment objects and some credential-shaped strings. MessagePack strings/extensions stay inert bytes; encoded Python objects are never executed. This is a bounded heuristic, not a complete secret detector. Limits: 256 MiB store, 8 MiB per value, 64 MiB scanned payload, 100,000 rows, 1,000 threads; base64 examination is also bounded. Symbolic/hard-linked files are refused.

## Failure and recovery

Locked history: stop the agent and other apps using it, then retry a fresh preview. Unsupported history: ask the app owner for a supported LangGraph store; do not change its schema just to satisfy this tool. Missing/unreadable path: check the selected path and its file access. No file is created for a missing store. A changed history invalidates the preview and requires starting again.

Confirmed removal uses one transaction covering both tables, with a file-identity and full-content check before deleting, verification before commit, and rollback if the operation fails. A private `.hh-traces-operations` folder beside the store contains secret-free operation receipts (opaque salted fingerprints and counts, no saved content/IDs). If the receipt folder cannot be safely written, removal is refused.

After an interruption, use the receipt path displayed by the tool (or a receipt in that folder):

```sh
npx --yes https://helicopter-humans.vercel.app/helicopter-humans-traces-0.1.0.tgz --recover "/path/to/receipt.json" --store "/path/to/history.sqlite"
```

Recovery is read-only. It reports `applied`, `not-applied`, or `changed-since-operation`; the last means the current content cannot establish the outcome. It is **not undo**. Do not blindly repeat a removal after an interrupted operation. A receipt protects operation assessment, not against an adversary editing your local files.

SQLite logical deletion is not secure erasure. Free pages, journals, WALs, backups, other devices, provider records and blockchain records may retain content. No wallet access, signing, payment or cryptographic payment unlinkability is provided. Planned z402 transport/proof work is separate.

## Distribution and verification

`helicopter-humans-traces@0.1.0`, executable `hh-traces`. Uses only built-in Node modules, including [node:sqlite](https://github.com/nodejs/node/blob/v24.0.0/doc/api/sqlite.md); no native addon, runtime dependency, install hook or global Python/tool requirement. Published archive includes only executable, source, package metadata, README and MIT license.

macOS is exercised with the minimum Node 24.0.0 and current development Node. Windows/Linux path behavior is covered by tests; the repository CI matrix exercises packaged installs on all three operating systems. Check that run's result before treating Windows/Linux execution as verified. Runtime checks, clean `npm pack` installation, invented fixture paths and real LangGraph compatibility are recorded in the canonical launch issue.

MIT license. This is an early local utility; understand whole-thread removal before confirming.
