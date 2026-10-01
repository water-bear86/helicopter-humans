"""Development-only compatibility probe. Python is not in the npm package/runtime."""
import importlib.metadata
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

from langgraph.checkpoint.base import empty_checkpoint
from langgraph.checkpoint.sqlite import SqliteSaver

assert importlib.metadata.version("langgraph-checkpoint-sqlite") == "3.1.1"
assert importlib.metadata.version("langgraph-checkpoint") == "4.2.0"
archive, node = [str(Path(path).resolve()) for path in sys.argv[1:3]]
with tempfile.TemporaryDirectory(prefix="hh-real-store-") as directory:
    root = Path(directory)
    installed = subprocess.run(["npm", "install", "--prefix", directory, "--cache", str(root / "npm-cache"), "--ignore-scripts", "--no-audit", "--no-fund", archive], capture_output=True, text=True)
    assert installed.returncode == 0, installed.stderr
    entry = root / "node_modules/expose402/bin/expose402.js"
    db = root / "actual.sqlite"
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
    node_only = root / "node-only"
    node_only.mkdir()
    (node_only / "node").symlink_to(node)
    env = dict(os.environ, PATH=str(node_only))
    for args, input_text in [(["--preview"], ""), ([], "1\nyes\nDELETE-SELECTED-THREADS\n")]:
        result = subprocess.run([node, str(entry), "--store", str(db), *args], input=input_text, env=env, capture_output=True, text=True, timeout=15)
        assert result.returncode == 0, result.stderr
        for category in ["github-token", "secret-key-shaped", "private-key-marker", "x402-challenge-marker", "x402-authorization-marker", "x402-settlement-marker", "x402-versioned-message"]:
            assert category in result.stdout, category
        assert "sk-" + "Z" * 36 not in result.stdout
        assert "real-fixture" not in result.stdout
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
    evidence = {"source": "actual SqliteSaver 3.1.1 / checkpoint 4.2.0 invented fixture", "node": subprocess.check_output([node, "--version"], text=True).strip(), "installedOutsideRepository": True, "nodeOnlyPath": True, "checks": ["MessagePack payment/credential candidates", "old snapshots and child namespace", "confirmed whole-thread deletion including pending writes", "unselected thread unchanged and resumes", "no saved secrets or raw IDs printed"], "providerCalls": 0, "payments": 0}
    if len(sys.argv) > 3:
        Path(sys.argv[3]).write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2))
