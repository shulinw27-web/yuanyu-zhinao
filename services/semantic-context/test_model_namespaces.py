"""Isolated synthetic model-definition namespaces; no live service or business I/O."""
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Thread
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from test_model_definition import fixture

spec = importlib.util.spec_from_file_location("namespaced_semantic_app", Path(__file__).with_name("app.py"))
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
IDENTITY = {"tenantId": "synthetic-namespaces", "deploymentId": "synthetic-deployment", "token": "n" * 43}


def publish(model_id, version="v1", expected=None):
    return app.publish_namespaced_model(model_id, {"definition": {**fixture(), "version": version}, "expectedFingerprint": expected})


class NamespaceTests(unittest.TestCase):
    def setUp(self):
        app.STORE = None; app.STORAGE_FAILED = False
        app.MODEL_DEFINITION = None; app.MODEL_DEFINITIONS = {}
        app.reset_demo()

    def tearDown(self):
        if app.STORE:
            app.STORE.close()
        app.STORE = None; app.STORAGE_FAILED = False

    def test_parallel_same_definition_id_and_version_do_not_overwrite(self):
        app.publish_model_definition({"definition": {**fixture(), "version": "default"}})
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda key: publish(key), ["finance", "manufacturing"]))
        self.assertEqual([result[0] for result in results], [200, 200])
        self.assertEqual(app.model_definition_status()["version"], "default")
        first = app.model_definition_status("finance")
        second = app.model_definition_status("manufacturing")
        self.assertEqual(first["fingerprint"], second["fingerprint"])
        self.assertNotEqual(first["modelId"], second["modelId"])
        self.assertFalse(first["runtimeReadEnabled"])
        self.assertEqual(first["projectionScope"], "definition_only")
        self.assertEqual(app.FACTS, {})

    def test_cas_conflicts_and_idempotent_receipt(self):
        publish("finance")
        before = deepcopy(app.snapshot_state())
        self.assertTrue(publish("finance")[1]["idempotentReplay"])
        self.assertEqual(publish("finance", "v2")[0], 409)
        self.assertEqual(app.snapshot_state(), before)
        expected = app.model_definition_status("finance")["fingerprint"]
        self.assertEqual(publish("finance", "v2", expected)[0], 200)
        self.assertEqual(publish("finance", "v3", expected)[0], 409)

    def test_source_fingerprint_cannot_hide_changed_content(self):
        base = {**fixture(), "sourceFingerprint": "same-source"}
        response = app.publish_namespaced_model("finance", {"definition": base, "expectedFingerprint": None})
        changed = {**base, "version": "changed"}
        self.assertEqual(app.publish_namespaced_model("finance", {"definition": changed, "expectedFingerprint": None})[0], 409)
        self.assertEqual(app.publish_namespaced_model("finance", {"definition": changed, "expectedFingerprint": response[1]["deployment"]["fingerprint"]})[0], 200)

    def test_default_source_fingerprint_collision_does_not_acknowledge_old_definition(self):
        base = {**fixture(), "sourceFingerprint": "same-source", "version": "v1"}
        app.publish_model_definition({"definition": base})
        before = deepcopy(app.snapshot_state())
        self.assertTrue(app.publish_model_definition({"definition": base})[1]["idempotentReplay"])
        self.assertEqual(app.publish_model_definition({"definition": {**base, "version": "v2"}})[0], 409)
        self.assertEqual(app.snapshot_state(), before)

    def test_parallel_updates_with_same_expected_fingerprint_have_only_one_winner(self):
        publish("finance")
        expected = app.model_definition_status("finance")["fingerprint"]
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda version: publish("finance", version, expected), ["v2", "v3"]))
        self.assertEqual(sorted(result[0] for result in results), [200, 409])

    def test_invalid_namespace_payload_and_capacity_fail_without_mutation(self):
        for model_id in ["oa-governance", "a", "../finance", "Finance", "x" * 65, None]:
            self.assertEqual(publish(model_id)[0], 400)
        self.assertEqual(app.publish_namespaced_model("finance", {"definition": fixture()})[0], 400)
        self.assertEqual(app.publish_namespaced_model("finance", {"definition": fixture(), "expectedFingerprint": None, "modelId": "other"})[0], 400)
        self.assertEqual(app.publish_namespaced_model("finance", {"definition": {}, "expectedFingerprint": None})[0], 422)
        with patch.object(app, "MAX_MODEL_NAMESPACES", 1):
            self.assertEqual(publish("finance")[0], 200)
            self.assertEqual(publish("manufacturing")[0], 409)
            self.assertEqual(publish("finance")[0], 200)
        self.assertEqual(set(app.MODEL_DEFINITIONS), {"finance"})

    def test_snapshot_restart_and_legacy_snapshot_compatibility(self):
        self.assertTrue(app.SEMANTICA_AVAILABLE, "Use the installed Semantica environment; no skip.")
        with tempfile.TemporaryDirectory(prefix="semantic-model-namespaces-") as directory:
            env = {"SEMANTIC_INSTANCE_DB": str(Path(directory) / "state.db")}
            app.initialize_storage(IDENTITY, env)
            publish("finance"); publish("manufacturing", "v2")
            before = deepcopy(app.snapshot_state())
            app.STORE.close(); app.STORE = None; app.MODEL_DEFINITIONS = {}
            app.initialize_storage(IDENTITY, env)
            self.assertEqual(app.snapshot_state(), before)
            app.STORE.close(); app.STORE = None
            legacy = deepcopy(before); legacy.pop("models")
            app.restore_state(legacy)
            self.assertEqual(app.MODEL_DEFINITIONS, {})

    def test_corrupt_namespace_snapshot_rejected_before_replacing_state(self):
        publish("finance")
        before = deepcopy(app.snapshot_state())
        for models in [None, {"oa-governance": {}}, {"finance": None}, {"finance": {**before["models"]["finance"], "fingerprint": "corrupt"}}]:
            with self.assertRaisesRegex(ValueError, "SNAPSHOT_INVALID"):
                app.restore_state({**before, "models": models})
            self.assertEqual(app.snapshot_state(), before)

    def test_disk_failure_rolls_back_only_attempted_mutation_and_stops_writes(self):
        with tempfile.TemporaryDirectory(prefix="semantic-model-rollback-") as directory:
            app.initialize_storage(IDENTITY, {"SEMANTIC_INSTANCE_DB": str(Path(directory) / "state.db")})
            publish("finance")
            before = deepcopy(app.snapshot_state())
            with patch.object(app.STORE, "save", side_effect=sqlite3.OperationalError("synthetic disk failure")):
                self.assertEqual(publish("manufacturing")[0], 503)
            self.assertEqual(app.snapshot_state(), before)
            self.assertTrue(app.STORAGE_FAILED)
            self.assertEqual(publish("manufacturing")[0], 503)
            app.STORE.close(); app.STORE = None

    def test_http_authenticated_receipts_methods_and_default_isolation(self):
        self.exercise_http(IDENTITY)

    def test_legacy_unauthenticated_instance_cannot_use_namespace_routes(self):
        self.exercise_http(None)

    def exercise_http(self, identity):
        server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        server.instance_config = identity
        thread = Thread(target=server.serve_forever, daemon=True); thread.start()

        def request(method, path, body=None, authenticated=True):
            client = HTTPConnection("127.0.0.1", server.server_address[1])
            headers = {"Authorization": "Bearer " + IDENTITY["token"], "X-Semantic-Tenant": IDENTITY["tenantId"], "X-Semantic-Deployment": IDENTITY["deploymentId"]} if authenticated else {}
            client.request(method, path, body=json.dumps(body) if body else None, headers=headers)
            response = client.getresponse()
            result = response.status, dict(response.getheaders()), json.loads(response.read())
            client.close()
            return result

        try:
            for path in ["instance", "definition", "definition/validate", "definition/publish"]:
                result = request("POST" if "/" in path else "GET", "/models/finance/" + path, {"definition": fixture(), "expectedFingerprint": None}, False)
                self.assertEqual(result[0], 403)
                self.assertNotIn("X-Semantic-Model", result[1])
            if identity is None:
                self.assertEqual(request("POST", "/models/finance/definition/publish", {"definition": fixture(), "expectedFingerprint": None})[0], 403)
                return
            receipt = request("GET", "/models/finance/instance")
            self.assertEqual(receipt[1]["X-Semantic-Model"], "finance")
            self.assertEqual(receipt[1]["X-Semantic-Model-Protocol"], "1")
            for key in ["finance", "manufacturing"]:
                self.assertEqual(request("POST", f"/models/{key}/definition/publish", {"definition": fixture(), "expectedFingerprint": None})[0], 200)
                self.assertEqual(request("GET", f"/models/{key}/definition")[2]["modelId"], key)
            self.assertEqual(request("GET", "/demo/model-definition")[2]["status"], "not_published")
            self.assertEqual(request("POST", "/models/finance/instance", {})[0], 405)
            self.assertEqual(request("GET", "/models/finance/definition/publish")[0], 405)
            for path in ["/models/oa-governance/definition", "/models/Finance/definition", "/models/finance/context", "/models/finance/../manufacturing/definition", "/models/finance%2fmanufacturing/definition"]:
                self.assertEqual(request("GET", path)[0], 400)
            self.assertEqual(request("GET", "/models/absent/definition")[2]["status"], "not_published")
            self.assertEqual(set(app.MODEL_DEFINITIONS), {"finance", "manufacturing"})
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
