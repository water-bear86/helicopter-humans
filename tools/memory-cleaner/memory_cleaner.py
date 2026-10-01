#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Helicopter Humans contributors
# SQLite schema contract adapted from langgraph-checkpoint-sqlite 3.1.1:
# Copyright (c) 2024 LangChain, Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
"""Local LangGraph SQLite history cleanup. Python 3.10+, standard library only.

Never deserialize checkpoint objects. Never print their values or thread IDs.
Deletion is logical whole-thread deletion, not secure physical erasure.
"""
import argparse
import base64
from contextlib import contextmanager
import getpass
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import sys

VERSION = "hh-memory-cleaner-1"
CONFIRMATION = "DELETE-SELECTED-THREADS"
MAX_DB = 256 * 1024 * 1024
MAX_VALUE = 8 * 1024 * 1024
MAX_PAYLOAD = 64 * 1024 * 1024
MAX_ROWS = 100_000
MAX_THREADS = 1000
SCHEMA = {
    "checkpoints": """CREATE TABLE checkpoints (
        thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL, parent_checkpoint_id TEXT, type TEXT,
        checkpoint BLOB, metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id))""",
    "writes": """CREATE TABLE writes (
        thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL, task_id TEXT NOT NULL, idx INTEGER NOT NULL,
        channel TEXT NOT NULL, type TEXT, value BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx))""",
}
QUERIES = {
    "checkpoints": "SELECT * FROM checkpoints ORDER BY thread_id, checkpoint_ns, checkpoint_id",
    "writes": "SELECT * FROM writes ORDER BY thread_id, checkpoint_ns, checkpoint_id, task_id, idx",
}
SIGNATURES = {
    "x402-challenge-marker": rb"(?i)(?<![A-Za-z0-9_-])(?:PAYMENT-REQUIRED|X-PAYMENT-REQUIRED)(?![A-Za-z0-9_-])",
    "x402-authorization-marker": rb"(?i)(?<![A-Za-z0-9_-])(?:PAYMENT-SIGNATURE|X-PAYMENT)(?![A-Za-z0-9_-])",
    "x402-settlement-marker": rb"(?i)(?<![A-Za-z0-9_-])(?:PAYMENT-RESPONSE|X-PAYMENT-RESPONSE)(?![A-Za-z0-9_-])",
    "x402-versioned-message": rb"(?i)(?<![A-Za-z0-9_])x402Version(?![A-Za-z0-9_])",
    "payment-receipt-marker": rb"(?i)(?<![A-Za-z0-9_])(?:payment[_-]?(?:receipt|hash|transaction)|invoice[_-]?id)(?![A-Za-z0-9_])",
    "github-token": rb"(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})",
    "secret-key-shaped": rb"sk-(?:proj-)?[A-Za-z0-9_-]{20,255}",
    "aws-access-key-id": rb"(?:AKIA|ASIA)[A-Z0-9]{16}",
    "private-key-marker": rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
    "bearer-token-shaped": rb"(?i)Bearer[ \t]+[A-Za-z0-9._~+/=-]{12,512}",
    "credential-assignment": rb"(?i)(?:api[_-]?key|password|client[_-]?secret|access[_-]?token)[\"']?[ \t]*[:=][ \t]*[\"']?[^\s\"',;}]{8,256}",
}
PATTERNS = {name: re.compile(pattern) for name, pattern in SIGNATURES.items()}
ENCODED = re.compile(rb"(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/-]{24,65536}={0,2}(?![A-Za-z0-9_+/=-])")


def msgpack_texts(data):
    """Extract primitive string/binary slices, never instantiate encoded classes.

    Extension contents stay inert raw bytes. Malformed/unsupported data falls
    back to the raw scan. This is not a LangGraph object deserializer.
    """
    texts, nodes = [], 0

    def walk(pos, depth):
        nonlocal nodes
        nodes += 1
        if depth > 64 or nodes > 100_000 or pos >= len(data):
            raise ValueError()
        tag = data[pos]
        pos += 1

        def take(size):
            nonlocal pos
            end = pos + size
            if end > len(data):
                raise ValueError()
            part = data[pos:end]
            pos = end
            return part

        if tag <= 0x7f or tag >= 0xe0 or tag in (0xc0, 0xc2, 0xc3):
            return pos
        if 0xa0 <= tag <= 0xbf:
            texts.append(take(tag & 31))
            return pos
        if 0x80 <= tag <= 0x9f:
            count = (tag & 15) * (2 if tag < 0x90 else 1)
        elif tag in (0xdc, 0xdd, 0xde, 0xdf):
            count = int.from_bytes(take(2 if tag in (0xdc, 0xde) else 4), "big") * (2 if tag in (0xde, 0xdf) else 1)
        elif tag in (0xc4, 0xc5, 0xc6, 0xd9, 0xda, 0xdb, 0xc7, 0xc8, 0xc9):
            size = int.from_bytes(take({0xc4: 1, 0xc5: 2, 0xc6: 4, 0xd9: 1, 0xda: 2, 0xdb: 4, 0xc7: 1, 0xc8: 2, 0xc9: 4}[tag]), "big")
            if tag in (0xc7, 0xc8, 0xc9):
                take(1)  # Extension type, deliberately never interpreted.
            texts.append(take(size))
            return pos
        else:
            sizes = {0xca: 4, 0xcb: 8, 0xcc: 1, 0xcd: 2, 0xce: 4, 0xcf: 8, 0xd0: 1, 0xd1: 2, 0xd2: 4, 0xd3: 8, 0xd4: 2, 0xd5: 3, 0xd6: 5, 0xd7: 9, 0xd8: 17}
            if tag not in sizes:
                raise ValueError()
            part = take(sizes[tag])
            if 0xd4 <= tag <= 0xd8:
                texts.append(part[1:])
            return pos
        if count > 100_000:
            raise ValueError()
        for _ in range(count):
            pos = walk(pos, depth + 1)
        return pos

    try:
        return texts if walk(0, 0) == len(data) else []
    except ValueError:
        return []


def candidates(data):
    found = {name: sum(1 for _ in pattern.finditer(data)) for name, pattern in PATTERNS.items()}
    scalar_counts = {}
    texts = msgpack_texts(data)
    for text in texts:
        for name, pattern in PATTERNS.items():
            scalar_counts[name] = scalar_counts.get(name, 0) + sum(1 for _ in pattern.finditer(text))
    for name, count in scalar_counts.items():
        found[name] = max(found[name], count)
    # Receipt bodies may omit x402Version. This is a heuristic, not settlement verification.
    if all(re.search(rb"(?i)(?<![A-Za-z0-9_])" + field + rb"(?![A-Za-z0-9_])", data) for field in [b"transaction", b"network", b"payer"]):
        found["settlement-fields-candidate"] = 1
    decoded_bytes = 0
    tokens = (match.group() for text in [data, *texts] for match in ENCODED.finditer(text))
    seen = set()
    for index, token in enumerate(tokens):
        if index >= 256 or decoded_bytes >= 1024 * 1024:
            break
        if token in seen:
            continue
        seen.add(token)
        try:
            decoded = base64.b64decode(token + b"=" * (-len(token) % 4), altchars=b"-_", validate=True)
        except ValueError:
            continue
        decoded_bytes += len(decoded)
        for name, pattern in PATTERNS.items():
            if name.startswith("x402-"):
                count = sum(1 for _ in pattern.finditer(decoded))
                if count:
                    label = "base64-" + name
                    found[label] = found.get(label, 0) + count
        if all(re.search(rb"(?i)(?<![A-Za-z0-9_])" + field + rb"(?![A-Za-z0-9_])", decoded) for field in [b"transaction", b"network", b"payer"]):
            found["base64-settlement-fields-candidate"] = found.get("base64-settlement-fields-candidate", 0) + 1
    return {name: count for name, count in found.items() if count}


class Refusal(Exception):
    """Only fixed, content-free messages may be shown to the operator."""


def normalized_sql(sql):
    # Whitespace between SQL tokens varies in the real saver. Preserve literals.
    pieces = re.split(r"('(?:[^']|'')*')", sql.strip())
    return "".join(piece if index % 2 else re.sub(r"\s+", "", piece).lower() for index, piece in enumerate(pieces)).replace("createtableifnotexists", "createtable")


def file_identity(path):
    if path.is_symlink():
        raise Refusal("Symlink databases are not supported.")
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise Refusal("Choose a regular database file without hard links.")
    if info.st_size > MAX_DB:
        raise Refusal("Database exceeds the 256 MiB limit.")
    return [info.st_dev, info.st_ino]


@contextmanager
def database(path, writable=False):
    identity = file_identity(path)
    resolved = path.resolve(strict=True)
    conn = sqlite3.connect(resolved.as_uri() + ("?mode=rw" if writable else "?mode=ro"), uri=True, timeout=0)
    try:
        conn.enable_load_extension(False)
        conn.execute("PRAGMA trusted_schema=OFF")
        if not writable:
            conn.execute("PRAGMA query_only=ON")
        conn.execute("BEGIN IMMEDIATE" if writable else "BEGIN")
        if identity != file_identity(path):
            raise Refusal("Database identity changed; stop the agent and audit again.")
        validate_schema(conn)
        yield conn, identity
    finally:
        # Uncommitted work, including any failed cleanup, is always rolled back.
        conn.close()


def validate_schema(conn):
    actual = conn.execute("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name").fetchall()
    expected = {(name, normalized_sql(sql)) for name, sql in SCHEMA.items()}
    tables = {(name, normalized_sql(sql)) for kind, name, _, sql in actual if kind == "table"}
    indexes = {("sqlite_autoindex_checkpoints_1", "checkpoints"), ("sqlite_autoindex_writes_1", "writes")}
    if tables != expected or any(
        kind != "table" and not (kind == "index" and sql is None and (name, table) in indexes)
        for kind, name, table, sql in actual
    ):
        raise Refusal("Unsupported schema: requires the dedicated LangGraph two-table SQLite store without extra objects.")
    if conn.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
        raise Refusal("Database integrity check failed.")


def bytes_of(value):
    if value is None:
        return b""
    if isinstance(value, bytes):
        return value
    if isinstance(value, str):
        return value.encode("utf-8")
    if isinstance(value, (int, float)):
        return str(value).encode("ascii")
    raise Refusal("Unsupported stored value.")


def inspect_store(conn, identity, salt):
    """One transaction, bounded reads; raw bytes only, no object reconstruction."""
    digest = hmac.new(bytes.fromhex(salt), digestmod=hashlib.sha256)
    counts, matches = {}, {}
    total_rows, total_bytes = 0, 0
    for table, query in QUERIES.items():
        digest.update(table.encode("ascii"))
        rows = conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
        total_rows += rows
        if total_rows > MAX_ROWS:
            raise Refusal("Store exceeds the 100,000-row limit.")
        # Bound each row before fetching its payload into Python.
        columns = [row[1] for row in conn.execute(f"PRAGMA table_info({table})")]
        lengths = ", ".join(f"coalesce(length({column}), 0)" for column in columns)
        for row_lengths in conn.execute(f"SELECT {lengths} FROM {table}"):
            if max(row_lengths) > MAX_VALUE:
                raise Refusal("A stored value exceeds the 8 MiB limit.")
            total_bytes += sum(row_lengths)
            if total_bytes > MAX_PAYLOAD:
                raise Refusal("Store exceeds the 64 MiB payload limit.")
        for row in conn.execute(query):
            thread_id = row[0]
            if not isinstance(thread_id, str):
                raise Refusal("Unsupported thread identifier.")
            counts.setdefault(thread_id, {"checkpoints": 0, "writes": 0})[table] += 1
            thread_matches = matches.setdefault(thread_id, {})
            if len(counts) > MAX_THREADS:
                raise Refusal("Store exceeds the 1,000-thread limit.")
            for value in row:
                data = bytes_of(value)
                digest.update(type(value).__name__.encode("ascii") + b":" + len(data).to_bytes(8, "big") + data)
                # Includes IDs, metadata, checkpoint blobs and pending writes.
                for name, found in candidates(data).items():
                    thread_matches[name] = thread_matches.get(name, 0) + found
    ids = sorted(counts)
    mapping = {f"thread-{index + 1:04d}": thread_id for index, thread_id in enumerate(ids)}
    threads = [
        {"handle": handle, **counts[thread_id], "candidates": dict(sorted(matches[thread_id].items()))}
        for handle, thread_id in mapping.items()
    ]
    return {"format": VERSION, "identity": identity, "salt": salt, "fingerprint": digest.hexdigest(), "threads": threads}, mapping


def save_plan(path, plan):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(plan, stream, indent=2, ensure_ascii=True)
        stream.write("\n")


def load_plan(path):
    if path.is_symlink() or path.stat().st_size > 1024 * 1024:
        raise Refusal("Invalid or oversized audit plan.")
    with path.open(encoding="utf-8") as stream:
        plan = json.load(stream)
    if not isinstance(plan, dict) or plan.get("format") != VERSION or not re.fullmatch(r"[0-9a-f]{64}", str(plan.get("salt", ""))):
        raise Refusal("Invalid audit plan.")
    return plan


def fresh_plan(conn, identity, plan):
    fresh, mapping = inspect_store(conn, identity, plan["salt"])
    if fresh != plan:
        raise Refusal("Plan is stale, edited or belongs to another database. Audit again.")
    return mapping


def display(threads):
    for thread in threads:
        categories = ", ".join(f"{name}:{count}" for name, count in thread["candidates"].items()) or "no signature matches"
        print(f"{thread['handle']}: {thread['checkpoints']} checkpoints, {thread['writes']} writes; {categories}")
    print("Payment markers identify possible challenges, attempts or receipts, not proof money moved. Signatures can miss traces or produce false positives. IDs and values are omitted.")


def audit(args):
    with database(args.db) as (conn, identity):
        plan, _ = inspect_store(conn, identity, secrets.token_hex(32))
        save_plan(args.plan, plan)
        display(plan["threads"])
    print("Read-only audit complete. Plan saved locally; no application records changed.")


def identify(args):
    plan = load_plan(args.plan)
    # Avoid putting potentially sensitive thread IDs in argv, shell history or reports.
    if not sys.stdin.isatty():
        raise Refusal("Identify requires an interactive terminal for hidden thread-ID input.")
    thread_id = getpass.getpass("Known application thread ID (hidden): ")
    if len(thread_id) > 4096:
        raise Refusal("Thread ID exceeds the input limit.")
    with database(args.db) as (conn, identity):
        mapping = fresh_plan(conn, identity, plan)
        handle = next((label for label, stored_id in mapping.items() if stored_id == thread_id), None)
        if handle is None:
            raise Refusal("That thread is not in this audit.")
        display([thread for thread in plan["threads"] if thread["handle"] == handle])


def clean(args):
    if args.apply and (not args.agent_stopped or args.confirm != CONFIRMATION):
        raise Refusal("Apply requires --agent-stopped and --confirm DELETE-SELECTED-THREADS after reviewing the preview.")
    plan = load_plan(args.plan)
    selected = set(args.thread)
    if not selected or len(selected) != len(args.thread):
        raise Refusal("Select each thread handle exactly once.")
    with database(args.db, writable=args.apply) as (conn, identity):
        mapping = fresh_plan(conn, identity, plan)
        if not selected.issubset(mapping):
            raise Refusal("Unknown thread handle; use this audit's handles.")
        preview = [thread for thread in plan["threads"] if thread["handle"] in selected]
        display(preview)
        print("Scope: ALL history and pending writes of selected threads, across ALL their namespaces. This cannot be undone by this tool.")
        if not args.apply:
            print("Preview only. No application records changed.")
            return
        for handle in sorted(selected):
            for table in SCHEMA:
                conn.execute(f"DELETE FROM {table} WHERE thread_id = ?", (mapping[handle],))
                if conn.execute(f"SELECT count(*) FROM {table} WHERE thread_id = ?", (mapping[handle],)).fetchone()[0]:
                    raise Refusal("Deletion verification failed; transaction rolled back.")
        if identity != file_identity(args.db):
            raise Refusal("Database identity changed; transaction rolled back.")
        conn.commit()
    print(f"Removed {sum(t['checkpoints'] for t in preview)} checkpoints and {sum(t['writes'] for t in preview)} writes from {len(selected)} selected threads. Store closed.")
    print("Logical deletion only. Other stores, RAM, backups and provider copies are outside scope. Stop future writes or secrets can return. Audit again for a fresh plan.")


def demo(args):
    # A new invented fixture only; never replace an existing file.
    fd = os.open(args.db, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    os.close(fd)
    with sqlite3.connect(args.db) as conn:
        for definition in SCHEMA.values():
            conn.execute(definition)
        fake_key = "ghp_" + "X" * 36
        challenge = "PAYMENT-REQUIRED: invented-challenge; " + fake_key
        authorization = "PAYMENT-SIGNATURE: invented-authorization; " + fake_key
        for namespace, checkpoint_id, value in [("", "old", challenge), ("", "new", "Job complete"), ("subgraph", "old", authorization)]:
            conn.execute("INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)", ("client-demo", namespace, checkpoint_id, None, "json", json.dumps({"message": value}), "{}"))
        conn.execute("INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)", ("keep-demo", "", "keep", None, "json", b'{"message":"Ordinary work"}', b"{}"))
        receipt = ("PAYMENT-RESPONSE: invented-receipt; " + fake_key).encode()
        conn.execute("INSERT INTO writes VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ("client-demo", "subgraph", "old", "task", 0, "messages", "json", receipt))
    print("Created new invented demo store: thread-0001 has planted x402 markers and token-shaped text; thread-0002 should be preserved. No payment was made.")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Find possible x402 payment traces and credentials, then review and logically delete selected LangGraph local SQLite threads. No network or runtime dependencies.")
    commands = parser.add_subparsers(dest="command", required=True)
    for name, function in [("audit", audit), ("identify", identify), ("clean", clean), ("demo", demo)]:
        command = commands.add_parser(name)
        command.add_argument("--db", type=Path, required=True, help="Explicit local SQLite file; no automatic home-directory scan")
        if name != "demo":
            command.add_argument("--plan", type=Path, required=True, help="Local audit plan; audit creates it without overwriting")
        if name == "clean":
            command.add_argument("--thread", action="append", required=True, help="Opaque handle from the audit; repeat to select another")
            command.add_argument("--apply", action="store_true", help="Actually delete the selected threads")
            command.add_argument("--agent-stopped", action="store_true", help="Attest that the application is stopped and will not write")
            command.add_argument("--confirm", choices=[CONFIRMATION])
        command.set_defaults(function=function)
    args = parser.parse_args(argv)
    try:
        args.function(args)
        return 0
    except Refusal as error:
        print(f"Refused: {error}", file=sys.stderr)
    except (OSError, sqlite3.Error, ValueError, UnicodeError, OverflowError, RecursionError):
        # Exception text may contain database contents or private paths; never echo it.
        print("Refused: file, lock, database or plan could not be safely processed. Check permissions, stop the agent and use a fresh supported store/plan.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
