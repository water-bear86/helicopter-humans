import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "memory_cleaner.py"
spec = importlib.util.spec_from_file_location("cleaner", MODULE)
cleaner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleaner)


class CleanerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "memory.sqlite"
        self.plan = Path(self.temp.name) / "audit.json"
        self.run_cli("demo", expected=0)

    def run_cli(self, command, *extra, expected=0):
        args = [command, "--db", str(self.db)]
        if command != "demo":
            args += ["--plan", str(self.plan)]
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = cleaner.main(args + list(extra))
        self.assertEqual(code, expected, output.getvalue())
        self.assertNotIn("ghp_" + "X" * 36, output.getvalue())
        self.assertNotIn("client-demo", output.getvalue())
        return output.getvalue()

    def contents(self):
        with sqlite3.connect(self.db) as conn:
            return {table: conn.execute(f"SELECT * FROM {table} ORDER BY thread_id, checkpoint_ns, checkpoint_id").fetchall() for table in cleaner.SCHEMA}

    def apply(self, handle="thread-0001", expected=0):
        return self.run_cli("clean", "--thread", handle, "--apply", "--agent-stopped", "--confirm", cleaner.CONFIRMATION, expected=expected)

    def test_read_only_audit_reports_old_snapshots_and_writes_without_values(self):
        before = self.contents()
        digest = hashlib.sha256(self.db.read_bytes()).hexdigest()
        output = self.run_cli("audit")
        self.assertIn("thread-0001: 3 checkpoints, 1 writes", output)
        self.assertIn("github-token:3", output)
        for category in ["x402-challenge-marker", "x402-authorization-marker", "x402-settlement-marker"]:
            self.assertIn(category, output)
        self.assertIn("thread-0002: 1 checkpoints, 0 writes", output)
        self.assertEqual(before, self.contents())
        self.assertEqual(digest, hashlib.sha256(self.db.read_bytes()).hexdigest())
        self.assertEqual(self.plan.stat().st_mode & 0o777, 0o600)
        self.assertNotIn("client-demo", self.plan.read_text())
        self.assertNotIn("ghp_", self.plan.read_text())

    def test_clean_defaults_to_preview(self):
        self.run_cli("audit")
        before = self.contents()
        self.assertIn("Preview only", self.run_cli("clean", "--thread", "thread-0001"))
        self.assertEqual(before, self.contents())

    def test_apply_removes_all_selected_namespaces_and_preserves_other_thread(self):
        self.run_cli("audit")
        keep = [row for row in self.contents()["checkpoints"] if row[0] == "keep-demo"]
        self.assertIn("Removed 3 checkpoints and 1 writes", self.apply())
        remaining = self.contents()
        self.assertEqual(remaining["checkpoints"], keep)
        self.assertEqual(remaining["writes"], [])
        self.run_cli("clean", "--thread", "thread-0001", expected=2)

    def test_explicit_confirmation_and_stopped_attestation_are_required(self):
        self.run_cli("audit")
        before = self.contents()
        self.run_cli("clean", "--thread", "thread-0001", "--apply", expected=2)
        self.run_cli("clean", "--thread", "thread-0001", "--apply", "--agent-stopped", expected=2)
        self.assertEqual(before, self.contents())

    def test_stale_plan_after_even_same_length_payload_change_refuses(self):
        self.run_cli("audit")
        with sqlite3.connect(self.db) as conn:
            conn.execute("UPDATE checkpoints SET metadata = ? WHERE thread_id = ?", (b"[]", "keep-demo"))
        before = self.contents()
        self.assertIn("stale", self.apply(expected=2))
        self.assertEqual(before, self.contents())

    def test_edited_plan_refuses(self):
        self.run_cli("audit")
        plan = json.loads(self.plan.read_text())
        plan["threads"][0]["checkpoints"] = 1
        self.plan.write_text(json.dumps(plan))
        before = self.contents()
        self.apply(expected=2)
        self.assertEqual(before, self.contents())

    def test_same_content_different_database_identity_refuses(self):
        self.run_cli("audit")
        other = self.db.with_name("other.sqlite")
        other.write_bytes(self.db.read_bytes())
        self.db = other
        self.apply(expected=2)
        self.assertEqual(len(self.contents()["checkpoints"]), 4)

    def test_unknown_and_duplicate_handles_refuse(self):
        self.run_cli("audit")
        before = self.contents()
        self.apply("thread-9999", expected=2)
        self.run_cli("clean", "--thread", "thread-0001", "--thread", "thread-0001", expected=2)
        self.assertEqual(before, self.contents())

    def test_no_overwrite_of_plan_or_demo(self):
        self.run_cli("audit")
        before = self.plan.read_bytes(), self.db.read_bytes()
        self.run_cli("audit", expected=2)
        self.run_cli("demo", expected=2)
        self.assertEqual(before, (self.plan.read_bytes(), self.db.read_bytes()))

    def test_extra_tables_triggers_and_changed_collation_refuse(self):
        for statement in ["CREATE TABLE secrets(value TEXT)", "CREATE TRIGGER bad AFTER DELETE ON checkpoints BEGIN DELETE FROM writes; END"]:
            with self.subTest(statement=statement):
                with sqlite3.connect(self.db) as conn:
                    conn.execute(statement)
                before = self.db.read_bytes()
                self.run_cli("audit", expected=2)
                self.assertEqual(before, self.db.read_bytes())
                with sqlite3.connect(self.db) as conn:
                    conn.execute("DROP TABLE secrets" if "TABLE" in statement else "DROP TRIGGER bad")
        changed = self.db.with_name("collation.sqlite")
        with sqlite3.connect(changed) as conn:
            for definition in cleaner.SCHEMA.values():
                conn.execute(definition.replace("thread_id TEXT", "thread_id TEXT COLLATE NOCASE"))
        self.db = changed
        self.run_cli("audit", expected=2)

    def test_symlink_and_hardlinked_database_refuse(self):
        link = self.db.with_name("link.sqlite")
        link.symlink_to(self.db)
        original = self.db
        self.db = link
        self.run_cli("audit", expected=2)
        self.db = original
        link.unlink()
        os.link(self.db, link)
        self.run_cli("audit", expected=2)

    def test_read_only_audit_of_wal_store_and_writer_lock_refusal(self):
        with sqlite3.connect(self.db) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("UPDATE checkpoints SET metadata = '{}' WHERE thread_id = 'keep-demo'")
            writer.commit()
            self.run_cli("audit")
            before = self.contents()
            writer.execute("BEGIN IMMEDIATE")
            self.apply(expected=2)
            writer.rollback()
        self.assertEqual(before, self.contents())

    def test_mid_delete_failure_rolls_back_both_tables_and_closes_store(self):
        self.run_cli("audit")
        before = self.contents()
        original = cleaner.file_identity
        calls = 0

        def fail_final(path):
            nonlocal calls
            calls += 1
            if calls == 3:
                raise cleaner.Refusal("Injected final verification failure.")
            return original(path)

        with patch.object(cleaner, "file_identity", side_effect=fail_final):
            self.apply(expected=2)
        self.assertEqual(before, self.contents())
        with sqlite3.connect(self.db, timeout=0) as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.rollback()

    def test_missing_database_does_not_create_it(self):
        self.db = self.db.with_name("missing.sqlite")
        self.run_cli("audit", expected=2)
        self.assertFalse(self.db.exists())

    def test_bounds_refuse_without_plan_or_record_changes(self):
        before = self.contents()
        for limit, value in [("MAX_ROWS", 1), ("MAX_VALUE", 1), ("MAX_THREADS", 1), ("MAX_PAYLOAD", 1), ("MAX_DB", 1)]:
            with patch.object(cleaner, limit, value):
                self.run_cli("audit", expected=2)
            self.assertFalse(self.plan.exists())
        self.assertEqual(before, self.contents())

    def test_raw_scan_never_executes_serialized_checkpoint_objects(self):
        # A pickle payload must stay inert; the cleaner never reconstructs objects.
        import pickle
        marker = Path(self.temp.name) / "executed"

        class Trap:
            def __reduce__(self):
                return (eval, ("__import__('pathlib').Path(" + repr(str(marker)) + ").touch()",))

        with sqlite3.connect(self.db) as conn:
            conn.execute("UPDATE checkpoints SET type='pickle', checkpoint=? WHERE thread_id='keep-demo'", (pickle.dumps(Trap()),))
        self.run_cli("audit")
        self.assertFalse(marker.exists())
        self.apply("thread-0002")
        self.assertFalse(marker.exists())

    def test_id_and_metadata_candidate_values_never_reach_output(self):
        secret_id = "sk-" + "Q" * 32
        with sqlite3.connect(self.db) as conn:
            conn.execute("UPDATE checkpoints SET thread_id=?, metadata=? WHERE thread_id='keep-demo'", (secret_id, b'{"password":"only-fake-password"}'))
        output = self.run_cli("audit")
        for secret in [secret_id, "only-fake-password"]:
            self.assertNotIn(secret, output)
            self.assertNotIn(secret, self.plan.read_text())

    def test_identify_uses_hidden_input_and_refuses_noninteractive(self):
        self.run_cli("audit")
        self.run_cli("identify", expected=2)
        with patch("sys.stdin.isatty", return_value=True), patch.object(cleaner.getpass, "getpass", return_value="client-demo"):
            self.assertIn("thread-0001", self.run_cli("identify"))

    def test_v1_v2_payment_headers_are_case_insensitive_and_not_payment_proof(self):
        fixtures = {
            "x402-challenge-marker": [b"PAYMENT-REQUIRED: fake", b"payment-required: fake"],
            "x402-authorization-marker": [b"X-PAYMENT: fake", b"PAYMENT-SIGNATURE: fake"],
            "x402-settlement-marker": [b"X-PAYMENT-RESPONSE: fake", b"payment-response: fake"],
            "x402-versioned-message": [b'{"x402Version":1,"accepts":[]}', b'{"x402Version":2,"accepted":{}}'],
        }
        for category, examples in fixtures.items():
            for example in examples:
                self.assertIn(category, cleaner.candidates(example))
        self.assertNotIn("x402-authorization-marker", cleaner.candidates(b"X-PAYMENT-RESPONSE: fake"))
        self.assertEqual(cleaner.candidates(b"HTTP 402 alone, bought a sandwich, ordinary unmarked text"), {})

    def test_payment_body_base64_and_receipt_fields_are_detected_without_values(self):
        import base64
        for body in [b'{"x402Version":2,"payload":{"signature":"invented"}}', b'{"success":true,"transaction":"invented-tx","network":"eip155:84532","payer":"invented"}']:
            for encoder in [base64.b64encode, base64.urlsafe_b64encode]:
                encoded = encoder(body).rstrip(b"=")
                matches = cleaner.candidates(encoded)
                self.assertTrue(any(name.startswith("base64-") for name in matches))
                with sqlite3.connect(self.db) as conn:
                    conn.execute("UPDATE checkpoints SET checkpoint=? WHERE thread_id='keep-demo'", (encoded,))
                self.plan = self.plan.with_name("audit-" + str(len(encoded)) + "-" + encoder.__name__ + ".json")
                output = self.run_cli("audit")
                self.assertNotIn("invented-tx", output)
                self.assertNotIn(encoded.decode(), output)
        self.assertEqual(cleaner.candidates(b"invalid_base64" * 10000), {})

    def test_sql_normalization_preserves_default_literals(self):
        self.assertNotEqual(cleaner.normalized_sql("CREATE TABLE a(b TEXT DEFAULT '')"), cleaner.normalized_sql("CREATE TABLE a(b TEXT DEFAULT ' ')"))

    def test_msgpack_length_bytes_do_not_hide_payment_markers_or_encoded_bodies(self):
        import base64
        header = b"PAYMENT-REQUIRED: " + b"A" * 50
        self.assertIn("x402-challenge-marker", cleaner.candidates(b"\xd9" + bytes([len(header)]) + header))
        encoded = base64.b64encode(b'{"x402Version":2,"payload":{"signature":"invented"}}')
        self.assertIn("base64-x402-versioned-message", cleaner.candidates(b"\xd9" + bytes([len(encoded)]) + encoded))
        for malformed in [b"\xdb\xff\xff\xff\xff", b"\xdd\xff\xff\xff\xff", b"\xc1", b"\x91" * 1000]:
            self.assertEqual(cleaner.msgpack_texts(malformed), [])


if __name__ == "__main__":
    unittest.main()
