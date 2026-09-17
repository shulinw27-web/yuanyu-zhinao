"""Durability and fail-closed tests use temporary synthetic-only databases."""
import importlib.util
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from http.client import HTTPConnection
from threading import Thread
from instance_store import InstanceStore
from test_model_definition import fixture

spec = importlib.util.spec_from_file_location("persistent_semantic_app", Path(__file__).with_name("app.py"))
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
IDENTITY = {"tenantId": "synthetic-a", "deploymentId": "test-instance-a"}


def facts(run_id="run-a"):
    return {"runId": run_id, "scenarioId": "test", "expectedSystems": ["ERP", "QMS"], "facts": [
        {"id": run_id + system, "sourceSystem": system, "sourceRecordId": system + "-record", "objectType": "QualityEvent",
         "eventType": "reported", "status": "open", "classification": "synthetic", "occurredAt": "2026-09-17T00:00:00Z",
         "runId": run_id, "simulated": True, "payload": {"eventId": run_id}} for system in ["ERP", "QMS"]]}


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="semantic-persistence-")
        self.path = str(Path(self.directory.name) / "state.db")

    def tearDown(self):
        self.directory.cleanup()

    def test_atomic_snapshot_roundtrip_and_owner_binding_without_secret(self):
        store = InstanceStore(self.path, {**IDENTITY, "token": "do-not-store"})
        self.assertIsNone(store.load())
        store.save({"model": "A"}); store.close()
        for identity in [{**IDENTITY, "tenantId": "other"}, {**IDENTITY, "deploymentId": "other"}]:
            with self.assertRaisesRegex(ValueError, "OWNER_MISMATCH"):
                InstanceStore(self.path, identity)
        reopened = InstanceStore(self.path, IDENTITY)
        try:
            self.assertEqual(reopened.load(), {"model": "A"})
            self.assertEqual(reopened.revision, 1)
        finally:
            reopened.close()
        self.assertNotIn(b"do-not-store", Path(self.path).read_bytes())

    def test_second_process_cannot_open_an_active_store(self):
        store = InstanceStore(self.path, IDENTITY)
        try:
            probe = subprocess.run([sys.executable, "-c", "from instance_store import InstanceStore; import sys; InstanceStore(sys.argv[1], {'tenantId':'synthetic-a','deploymentId':'test-instance-a'})", self.path],
                                   cwd=Path(__file__).parent, capture_output=True, timeout=10)
            self.assertNotEqual(probe.returncode, 0)
            self.assertIn(b"SEMANTIC_STORE_UNAVAILABLE", probe.stderr)
        finally:
            store.close()

    def test_corrupt_body_rejected_instead_of_empty_recovery(self):
        store = InstanceStore(self.path, IDENTITY); store.save({"model": "A"}); store.close()
        with sqlite3.connect(self.path) as db:
            db.execute("UPDATE snapshot SET body='{}'")
        db.close()
        store = InstanceStore(self.path, IDENTITY)
        try:
            with self.assertRaisesRegex(ValueError, "CHECKSUM_FAILED"):
                store.load()
        finally:
            store.close()

    def test_missing_snapshot_and_unrelated_existing_file_are_not_initialized(self):
        store = InstanceStore(self.path, IDENTITY); store.close()
        store = InstanceStore(self.path, IDENTITY)
        try:
            with self.assertRaisesRegex(ValueError, "SNAPSHOT_MISSING"):
                store.load()
        finally:
            store.close()
        unrelated = Path(self.directory.name) / "unrelated.db"
        unrelated.write_bytes(b"preserve me")
        with self.assertRaises(ValueError):
            InstanceStore(str(unrelated), IDENTITY)
        self.assertEqual(unrelated.read_bytes(), b"preserve me")

    def test_capacity_failure_keeps_previous_committed_snapshot(self):
        store = InstanceStore(self.path, IDENTITY)
        try:
            store.save({"value": 1})
            with patch("instance_store.MAX_SNAPSHOT_BYTES", 20):
                with self.assertRaisesRegex(ValueError, "CAPACITY"):
                    store.save({"value": "x" * 30})
            self.assertEqual(store.load(), {"value": 1})
            self.assertEqual(store.revision, 1)
        finally:
            store.close()


class PersistentServiceTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(app.SEMANTICA_AVAILABLE, "Use the installed Semantica Python environment; do not skip durability tests.")
        self.directory = tempfile.TemporaryDirectory(prefix="semantic-service-")
        self.path = str(Path(self.directory.name) / "state.db")
        app.STORE = None; app.STORAGE_FAILED = False; app.MODEL_DEFINITION = None
        app.reset_demo()
        app.initialize_storage(IDENTITY, {"SEMANTIC_INSTANCE_DB": self.path})

    def tearDown(self):
        if app.STORE:
            app.STORE.close()
        app.STORE = None; app.STORAGE_FAILED = False
        self.directory.cleanup()

    def reopen(self):
        app.STORE.close(); app.STORE = None; app.MODEL_DEFINITION = None; app.reset_demo()
        app.initialize_storage(IDENTITY, {"SEMANTIC_INSTANCE_DB": self.path})

    def test_model_graph_provenance_and_repeated_ingest_survive_restart(self):
        self.assertEqual(app.publish_model_definition({"definition": fixture()})[0], 200)
        self.assertEqual(app.ingest_demo(facts())[0], 200)
        before = json.loads(json.dumps(app.snapshot_state()))
        self.reopen()
        self.assertEqual(json.loads(json.dumps(app.snapshot_state())), before)
        self.assertTrue(app.demo_run_summary("run-a")["validation"]["passed"])
        repeated = app.ingest_demo(facts())
        self.assertEqual(repeated[0], 200); self.assertEqual(repeated[1]["ingestedFacts"], 0)

    def test_reset_is_durable_and_preserves_published_model_contract(self):
        app.publish_model_definition({"definition": fixture()}); app.ingest_demo(facts()); app.reset_demo()
        self.reopen()
        self.assertEqual(app.model_definition_status()["status"], "published")
        self.assertEqual(app.demo_run_summary("run-a")["status"], "not_found")
        self.assertEqual(app.graph_stats()["node_count"], 0)

    def test_disk_failure_rolls_back_memory_and_stops_further_service_writes(self):
        app.publish_model_definition({"definition": fixture()})
        with patch.object(app.STORE, "save", side_effect=sqlite3.OperationalError("synthetic disk full")):
            result = app.ingest_demo(facts())
        self.assertEqual(result[0], 503)
        self.assertTrue(app.STORAGE_FAILED)
        self.assertFalse(app.storage_status()["durable"])
        self.assertEqual(app.FACTS, {})
        self.assertEqual(app.ingest_demo(facts())[0], 503)
        app.STORAGE_FAILED = False; self.reopen()
        self.assertEqual(app.FACTS, {})
        self.assertEqual(app.model_definition_status()["status"], "published")

    def test_conflicting_fact_and_run_ids_are_rejected_without_partial_mutation(self):
        app.ingest_demo(facts())
        before = json.dumps(app.snapshot_state(), sort_keys=True)
        changed = facts(); changed["facts"][0]["status"] = "different"
        self.assertEqual(app.ingest_demo(changed)[0], 409)
        changed = facts(); changed["scenarioId"] = "different"
        self.assertEqual(app.ingest_demo(changed)[0], 409)
        changed = facts(); changed["facts"].append(changed["facts"][0])
        self.assertEqual(app.ingest_demo(changed)[0], 409)
        self.assertEqual(json.dumps(app.snapshot_state(), sort_keys=True), before)

    def test_parallel_mutations_recover_a_consistent_snapshot(self):
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(lambda index: app.ingest_demo(facts(f"run-{index}")), range(12)))
        self.assertTrue(all(result[0] == 200 for result in results))
        self.reopen()
        self.assertEqual(len(app.RUNS), 12); self.assertEqual(len(app.FACTS), 24)
        self.assertTrue(all(app.demo_run_summary(f"run-{index}")["validation"]["passed"] for index in range(12)))

    def test_semantically_invalid_snapshot_is_rejected_even_with_valid_checksum(self):
        invalid = app.snapshot_state(); invalid["records"] = ["missing-fact"]
        app.STORE.save(invalid); app.STORE.close(); app.STORE = None
        with self.assertRaisesRegex(ValueError, "RESTORE_FAILED"):
            app.initialize_storage(IDENTITY, {"SEMANTIC_INSTANCE_DB": self.path})

    def test_production_cannot_silently_use_memory_when_database_is_missing(self):
        for env in [{"NODE_ENV": "production"}, {"SEMANTIC_REQUIRE_DURABLE_STORAGE": "true"}]:
            with self.assertRaisesRegex(ValueError, "DURABLE_STORAGE_REQUIRED"):
                app.initialize_storage(IDENTITY, env)

    def test_storage_failure_returns_http_503_for_reads_and_mutations(self):
        app.STORAGE_FAILED = True
        server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        server.instance_config = {**IDENTITY, "token": "a" * 43}
        thread = Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            for method, path in [("GET", "/instance"), ("GET", "/demo/model-definition"), ("POST", "/demo/reset"), ("POST", "/demo/model-definition/publish")]:
                client = HTTPConnection("127.0.0.1", server.server_address[1])
                client.request(method, path, headers={"Authorization": "Bearer " + "a" * 43, "X-Semantic-Tenant": IDENTITY["tenantId"], "X-Semantic-Deployment": IDENTITY["deploymentId"]})
                response = client.getresponse()
                self.assertEqual(response.status, 503)
                self.assertEqual(json.loads(response.read())["error"], "semantic_storage_unavailable")
                client.close()
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
