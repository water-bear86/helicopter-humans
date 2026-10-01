"""Run separately with test-only pinned LangGraph dependencies, no model calls."""
import contextlib
import importlib.metadata
import importlib.util
import io
from pathlib import Path
import sqlite3
import tempfile

from langgraph.checkpoint.base import empty_checkpoint
from langgraph.checkpoint.sqlite import SqliteSaver

spec = importlib.util.spec_from_file_location("cleaner", Path(__file__).resolve().parents[1] / "memory_cleaner.py")
cleaner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleaner)

assert importlib.metadata.version("langgraph-checkpoint-sqlite") == "3.1.1"
assert importlib.metadata.version("langgraph-checkpoint") == "4.2.0"

with tempfile.TemporaryDirectory() as directory:
    db = Path(directory) / "actual.sqlite"
    plan = Path(directory) / "plan.json"
    with SqliteSaver.from_conn_string(str(db)) as saver:
        config = {"configurable": {"thread_id": "real-fixture", "checkpoint_ns": ""}}
        for value in ["PAYMENT-REQUIRED: invented; sk-" + "Z" * 36, "Completed work"]:
            checkpoint = empty_checkpoint()
            checkpoint["channel_values"] = {"message": value}
            config = saver.put(config, checkpoint, {"source": "input", "step": 0}, {})
        saver.put_writes(config, [("message", {"PAYMENT-RESPONSE": "invented", "credential": "ghp_" + "Y" * 36})], "pending-task")
        child = empty_checkpoint()
        child["channel_values"] = {"message": {"x402Version": 2, "PAYMENT-SIGNATURE": "invented", "key": "-----BEGIN PRIVATE KEY-----"}}
        saver.put({"configurable": {"thread_id": "real-fixture", "checkpoint_ns": "child"}}, child, {"source": "input", "step": 0}, {})
        keep = empty_checkpoint()
        keep["channel_values"] = {"message": "Keep this actual checkpoint"}
        keep_config = saver.put({"configurable": {"thread_id": "unchanged", "checkpoint_ns": ""}}, keep, {"source": "input", "step": 0}, {})
        before = saver.get_tuple(keep_config)
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
        assert cleaner.main(["audit", "--db", str(db), "--plan", str(plan)]) == 0, captured.getvalue()
        assert cleaner.main(["clean", "--db", str(db), "--plan", str(plan), "--thread", "thread-0001"]) == 0
        assert cleaner.main(["clean", "--db", str(db), "--plan", str(plan), "--thread", "thread-0001", "--apply", "--agent-stopped", "--confirm", cleaner.CONFIRMATION]) == 0
    assert "github-token" in captured.getvalue()
    assert "secret-key-shaped" in captured.getvalue()
    assert "private-key-marker" in captured.getvalue()
    for category in ["x402-challenge-marker", "x402-authorization-marker", "x402-settlement-marker", "x402-versioned-message"]:
        assert category in captured.getvalue(), captured.getvalue()
    assert "sk-" + "Z" * 36 not in captured.getvalue()
    with SqliteSaver.from_conn_string(str(db)) as saver:
        assert saver.get_tuple(config) is None
        assert list(saver.list({"configurable": {"thread_id": "real-fixture"}})) == []
        assert saver.get_tuple(keep_config) == before
        follow_up = empty_checkpoint()
        follow_up["channel_values"] = {"message": "Continue ordinary work"}
        updated = saver.put(keep_config, follow_up, {"source": "loop", "step": 1}, {})
        assert saver.get_tuple(updated).checkpoint["channel_values"]["message"] == "Continue ordinary work"
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT count(*) FROM writes WHERE thread_id='real-fixture'").fetchone()[0] == 0
print("Real SqliteSaver 3.1.1 / checkpoint 4.2.0 probe passed: x402 markers in MessagePack, old snapshots, child namespace and writes removed; untouched thread resumes. No provider calls or payments.")
