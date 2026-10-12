"""Real engine, isolated synthetic records; no running user service is touched."""
import importlib.util
import json
import sqlite3
import tempfile
import subprocess
import sys
import unittest
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch
from http.server import ThreadingHTTPServer
from http.client import HTTPConnection
from threading import Thread
from test_model_definition import fixture

spec = importlib.util.spec_from_file_location("model_graph_app", Path(__file__).with_name("app.py"))
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
IDENTITY = {"tenantId": "synthetic-graphs", "deploymentId": "synthetic-graph-deployment", "token": "g" * 43}


def records(model_id, run_id="same-run", count=2):
    definition = app.MODEL_DEFINITIONS[model_id]
    return {"runId": run_id, "scenarioId": "synthetic-test", "expectedSystems": ["ERP", "QMS"], "expectedFingerprint": definition["fingerprint"],
            "facts": [{"id": f"fact-{index}", "sourceRecordId": f"record-{index}", "objectType": "QualityEvent", "sourceSystem": "ERP" if index % 2 == 0 else "QMS",
                       "eventType": "reported", "status": "open", "classification": "synthetic", "occurredAt": "2026-10-11T00:00:00Z",
                       "runId": run_id, "simulated": True, "tenantId": IDENTITY["tenantId"], "modelId": model_id,
                       "modelVersion": definition["version"], "modelFingerprint": definition["fingerprint"], "payload": {"id": "same-business-id", "status": model_id}} for index in range(count)]}


class ModelGraphTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(app.SEMANTICA_AVAILABLE, "Use the installed engine; no skip.")
        app.STORE = None; app.STORAGE_FAILED = False; app.INSTANCE_IDENTITY = IDENTITY
        app.MODEL_GRAPHS.states = {}; app.MODEL_DEFINITIONS = {}; app.MODEL_DEFINITION = None
        app.reset_demo()
        value = fixture(); value["version"] = "same-version"; value["objectTypes"][0]["sourceSystems"] = ["ERP", "QMS"]
        for model_id in ["finance", "production"]:
            self.assertEqual(app.publish_namespaced_model(model_id, {"definition": value, "expectedFingerprint": None})[0], 200)

    def tearDown(self):
        if app.STORE:
            app.STORE.close()
        app.STORE = None; app.STORAGE_FAILED = False

    def ingest(self, model_id, payload=None):
        return app.ingest_namespaced_graph(model_id, payload or records(model_id), IDENTITY["tenantId"])

    def test_platform_provenance_is_preserved_and_partial_metadata_is_rejected(self):
        payload = records("finance")
        for fact in payload["facts"]:
            fact.update({"organizationId": "synthetic-org", "sourceVersion": "source-v1"})
        self.assertEqual(self.ingest("finance", payload)[0], 200)
        state = app.MODEL_GRAPHS.states["finance"]
        self.assertEqual(state["facts"]["fact-0"]["organizationId"], "synthetic-org")
        record = next(node for node in state["graph"].to_dict()["nodes"] if node["id"] == "record:fact-0")
        self.assertEqual(record["metadata"].get("source_version", record["properties"].get("source_version")), "source-v1")
        for patch in [{"organizationId": ""}, {"sourceVersion": "bad\nversion"}]:
            invalid = records("production")
            invalid["facts"][0].update({"organizationId": "synthetic-org", "sourceVersion": "source-v1", **patch})
            self.assertEqual(self.ingest("production", invalid)[1]["error"], "invalid_graph_provenance")
        invalid = records("production"); invalid["facts"][0]["organizationId"] = "synthetic-org"
        self.assertEqual(self.ingest("production", invalid)[1]["error"], "invalid_graph_provenance")
        self.assertNotIn("production", app.MODEL_GRAPHS.states)
        frozen = app.MODEL_GRAPHS.snapshot()
        app.MODEL_GRAPHS.states = app.MODEL_GRAPHS.restore(frozen, app.MODEL_DEFINITIONS, app.validate_model_definition, IDENTITY["tenantId"])
        self.assertEqual(app.MODEL_GRAPHS.states["finance"]["facts"]["fact-0"]["sourceVersion"], "source-v1")

    def test_cross_runtime_proof_handles_numbers_and_unicode_without_decimal_format_drift(self):
        from model_graph import synthetic_run_fingerprint
        value = {"𐀀": "中文", "\ue000": [1e-7, 1e21, -0.0, None, True]}
        self.assertEqual(synthetic_run_fingerprint(value), "e4e4166fbadb4a7bb8e733af78fabac94ed8b3e8aed50cca3de87b82b21846de")
        invalid = records("production"); invalid["facts"][0]["payload"]["status"] = "\ud800"
        self.assertEqual(self.ingest("production", invalid)[1]["error"], "invalid_graph_facts")

    def test_parallel_same_record_run_and_business_ids_stay_isolated(self):
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(self.ingest, ["finance", "production"]))
        self.assertEqual([result[0] for result in results], [200, 200])
        for model_id in ["finance", "production"]:
            state = app.MODEL_GRAPHS.states[model_id]
            self.assertEqual(state["facts"]["fact-0"]["payload"]["status"], model_id)
            self.assertEqual(len(state["facts"]), 2)
            nodes = state["graph"].to_dict()["nodes"]
            self.assertEqual(len([node for node in nodes if node["type"] == "SourceEntity"]), 2)
            self.assertTrue(all(node["metadata"].get("model_id") == model_id or node["properties"].get("model_id") == model_id for node in nodes))
        self.assertEqual(app.FACTS, {}); self.assertEqual(app.RUNS, {})

    def seed_relation_run(self):
        value = fixture(); value["version"] = "relations-v1"
        value["objectTypes"][0].update({"sourceSystems": ["QMS"], "fields": ["id", "status", "material_id"],
            "fieldDefinitions": [{"name": "material_id", "reference": "RawMaterial", "referenceField": "id"}]})
        value["objectTypes"].append({"id": "RawMaterial", "coreObject": "RawMaterial", "semanticType": "RawMaterial", "key": "id", "fields": ["id"], "sourceSystems": ["ERP"]})
        value["relationshipTypes"] = [{"from": "QualityEvent", "to": "RawMaterial", "predicate": "inspects", "cardinality": "n:1"}]
        expected = app.MODEL_DEFINITIONS["finance"]["fingerprint"]
        self.assertEqual(app.publish_namespaced_model("finance", {"definition": value, "expectedFingerprint": expected})[0], 200)
        payload = records("finance")
        payload["facts"][0].update({"sourceSystem": "QMS", "payload": {"id": "test-1", "material_id": "material-1"}})
        payload["facts"][1].update({"sourceSystem": "ERP", "objectType": "RawMaterial", "payload": {"id": "material-1"}})
        for fact in payload["facts"]:
            fact.update({"organizationId": "synthetic-org", "sourceVersion": "v1"})
        self.assertEqual(self.ingest("finance", payload)[0], 200)
        return payload, app.MODEL_DEFINITIONS["finance"]

    def test_real_graph_relationship_preview_is_bound_and_never_mutates_provenance_edges(self):
        payload, definition = self.seed_relation_run()
        before = app.MODEL_GRAPHS.snapshot(); definition = app.MODEL_DEFINITIONS["finance"]
        result = app.MODEL_GRAPHS.preview_relationships("finance", "same-run", definition, IDENTITY["tenantId"])
        self.assertEqual(result["candidateEdgeCount"], 1); self.assertFalse(result["materialized"])
        self.assertEqual(app.MODEL_GRAPHS.snapshot(), before)
        for model_id, owner, current in [("production", IDENTITY["tenantId"], definition), ("finance", "other", definition), ("finance", IDENTITY["tenantId"], {**definition, "fingerprint": "old"})]:
            self.assertEqual(app.MODEL_GRAPHS.preview_relationships(model_id, "same-run", current, owner)["code"], "relationship_model_binding_conflict")
        restored = app.MODEL_GRAPHS.restore(before, app.MODEL_DEFINITIONS, app.validate_model_definition, IDENTITY["tenantId"])
        self.assertEqual(restored["finance"]["definition"]["objectTypes"][0]["fieldDefinitions"][0]["reference"], "RawMaterial")

    def projection_request(self, definition):
        return {"runId": "same-run", "expectedFingerprint": definition["fingerprint"], "expectedRunProof": app.MODEL_GRAPHS.summary("finance", definition, "same-run")["run"]["proofFingerprint"], "confirmed": True}

    @contextmanager
    def durable_directory(self, prefix):
        with tempfile.TemporaryDirectory(prefix=prefix) as directory:
            try:
                yield directory
            finally:
                if app.STORE:
                    app.STORE.close()
                app.STORE = None

    def test_materialization_requires_confirmation_and_exact_binding_then_is_idempotent_and_frozen(self):
        payload, definition = self.seed_relation_run(); request = self.projection_request(definition); before = deepcopy(app.snapshot_state())
        for patch_value in [{"confirmed": False}, {"runId": []}, {"expectedFingerprint": "old"}, {"expectedRunProof": "old"}, {"edges": ["invented"]}]:
            self.assertGreaterEqual(app.materialize_namespaced_relationships("finance", {**request, **patch_value}, IDENTITY["tenantId"])[0], 400)
            self.assertEqual(app.snapshot_state(), before)
        self.assertEqual(app.materialize_namespaced_relationships("finance", request, "other")[0], 409)
        self.assertEqual(app.materialize_namespaced_relationships("production", request, IDENTITY["tenantId"])[0], 409)
        code, result = app.materialize_namespaced_relationships("finance", request, IDENTITY["tenantId"])
        self.assertEqual(code, 200); self.assertEqual(result["relationshipCount"], 1); self.assertFalse(result["runtimeReadEnabled"])
        projected = deepcopy(app.snapshot_state()); self.assertEqual(projected["version"], 3)
        edges = projected["modelGraphs"]["finance"]["graph"]["edges"]
        self.assertEqual(len([edge for edge in edges if edge["type"] == "semantic:inspects"]), 1)
        self.assertEqual(app.materialize_namespaced_relationships("finance", request, IDENTITY["tenantId"])[1]["idempotentReplay"], True)
        self.assertEqual(app.snapshot_state(), projected)
        additional = deepcopy(payload); additional["facts"] = [{**additional["facts"][0], "id": "new-fact"}]
        self.assertEqual(self.ingest("finance", additional)[1]["error"], "model_relation_run_frozen")
        self.assertEqual(app.snapshot_state(), projected)
        self.assertEqual(self.ingest("finance", payload)[1]["ingestedFacts"], 0)
        self.assertEqual(app.MODEL_GRAPHS.summary("finance", definition, "same-run")["run"]["proofFingerprint"], request["expectedRunProof"])
        unrelated = deepcopy(payload); unrelated["runId"] = "other-run"
        for fact in unrelated["facts"]:
            fact.update(id="other-" + fact["id"], runId="other-run")
        self.assertEqual(self.ingest("finance", unrelated)[0], 200)
        self.assertEqual(app.MODEL_GRAPHS.states["finance"]["projections"]["same-run"], projected["modelGraphs"]["finance"]["projections"]["same-run"])
        self.assertEqual(len([edge for edge in app.MODEL_GRAPHS.states["finance"]["graph"].to_dict()["edges"] if edge["type"] == "semantic:inspects"]), 1)
        changed = deepcopy(definition); changed["version"] = "v2"; changed.pop("fingerprint"); changed.pop("publishedAt")
        self.assertEqual(app.publish_namespaced_model("finance", {"definition": changed, "expectedFingerprint": definition["fingerprint"]})[0], 200)
        self.assertEqual(app.materialize_namespaced_relationships("finance", request, IDENTITY["tenantId"])[0], 409)

    def test_projected_snapshot_rebuild_survives_restart_and_rejects_tampering_and_downgrade(self):
        with self.durable_directory("semantic-relations-restart-") as directory:
            app.initialize_storage(IDENTITY, {"SEMANTIC_INSTANCE_DB": str(Path(directory) / "state.db")})
            payload, definition = self.seed_relation_run(); request = self.projection_request(definition)
            self.assertEqual(app.materialize_namespaced_relationships("finance", request, IDENTITY["tenantId"])[0], 200)
            before = deepcopy(app.snapshot_state()); app.STORE.close(); app.STORE = None
            app.initialize_storage(IDENTITY, {"SEMANTIC_INSTANCE_DB": str(Path(directory) / "state.db")})
            self.assertEqual(app.snapshot_state(), before)
            summary = app.MODEL_GRAPHS.relationship_summary("finance", "same-run", app.MODEL_DEFINITIONS["finance"], IDENTITY["tenantId"])
            self.assertEqual(summary["status"], "materialized")
            self.assertEqual(summary["projectionFingerprint"], before["modelGraphs"]["finance"]["projections"]["same-run"]["projectionFingerprint"])
            for mutate in [lambda state: state.update(version=2),
                           lambda state: state["modelGraphs"]["finance"]["projections"]["same-run"].update(runProofFingerprint="forged"),
                           lambda state: state["modelGraphs"]["finance"]["graph"]["edges"].pop(),
                           lambda state: state["modelGraphs"]["finance"]["projections"].update(foreign={})]:
                invalid = deepcopy(before); mutate(invalid)
                with self.assertRaises(ValueError):
                    app.restore_state(invalid, IDENTITY)
                self.assertEqual(app.snapshot_state(), before)

    def test_failed_projection_commit_rolls_back_all_edges_and_stops_writes(self):
        with self.durable_directory("semantic-relations-failure-") as directory:
            app.initialize_storage(IDENTITY, {"SEMANTIC_INSTANCE_DB": str(Path(directory) / "state.db")})
            payload, definition = self.seed_relation_run(); request = self.projection_request(definition); before = deepcopy(app.snapshot_state())
            with patch.object(app.STORE, "save", side_effect=sqlite3.OperationalError("synthetic disk full")):
                self.assertEqual(app.materialize_namespaced_relationships("finance", request, IDENTITY["tenantId"])[0], 503)
            self.assertEqual(app.snapshot_state(), before); self.assertTrue(app.STORAGE_FAILED)

    def test_wrong_model_tenant_version_and_schema_fail_without_state(self):
        for patch in [{"modelId": "production"}, {"tenantId": "other"}, {"modelVersion": "wrong"}, {"modelFingerprint": "wrong"},
                      {"sourceSystem": "WMS"}, {"objectType": "Missing"}, {"simulated": False}, {"occurredAt": "not-a-time"},
                      {"payload": {"id": "x", "undeclared": "data"}}, {"payload": {"status": "missing-key"}}, {"entities": ["invented"]}, {"payload": {"id": float("nan")}}]:
            payload = records("finance"); payload["facts"][0].update(patch)
            self.assertEqual(self.ingest("finance", payload)[0], 400, patch)
        self.assertEqual(app.MODEL_GRAPHS.states, {})

    def test_duplicate_conflicting_run_and_fact_ids_are_atomic(self):
        self.ingest("finance")
        before = deepcopy(app.snapshot_state())
        repeated = self.ingest("finance")
        self.assertEqual(repeated[1]["ingestedFacts"], 0)
        for mutate in [lambda p: p["facts"][0]["payload"].update(status="changed"), lambda p: p.update(scenarioId="other"), lambda p: p["facts"].append(deepcopy(p["facts"][0]))]:
            payload = records("finance"); mutate(payload)
            self.assertEqual(self.ingest("finance", payload)[0], 409)
        self.assertEqual(app.snapshot_state(), before)

    def test_capacities_and_disabled_ingest_do_not_mutate(self):
        with patch("model_graph.MAX_RECORDS", 1):
            self.assertEqual(self.ingest("finance")[0], 409)
        with patch("model_graph.MAX_FACT_BYTES", 5):
            self.assertEqual(self.ingest("finance")[0], 409)
        with patch.dict("os.environ", {"SEMANTIC_DEMO_INGEST_ENABLED": "false"}):
            self.assertEqual(self.ingest("finance")[0], 403)
        self.assertEqual(app.MODEL_GRAPHS.states, {})

    def test_model_changes_mark_graph_stale_until_explicit_version_bound_reset(self):
        self.ingest("finance"); self.ingest("production")
        definition = deepcopy(app.MODEL_DEFINITIONS["finance"])
        old_fingerprint = definition["fingerprint"]; definition["version"] = "v2"
        app.publish_namespaced_model("finance", {"definition": definition, "expectedFingerprint": old_fingerprint})
        self.assertEqual(app.MODEL_GRAPHS.summary("finance", app.MODEL_DEFINITIONS["finance"])["status"], "stale")
        self.assertEqual(self.ingest("finance")[0], 409)
        self.assertEqual(app.reset_namespaced_graph("finance", {"expectedFingerprint": old_fingerprint}, IDENTITY["tenantId"])[0], 409)
        self.assertEqual(app.reset_namespaced_graph("finance", {"expectedFingerprint": app.MODEL_DEFINITIONS["finance"]["fingerprint"]}, IDENTITY["tenantId"])[0], 200)
        self.assertEqual(app.MODEL_GRAPHS.summary("production", app.MODEL_DEFINITIONS["production"])["facts"], 2)
        self.assertEqual(self.ingest("finance")[0], 200)

    def test_default_reset_never_erases_namespace_graphs(self):
        self.ingest("finance"); before = deepcopy(app.MODEL_GRAPHS.snapshot())
        app.reset_demo()
        self.assertEqual(app.MODEL_GRAPHS.snapshot(), before)

    def test_graph_snapshots_use_new_version_so_old_services_cannot_drop_graphs_on_write(self):
        self.assertEqual(app.snapshot_state()["version"], 1)
        self.ingest("finance"); before = deepcopy(app.snapshot_state())
        self.assertEqual(before["version"], 2)
        with self.assertRaisesRegex(ValueError, "SNAPSHOT_INVALID"):
            app.restore_state({**before, "version": 1}, IDENTITY)
        self.assertEqual(app.snapshot_state(), before)

    def test_snapshot_restart_preserves_graphs_and_large_runs_across_batches(self):
        with tempfile.TemporaryDirectory(prefix="semantic-model-graphs-") as directory:
            env = {"SEMANTIC_INSTANCE_DB": str(Path(directory) / "state.db")}
            app.initialize_storage(IDENTITY, env)
            self.ingest("finance", records("finance", count=100))
            extra = records("finance", count=2)
            for index, fact in enumerate(extra["facts"]):
                fact["id"] = f"extra-{index}"; fact["sourceRecordId"] = f"extra-record-{index}"
            self.assertEqual(self.ingest("finance", extra)[0], 200)
            self.ingest("production")
            before = deepcopy(app.snapshot_state())
            app.STORE.close(); app.STORE = None; app.MODEL_GRAPHS.states = {}
            app.initialize_storage(IDENTITY, env)
            self.assertEqual(app.snapshot_state(), before)
            app.STORE.close(); app.STORE = None

    def test_corrupt_binding_records_owner_and_edges_rejected_before_replacing_any_state(self):
        self.ingest("finance"); before = deepcopy(app.snapshot_state())
        changes = [lambda s: s["modelGraphs"]["finance"].update(tenantId="other"),
                   lambda s: s["modelGraphs"]["finance"]["facts"]["fact-0"].update(modelId="production"),
                   lambda s: s["modelGraphs"]["finance"]["graph"]["edges"].append({"source": "record:fact-0", "target": "foreign", "type": "invented"}),
                   lambda s: s["modelGraphs"]["finance"]["definition"].update(fingerprint="wrong")]
        for mutate in changes:
            value = deepcopy(before); mutate(value)
            with self.assertRaises(ValueError):
                app.restore_state(value, IDENTITY)
            self.assertEqual(app.snapshot_state(), before)

    def test_failed_commit_rolls_back_namespace_and_stops_all_writes(self):
        with tempfile.TemporaryDirectory(prefix="semantic-model-graph-failure-") as directory:
            app.initialize_storage(IDENTITY, {"SEMANTIC_INSTANCE_DB": str(Path(directory) / "state.db")})
            self.ingest("finance"); before = deepcopy(app.snapshot_state())
            with patch.object(app.STORE, "save", side_effect=sqlite3.OperationalError("synthetic disk full")):
                self.assertEqual(self.ingest("production")[0], 503)
            self.assertEqual(app.snapshot_state(), before)
            self.assertTrue(app.STORAGE_FAILED)
            self.assertEqual(self.ingest("production")[0], 503)
            app.STORE.close(); app.STORE = None

    def test_offline_verify_rejects_consistent_foreign_graph_inside_an_owned_database(self):
        with tempfile.TemporaryDirectory(prefix="semantic-graph-owner-") as directory:
            path = Path(directory) / "state.db"
            config = Path(directory) / "instance.json"
            config.write_text(json.dumps({"version": 1, **IDENTITY}), encoding="utf-8")
            app.initialize_storage(IDENTITY, {"SEMANTIC_INSTANCE_DB": str(path)})
            payload = records("finance")
            for fact in payload["facts"]:
                fact["tenantId"] = "foreign-tenant"
            # A valid checksum and internally consistent graph still do not prove owner identity.
            app.MODEL_GRAPHS.ingest("finance", payload, app.MODEL_DEFINITIONS["finance"], "foreign-tenant")
            app.STORE.save(app.snapshot_state()); app.STORE.close(); app.STORE = None
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("manage_instance_store.py")), "verify", "--config", str(config), "--source", str(path)], capture_output=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"SEMANTIC_OFFLINE_OPERATION_REJECTED", result.stderr)

    def test_http_graph_routes_require_identity_and_return_only_scoped_summary(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler); server.instance_config = IDENTITY
        thread = Thread(target=server.serve_forever, daemon=True); thread.start()
        def request(method, path, payload=None, authenticated=True):
            client = HTTPConnection("127.0.0.1", server.server_address[1])
            headers = {"Authorization": "Bearer " + IDENTITY["token"], "X-Semantic-Tenant": IDENTITY["tenantId"], "X-Semantic-Deployment": IDENTITY["deploymentId"]} if authenticated else {}
            client.request(method, path, json.dumps(payload) if payload else None, headers)
            response = client.getresponse(); result = response.status, dict(response.getheaders()), json.loads(response.read()); client.close()
            return result
        try:
            for path, method in [("graph", "GET"), ("graph/runs/same-run", "GET"), ("graph/ingest", "POST"), ("graph/reset", "POST")]:
                self.assertEqual(request(method, "/models/finance/" + path, records("finance"), False)[0], 403)
            self.assertEqual(request("POST", "/models/finance/graph/ingest", records("finance"))[0], 200)
            summary = request("GET", "/models/finance/graph/runs/same-run")
            self.assertEqual(summary[1]["X-Semantic-Graph-Protocol"], "1")
            self.assertEqual(summary[2]["run"]["facts"], 2)
            self.assertNotIn("payload", json.dumps(summary[2])); self.assertFalse(summary[2]["runtimeReadEnabled"])
            self.assertEqual(request("GET", "/models/production/graph")[2]["facts"], 0)
            self.assertEqual(request("GET", "/models/production/graph/runs/same-run")[0], 404)
            self.assertEqual(request("GET", "/models/finance/graph/runs/missing")[0], 404)
            self.assertEqual(request("POST", "/models/finance/graph")[0], 405)
        finally:
            server.shutdown(); server.server_close(); thread.join()


    def test_authenticated_http_relationship_protocol_confirms_and_only_reads_bound_proofs(self):
        payload, definition = self.seed_relation_run(); request_body = self.projection_request(definition)
        server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler); server.instance_config = IDENTITY
        thread = Thread(target=server.serve_forever, daemon=True); thread.start()
        def request(method, path, body=None, override=None):
            headers = {"Authorization": "Bearer " + IDENTITY["token"], "X-Semantic-Tenant": IDENTITY["tenantId"], "X-Semantic-Deployment": IDENTITY["deploymentId"], **(override or {})}
            client = HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            try:
                client.request(method, path, json.dumps(body) if body is not None else None, headers)
                response = client.getresponse()
                return response.status, dict(response.getheaders()), json.loads(response.read())
            finally:
                client.close()
        write = "/models/finance/graph/relationships/materialize"
        read = "/models/finance/graph/relationships/runs/same-run"
        before = deepcopy(app.snapshot_state())
        try:
            for override in [{"Authorization": "Bearer invalid"}, {"X-Semantic-Tenant": "other"}, {"X-Semantic-Deployment": "other"}]:
                self.assertEqual(request("POST", write, request_body, override)[0], 403)
                self.assertEqual(request("GET", read, override=override)[0], 403)
                self.assertEqual(app.snapshot_state(), before)
            self.assertEqual(request("GET", read)[2]["status"], "not_materialized")
            self.assertEqual(request("GET", write)[0], 405)
            self.assertEqual(request("POST", read, request_body)[0], 405)
            for patch_value in [{"confirmed": False}, {"expectedRunProof": "forged"}, {"expectedFingerprint": "old"}, {"modelId": "production"}]:
                self.assertGreaterEqual(request("POST", write, {**request_body, **patch_value})[0], 400)
                self.assertEqual(app.snapshot_state(), before)
            self.assertEqual(request("POST", write.replace("finance", "production"), request_body)[0], 409)
            code, headers, result = request("POST", write, request_body)
            self.assertEqual(code, 200); self.assertEqual(headers["X-Semantic-Relationship-Protocol"], "1")
            self.assertEqual(result["relationshipProtocol"], 1); self.assertFalse(result["runtimeReadEnabled"])
            frozen = deepcopy(app.snapshot_state())
            self.assertTrue(request("POST", write, request_body)[2]["idempotentReplay"])
            read_result = request("GET", read)[2]
            self.assertEqual(read_result["projectionFingerprint"], result["projectionFingerprint"])
            self.assertEqual(read_result["runProofFingerprint"], request_body["expectedRunProof"])
            self.assertNotIn("payload", json.dumps(read_result)); self.assertNotIn("material-1", json.dumps(read_result))
            self.assertEqual(request("GET", read.replace("finance", "production"))[0], 404)
            self.assertEqual(request("GET", read.replace("same-run", "missing"))[0], 404)
            self.assertEqual(app.snapshot_state(), frozen)
            with patch.dict("os.environ", {"SEMANTIC_DEMO_INGEST_ENABLED": "false"}):
                self.assertEqual(request("POST", write, request_body)[0], 403)
                self.assertEqual(request("GET", read)[0], 200)
            self.assertEqual(app.snapshot_state(), frozen)
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
