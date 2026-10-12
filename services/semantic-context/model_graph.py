"""Bounded synthetic provenance graphs; never a business authorization surface."""
from copy import deepcopy
from datetime import datetime
from hashlib import sha256
import json
import re
import math
import struct
from relationship_projection import preview_relationships


def synthetic_run_fingerprint(value):
    def canonical(item):
        if item is None:
            return ["null"]
        if isinstance(item, bool):
            return ["boolean", item]
        if isinstance(item, (int, float)):
            number = float(item)
            if not math.isfinite(number):
                raise ValueError("invalid_synthetic_proof_number")
            return ["number", struct.pack(">d", 0.0 if number == 0 else number).hex()]
        if isinstance(item, str):
            return ["string", item]
        if isinstance(item, list):
            return ["array", [canonical(value) for value in item]]
        if isinstance(item, dict):
            return ["object", [[key, canonical(item[key])] for key in sorted(item)]]
        raise ValueError("invalid_synthetic_proof_value")
    return sha256(json.dumps(canonical(value), ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()

MAX_RECORDS = 2000
MAX_RUNS = 200
MAX_FACT_BYTES = 2 * 1024 * 1024
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}")


class ModelGraphs:
    def __init__(self, factory):
        self.factory = factory
        self.states = {}

    def snapshot(self):
        return {key: {**deepcopy({name: value for name, value in state.items() if name != "graph"}),
                      "graph": state["graph"].to_dict()} for key, state in self.states.items()}

    def preview_relationships(self, model_id, run_id, definition, tenant_id):
        state = self.states.get(model_id)
        if not state or not definition or state["tenantId"] != tenant_id or state["definition"]["fingerprint"] != definition["fingerprint"]:
            return {"status": "blocked", "code": "relationship_model_binding_conflict", "materialized": False, "runtimeReadEnabled": False}
        return preview_relationships(state, run_id)

    def restore(self, snapshots, definitions, validate_definition, tenant_id=None):
        if not isinstance(snapshots, dict) or len(snapshots) > 31:
            raise ValueError("SEMANTIC_MODEL_GRAPH_INVALID")
        restored = {}
        for model_id, saved in snapshots.items():
            if model_id not in definitions or not isinstance(saved, dict) or set(saved) not in ({"definition", "tenantId", "runs", "facts", "graph"}, {"definition", "tenantId", "runs", "facts", "graph", "projections"}) or not self.factory:
                raise ValueError("SEMANTIC_MODEL_GRAPH_INVALID")
            definition = saved.get("definition")
            if not isinstance(definition, dict):
                raise ValueError("SEMANTIC_MODEL_GRAPH_INVALID")
            normalized, validation = validate_definition(definition)
            digest = sha256(json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()[:20]
            if validation["status"] != "passed" or definition.get("fingerprint") != digest:
                raise ValueError("SEMANTIC_MODEL_GRAPH_INVALID")
            owner = saved.get("tenantId")
            if not isinstance(owner, str) or not IDENTIFIER.fullmatch(owner) or tenant_id and owner != tenant_id:
                raise ValueError("SEMANTIC_MODEL_GRAPH_INVALID")
            runs, facts = saved.get("runs"), saved.get("facts")
            if not isinstance(runs, dict) or not isinstance(facts, dict) or len(runs) > MAX_RUNS or len(facts) > MAX_RECORDS:
                raise ValueError("SEMANTIC_MODEL_GRAPH_INVALID")
            if len(json.dumps({"runs": runs, "facts": facts}, ensure_ascii=False).encode("utf-8")) > MAX_FACT_BYTES:
                raise ValueError("SEMANTIC_MODEL_GRAPH_INVALID")
            referenced = []
            for run_id, run in runs.items():
                if not isinstance(run, dict) or set(run) != {"scenarioId", "businessKey", "expectedSystems", "factIds"} or not isinstance(run.get("factIds"), list) or not isinstance(run_id, str) or not IDENTIFIER.fullmatch(run_id):
                    raise ValueError("SEMANTIC_MODEL_GRAPH_INVALID")
                payload = {"runId": run_id, "scenarioId": run.get("scenarioId"), "businessKey": run.get("businessKey", ""),
                           "expectedSystems": run.get("expectedSystems"), "expectedFingerprint": digest,
                           "facts": [facts.get(key) for key in run["factIds"]]}
                if self.validate(model_id, payload, definition, owner, MAX_RECORDS):
                    raise ValueError("SEMANTIC_MODEL_GRAPH_INVALID")
                referenced.extend(run["factIds"])
            if len(referenced) != len(set(referenced)) or set(referenced) != set(facts) or any(key != fact["id"] for key, fact in facts.items()):
                raise ValueError("SEMANTIC_MODEL_GRAPH_INVALID")
            # Rebuild deterministically from validated facts rather than trusting arbitrary edges.
            state = self.empty(definition, owner)
            for run_id, run in runs.items():
                state["runs"][run_id] = deepcopy(run)
            state["facts"] = deepcopy(facts)
            if "projections" in saved:
                if not isinstance(saved["projections"], dict) or len(saved["projections"]) > MAX_RUNS or not set(saved["projections"]).issubset(runs):
                    raise ValueError("SEMANTIC_MODEL_GRAPH_INVALID")
                state["projections"] = deepcopy(saved["projections"])
            self.rebuild(model_id, state)
            expected = json.dumps(state["graph"].to_dict(), sort_keys=True, ensure_ascii=False)
            actual = json.dumps(saved.get("graph"), sort_keys=True, ensure_ascii=False)
            if expected != actual:
                raise ValueError("SEMANTIC_MODEL_GRAPH_INVALID")
            restored[model_id] = state
        return restored

    def empty(self, definition, tenant_id):
        return {"tenantId": tenant_id, "definition": deepcopy(definition), "facts": {}, "runs": {}, "graph": self.factory()}

    def validate(self, model_id, payload, definition, tenant_id, max_facts=100):
        if not isinstance(payload, dict) or set(payload) - {"runId", "scenarioId", "businessKey", "expectedSystems", "expectedFingerprint", "facts"}:
            return "invalid_graph_contract"
        if payload.get("expectedFingerprint") != definition["fingerprint"]:
            return "model_graph_binding_conflict"
        if any(not isinstance(payload.get(key), str) or not IDENTIFIER.fullmatch(payload[key]) for key in ("runId", "scenarioId")):
            return "invalid_graph_run"
        if not isinstance(payload.get("businessKey", ""), str) or len(payload.get("businessKey", "")) > 120:
            return "invalid_graph_run"
        facts, systems = payload.get("facts"), payload.get("expectedSystems")
        try:
            json.dumps(facts, ensure_ascii=False).encode("utf-8")
        except UnicodeEncodeError:
            return "invalid_graph_facts"
        if not isinstance(facts, list) or not 1 <= len(facts) <= max_facts or not isinstance(systems, list) or not systems or len(systems) > 40 or any(not isinstance(item, str) for item in systems):
            return "invalid_graph_facts"
        types = {item["id"]: item for item in definition["objectTypes"]}
        allowed_systems = {system for item in types.values() for system in item["sourceSystems"]}
        if not set(systems).issubset(allowed_systems):
            return "model_graph_source_undeclared"
        for fact in facts:
            if not isinstance(fact, dict) or set(fact) - {"id", "sourceSystem", "sourceRecordId", "objectType", "eventType", "status", "classification", "occurredAt", "runId", "simulated", "payload", "tenantId", "modelId", "modelVersion", "modelFingerprint", "organizationId", "sourceVersion"}:
                return "invalid_graph_fact"
            # Legacy isolated fixtures omit both fields. Platform transfers must
            # preserve both; accepting only one silently loses provenance.
            if "organizationId" in fact or "sourceVersion" in fact:
                if any(not isinstance(fact.get(key), str) or not fact[key].strip() or len(fact[key]) > 120 or any(ord(char) < 32 or ord(char) == 127 for char in fact[key]) for key in ("organizationId", "sourceVersion")):
                    return "invalid_graph_provenance"
            for key in ("id", "sourceRecordId"):
                if not isinstance(fact.get(key), str) or not IDENTIFIER.fullmatch(fact[key]):
                    return "invalid_graph_fact"
            if any(not isinstance(fact.get(key), str) or not fact[key].strip() or len(fact[key]) > 120 for key in ("sourceSystem", "objectType", "eventType", "status", "classification", "occurredAt")):
                return "invalid_graph_fact"
            if fact.get("simulated") is not True or fact.get("tenantId") != tenant_id or fact.get("modelId") != model_id or fact.get("modelVersion") != definition["version"] or fact.get("modelFingerprint") != definition["fingerprint"] or fact.get("runId") != payload["runId"]:
                return "model_graph_fact_scope"
            try:
                if datetime.fromisoformat(fact["occurredAt"]).utcoffset() is None:
                    return "invalid_graph_fact_time"
            except ValueError:
                return "invalid_graph_fact_time"
            object_type, data = types.get(fact["objectType"]), fact.get("payload")
            if not object_type or fact["sourceSystem"] not in object_type["sourceSystems"]:
                return "model_graph_source_undeclared"
            if not isinstance(data, dict) or set(data) - set(object_type["fields"]) or object_type["key"] not in data or isinstance(data[object_type["key"]], (dict, list, bool)) or data[object_type["key"]] is None or str(data[object_type["key"]]).strip() == "":
                return "model_graph_schema_mismatch"
            if len(str(data[object_type["key"]])) > 120 or any(not isinstance(value, (str, int, float, bool, type(None))) or isinstance(value, str) and len(value) > 2000 or isinstance(value, float) and not math.isfinite(value) for value in data.values()):
                return "model_graph_schema_mismatch"
        return None

    def rebuild(self, model_id, state):
        graph = self.factory()
        definition = state["definition"]
        types = {item["id"]: item for item in definition["objectTypes"]}
        for run_id in sorted(state["runs"]):
            run = state["runs"][run_id]
            scenario = "scenario:" + run_id
            graph.add_node(scenario, "Scenario", run["scenarioId"], tenant_id=state["tenantId"], model_id=model_id, simulated=True)
            for fact_id in sorted(run["factIds"]):
                fact = state["facts"][fact_id]
                record = "record:" + fact_id
                graph.add_node(record, fact["objectType"], fact_id, source_system=fact["sourceSystem"], source_record_id=fact["sourceRecordId"],
                               occurred_at=fact["occurredAt"], classification=fact["classification"], tenant_id=state["tenantId"], model_id=model_id,
                               model_version=definition["version"], model_fingerprint=definition["fingerprint"], run_id=run_id, simulated=True,
                               **({"organization_id": fact["organizationId"], "source_version": fact["sourceVersion"]} if "organizationId" in fact else {}))
                key = types[fact["objectType"]]["key"]
                # Equal strings are not a cross-system entity equivalence proof.
                entity = "entity:" + json.dumps([fact["sourceSystem"], fact["objectType"], key, fact["payload"][key]], separators=(",", ":"))
                graph.add_node(entity, "SourceEntity", str(fact["payload"][key]), source_system=fact["sourceSystem"], model_id=model_id, simulated=True)
                graph.add_edge(scenario, record, "produced_fact", provenance=fact["sourceRecordId"])
                graph.add_edge(record, entity, "describes_source_entity", provenance=fact["sourceRecordId"])
        for run_id, binding in sorted(state.get("projections", {}).items()):
            proof = self.run_proof(model_id, state, run_id)
            candidates = preview_relationships(state, run_id, include_edges=True)
            if candidates["status"] != "preview_passed" or binding != self.projection_binding(state, run_id, proof, candidates):
                raise ValueError("SEMANTIC_MODEL_RELATION_BINDING_INVALID")
            for edge in candidates["_edges"]:
                graph.add_edge("record:" + edge["fromRecord"], "record:" + edge["toRecord"], "semantic:" + edge["predicate"],
                               provenance="declared_field_reference", from_field=edge["fromField"], to_field=edge["toField"],
                               from_type=edge["from"], to_type=edge["to"], tenant_id=state["tenantId"], model_id=model_id,
                               model_version=definition["version"], model_fingerprint=definition["fingerprint"], run_id=run_id,
                               projection_fingerprint=binding["projectionFingerprint"], simulated=True)
        state["graph"] = graph

    def run_proof(self, model_id, state, run_id):
        run = state["runs"][run_id]; definition = state["definition"]
        return synthetic_run_fingerprint({"modelId": model_id, "modelVersion": definition["version"],
            "modelFingerprint": definition["fingerprint"], "runId": run_id, "scenarioId": run["scenarioId"],
            "businessKey": run["businessKey"], "expectedSystems": sorted(run["expectedSystems"]),
            "facts": [state["facts"][key] for key in sorted(run["factIds"])]})

    def projection_binding(self, state, run_id, proof, candidates):
        return {"modelVersion": state["definition"]["version"], "modelFingerprint": state["definition"]["fingerprint"],
                "runProofFingerprint": proof, "projectionFingerprint": synthetic_run_fingerprint({"runId": run_id, "runProof": proof, "edges": candidates["_edges"]})}

    def relationship_summary(self, model_id, run_id, definition, tenant_id):
        receipt = {"modelId": model_id, "runId": run_id, "relationshipProtocol": 1,
                   "projectionScope": "synthetic_relationships", "runtimeReadEnabled": False}
        state = self.states.get(model_id)
        if not state or run_id not in state["runs"]:
            return {**receipt, "status": "not_found"}
        if not definition or state["tenantId"] != tenant_id or state["definition"]["fingerprint"] != definition["fingerprint"]:
            return {**receipt, "status": "stale", "error": "relationship_model_binding_conflict"}
        binding = state.get("projections", {}).get(run_id)
        if binding is None:
            return {**receipt, "status": "not_materialized"}
        candidates = preview_relationships(state, run_id, include_edges=True)
        proof = self.run_proof(model_id, state, run_id)
        if candidates["status"] != "preview_passed" or binding != self.projection_binding(state, run_id, proof, candidates):
            return {**receipt, "status": "stale", "error": "relationship_projection_conflict"}
        return {**receipt, "status": "materialized", "relationshipCount": candidates["candidateEdgeCount"], **binding}

    def materialize_relationships(self, model_id, payload, definition, tenant_id):
        if not isinstance(payload, dict) or set(payload) != {"runId", "expectedFingerprint", "expectedRunProof", "confirmed"} or payload["confirmed"] is not True or not isinstance(payload["runId"], str) or not IDENTIFIER.fullmatch(payload["runId"]):
            return 400, {"status": "blocked", "error": "relationship_confirmation_required"}
        state = self.states.get(model_id)
        if not state or not definition or state["tenantId"] != tenant_id or state["definition"]["fingerprint"] != definition["fingerprint"] or payload["expectedFingerprint"] != definition["fingerprint"] or payload["runId"] not in state["runs"]:
            return 409, {"status": "blocked", "error": "relationship_model_binding_conflict"}
        run_id = payload["runId"]; proof = self.run_proof(model_id, state, run_id)
        if proof != payload["expectedRunProof"]:
            return 409, {"status": "blocked", "error": "relationship_run_proof_conflict"}
        candidates = preview_relationships(state, run_id, include_edges=True)
        if candidates["status"] != "preview_passed":
            return 409, {"status": "blocked", "error": candidates["code"]}
        binding = self.projection_binding(state, run_id, proof, candidates)
        prior = state.get("projections", {}).get(run_id)
        if prior and prior != binding:
            return 409, {"status": "blocked", "error": "relationship_projection_conflict"}
        next_state = {**state, "projections": {**state.get("projections", {}), run_id: binding}}
        self.rebuild(model_id, next_state)
        self.states[model_id] = next_state
        return 200, {**self.relationship_summary(model_id, run_id, definition, tenant_id), "idempotentReplay": bool(prior)}

    def ingest(self, model_id, payload, definition, tenant_id):
        if not self.factory:
            return 503, {"error": "semantica_unavailable"}
        if not definition:
            return 409, {"error": "model_definition_required"}
        error = self.validate(model_id, payload, definition, tenant_id)
        if error:
            return 409 if error.startswith("model_graph_binding") else 400, {"error": error}
        state = self.states.get(model_id)
        if state and (state["definition"]["fingerprint"] != definition["fingerprint"] or state["tenantId"] != tenant_id):
            return 409, {"error": "model_graph_stale"}
        state = state or self.empty(definition, tenant_id)
        ids = [fact["id"] for fact in payload["facts"]]
        if state.get("projections", {}).get(payload["runId"]) and any(key not in state["facts"] for key in ids):
            return 409, {"error": "model_relation_run_frozen"}
        if len(ids) != len(set(ids)) or any(key in state["facts"] and state["facts"][key] != fact for key, fact in zip(ids, payload["facts"])):
            return 409, {"error": "fact_identity_conflict"}
        run_id = payload["runId"]
        existing = state["runs"].get(run_id)
        if existing and any(existing[key] != value for key, value in {"scenarioId": payload["scenarioId"], "expectedSystems": sorted(set(payload["expectedSystems"])), "businessKey": payload.get("businessKey", "")}.items()):
            return 409, {"error": "run_identity_conflict"}
        if len(set(state["facts"]) | set(ids)) > MAX_RECORDS or not existing and len(state["runs"]) >= MAX_RUNS:
            return 409, {"error": "model_graph_capacity"}
        next_state = {**state, "facts": deepcopy(state["facts"]), "runs": deepcopy(state["runs"])}
        run = next_state["runs"].setdefault(run_id, {"scenarioId": payload["scenarioId"], "businessKey": payload.get("businessKey", ""), "expectedSystems": sorted(set(payload["expectedSystems"])), "factIds": []})
        added = 0
        for fact in payload["facts"]:
            if fact["id"] not in next_state["facts"]:
                run["factIds"].append(fact["id"]); added += 1
            next_state["facts"][fact["id"]] = deepcopy(fact)
        if len(json.dumps({"runs": next_state["runs"], "facts": next_state["facts"]}, ensure_ascii=False).encode("utf-8")) > MAX_FACT_BYTES:
            return 409, {"error": "model_graph_capacity"}
        self.rebuild(model_id, next_state)
        self.states[model_id] = next_state
        return 200, {**self.summary(model_id, definition, run_id), "status": "ingested", "ingestedFacts": added}

    def summary(self, model_id, definition, run_id=None):
        state = self.states.get(model_id)
        receipt = {"modelId": model_id, "graphProtocol": 1, "projectionScope": "synthetic_graph", "runtimeReadEnabled": False}
        if state and (not definition or state["definition"]["fingerprint"] != definition["fingerprint"]):
            return {**receipt, "status": "stale", "error": "model_graph_stale"}
        if not state:
            return {**receipt, "status": "not_found" if run_id is not None else "empty", "facts": 0, "runs": 0, "graph": {"node_count": 0, "edge_count": 0}}
        result = {**receipt, "modelVersion": definition["version"], "modelFingerprint": definition["fingerprint"], "facts": len(state["facts"]), "runs": len(state["runs"]), "graph": state["graph"].stats()}
        if run_id is not None:
            run = state["runs"].get(run_id)
            if not run:
                return {**result, "status": "not_found"}
            systems = sorted({state["facts"][key]["sourceSystem"] for key in run["factIds"]})
            result["run"] = {"runId": run_id, "facts": len(run["factIds"]), "systems": systems, "expectedSystems": run["expectedSystems"],
                             "sourcesPresent": set(run["expectedSystems"]).issubset(systems),
                             "proofFingerprint": synthetic_run_fingerprint({"modelId": model_id, "modelVersion": definition["version"],
                                 "modelFingerprint": definition["fingerprint"], "runId": run_id, "scenarioId": run["scenarioId"],
                                 "businessKey": run["businessKey"], "expectedSystems": sorted(run["expectedSystems"]),
                                 "facts": [state["facts"][key] for key in sorted(run["factIds"])]})}
        return {**result, "status": "ready"}

    def reset(self, model_id, payload, definition, tenant_id):
        if not definition or not isinstance(payload, dict) or set(payload) != {"expectedFingerprint"} or payload["expectedFingerprint"] != definition["fingerprint"]:
            return 409, {"error": "model_graph_binding_conflict"}
        if not self.factory:
            return 503, {"error": "semantica_unavailable"}
        self.states[model_id] = self.empty(definition, tenant_id)
        return 200, {**self.summary(model_id, definition), "status": "reset"}
