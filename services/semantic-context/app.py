"""Local Semantica boundary for the 元域智脑 Demo.

The platform API remains responsible for identity, authorization and data
minimisation. This service only accepts server-produced, synthetic Demo facts
on localhost and turns them into a provenance-preserving ContextGraph.
"""
from __future__ import annotations

from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import RLock
from functools import wraps
from copy import deepcopy
from urllib.parse import unquote, urlparse
from hashlib import sha256
from hmac import compare_digest
from pathlib import Path
import json
import os
import re
from instance_store import InstanceStore
from model_graph import ModelGraphs

try:
    from semantica.context import ContextGraph
    SEMANTICA_AVAILABLE = True
except Exception:
    ContextGraph = None
    SEMANTICA_AVAILABLE = False


ENTITY_KEYS = {
    "materialBatchId", "productionBatchId", "finishedGoodsBatchId", "batchId",
    "sku", "orderId", "storeId", "supplierId", "equipmentId", "eventId",
    "capaId", "purchaseOrderId", "fulfillmentId", "subject", "approvalId",
}
MAX_FACTS_PER_REQUEST = 100
MAX_BODY_BYTES = 512 * 1024
GRAPH_LOCK = RLock()
STORE = None
STORAGE_FAILED = False
GRAPH = ContextGraph() if SEMANTICA_AVAILABLE else None
INGESTED_RECORD_IDS: set[str] = set()
INGESTED_EDGES: set[tuple[str, str, str]] = set()
RUNS: dict[str, dict] = {}
FACTS: dict[str, dict] = {}
MODEL_DEFINITION: dict | None = None
MODEL_DEFINITIONS: dict[str, dict] = {}
MODEL_GRAPHS = ModelGraphs(ContextGraph if SEMANTICA_AVAILABLE else None)
INSTANCE_IDENTITY = None
MAX_MODEL_NAMESPACES = 31  # Plus the backwards-compatible default workspace.


def valid_model_namespace(value):
    return isinstance(value, str) and value != "oa-governance" and re.fullmatch(r"[a-z][a-z0-9-]{1,63}", value) is not None


CORE_META_OBJECTS = {"Person", "RawMaterial", "Product", "Equipment", "Store"}

SEMANTIC_TYPE_CATALOG = {
    "TestResult": {"label": "检验结果", "coreObject": "RawMaterial", "description": "检验样本、项目与判定结果。"},
    "QualityEvent": {"label": "质量事件", "coreObject": "RawMaterial", "description": "偏差、OOS、放行约束与质量处置。"},
    "ProductionBatch": {"label": "生产批次", "coreObject": "Product", "description": "生产批次状态、物料消耗与成品批次影响。"},
    "Inventory": {"label": "库存", "coreObject": "RawMaterial", "description": "可用库存、安全库存和替代库存风险。"},
    "Fulfillment": {"label": "履约", "coreObject": "Store", "description": "订单履约、配送异常与门店影响。"},
    "ApprovalInstance": {"label": "审批实例", "coreObject": "Person", "description": "OA 审批状态及受控业务动作的人工确认。"},
    "CAPA": {"label": "纠正预防措施", "coreObject": "Product", "description": "质量处置写回形成的 CAPA 草稿与闭环状态。"},
}


def read_instance_configuration(env=None):
    """Trusted startup configuration, fixed for the lifetime of this process."""
    env = os.environ if env is None else env
    location = env.get("SEMANTIC_INSTANCE_CONFIG_FILE")
    required = env.get("SEMANTIC_REQUIRE_INSTANCE_AUTH") == "true" or env.get("NODE_ENV") == "production"
    if not location:
        if required:
            raise ValueError("SEMANTIC_INSTANCE_CONFIG_REQUIRED")
        return None  # Backwards-compatible, synthetic-only local Demo.
    try:
        path = Path(location)
        if not path.is_absolute() or path.stat().st_size > 16 * 1024:
            raise ValueError()
        value = json.loads(path.read_text(encoding="utf-8-sig"))
        if value.get("version") != 1:
            raise ValueError()
        for key in ("tenantId", "deploymentId"):
            if not isinstance(value.get(key), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}", value[key]):
                raise ValueError()
        if not isinstance(value.get("token"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", value["token"]):
            raise ValueError()
        return {key: value[key] for key in ("tenantId", "deploymentId", "token")}
    except Exception:
        raise ValueError("SEMANTIC_INSTANCE_CONFIG_INVALID") from None


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def snapshot_state():
    return {"version": 3 if any(state.get("projections") for state in MODEL_GRAPHS.states.values()) else 2 if MODEL_GRAPHS.states else 1, "graph": GRAPH.to_dict() if GRAPH is not None else None,
            "records": sorted(INGESTED_RECORD_IDS), "edges": sorted(INGESTED_EDGES),
            "runs": RUNS, "facts": FACTS, "model": MODEL_DEFINITION, "models": MODEL_DEFINITIONS,
            "modelGraphs": MODEL_GRAPHS.snapshot()}


def restore_state(value, identity=None):
    """Validate before replacing globals; invalid stored data must not become an empty graph."""
    global GRAPH, RUNS, FACTS, MODEL_DEFINITION, MODEL_DEFINITIONS, INGESTED_RECORD_IDS, INGESTED_EDGES
    if not isinstance(value, dict) or value.get("version") not in (1, 2, 3) or not isinstance(value.get("runs"), dict) or not isinstance(value.get("facts"), dict):
        raise ValueError("SEMANTIC_SNAPSHOT_INVALID")
    if not isinstance(value.get("modelGraphs", {}), dict) or (value["version"] != 1) != bool(value.get("modelGraphs")) or (value["version"] == 3) != any(state.get("projections") for state in value.get("modelGraphs", {}).values() if isinstance(state, dict)):
        raise ValueError("SEMANTIC_SNAPSHOT_INVALID")
    records = value.get("records")
    edges = value.get("edges")
    if not isinstance(records, list) or any(not isinstance(item, str) for item in records) or set(records) != set(value["facts"]) or len(records) != len(set(records)):
        raise ValueError("SEMANTIC_SNAPSHOT_INVALID")
    if not isinstance(edges, list) or any(not isinstance(item, (list, tuple)) or len(item) != 3 or any(not isinstance(part, str) for part in item) for item in edges):
        raise ValueError("SEMANTIC_SNAPSHOT_INVALID")
    run_fact_ids = []
    for run_id, run in value["runs"].items():
        if not isinstance(run, dict) or run.get("runId") != run_id or not isinstance(run.get("factIds"), list):
            raise ValueError("SEMANTIC_SNAPSHOT_INVALID")
        for fact_id in run["factIds"]:
            fact = value["facts"].get(fact_id)
            if validate_fact(fact, run_id) or fact.get("id") != fact_id:
                raise ValueError("SEMANTIC_SNAPSHOT_INVALID")
            run_fact_ids.append(fact_id)
    if set(run_fact_ids) != set(records) or len(run_fact_ids) != len(records):
        raise ValueError("SEMANTIC_SNAPSHOT_INVALID")
    model = value.get("model")
    models = value.get("models", {})  # Existing version-1 snapshots require no migration.
    if not isinstance(models, dict) or len(models) > MAX_MODEL_NAMESPACES or any(not valid_model_namespace(key) or not isinstance(item, dict) for key, item in models.items()):
        raise ValueError("SEMANTIC_SNAPSHOT_INVALID")
    for candidate in [model, *models.values()]:
        if candidate is None:
            continue
        if not isinstance(candidate, dict):
            raise ValueError("SEMANTIC_SNAPSHOT_INVALID")
        normalized, validation = validate_model_definition(candidate)
        if validation["status"] != "passed" or not candidate.get("publishedAt"):
            raise ValueError("SEMANTIC_SNAPSHOT_INVALID")
        serialized = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if candidate.get("fingerprint") != sha256(serialized.encode("utf-8")).hexdigest()[:20]:
            raise ValueError("SEMANTIC_SNAPSHOT_INVALID")
    owner = identity or INSTANCE_IDENTITY
    model_graphs = MODEL_GRAPHS.restore(value.get("modelGraphs", {}), models, validate_model_definition, owner.get("tenantId") if owner else None)
    graph = None
    if value.get("graph") is not None:
        if not SEMANTICA_AVAILABLE:
            raise ValueError("SEMANTICA_RESTORE_REQUIRES_ENGINE")
        data = value["graph"]
        nodes = data["nodes"]; links = data["edges"]
        ids = {node["id"] for node in nodes}
        if len(ids) != len(nodes) or any(link["source"] not in ids or link["target"] not in ids for link in links):
            raise ValueError("SEMANTIC_SNAPSHOT_INVALID")
        if any(f"record:{item}" not in ids for item in records) or any(f"scenario:{item}" not in ids for item in value["runs"]):
            raise ValueError("SEMANTIC_SNAPSHOT_INVALID")
        graph = ContextGraph()
        graph.from_dict(data)
    elif records or value["runs"]:
        raise ValueError("SEMANTIC_SNAPSHOT_INVALID")
    GRAPH = graph
    RUNS = deepcopy(value["runs"]); FACTS = deepcopy(value["facts"]); MODEL_DEFINITION = deepcopy(model)
    MODEL_DEFINITIONS = deepcopy(models)
    MODEL_GRAPHS.states = model_graphs
    INGESTED_RECORD_IDS = set(records); INGESTED_EDGES = {tuple(item) for item in edges}


def initialize_storage(identity, env=None):
    global STORE, INSTANCE_IDENTITY
    INSTANCE_IDENTITY = identity
    env = os.environ if env is None else env
    location = env.get("SEMANTIC_INSTANCE_DB")
    if not location:
        if env.get("NODE_ENV") == "production" or env.get("SEMANTIC_REQUIRE_DURABLE_STORAGE") == "true":
            raise ValueError("SEMANTIC_DURABLE_STORAGE_REQUIRED")
        return
    if not SEMANTICA_AVAILABLE:
        raise ValueError("SEMANTICA_RESTORE_REQUIRES_ENGINE")
    store = InstanceStore(location, identity)
    try:
        snapshot = store.load()
        if snapshot is not None:
            restore_state(snapshot, identity)
        else:
            store.save(snapshot_state())
    except Exception:
        store.close()
        raise ValueError("SEMANTIC_STORE_RESTORE_FAILED") from None
    STORE = store


def storage_status():
    return {"storage": "sqlite-snapshot" if STORE else "process-memory", "durable": STORE is not None and not STORAGE_FAILED,
            "storageStatus": "failed" if STORAGE_FAILED else "ready", "revision": STORE.revision if STORE else None}


def durable_mutation(work):
    @wraps(work)
    def perform(*args, **kwargs):
        global STORAGE_FAILED
        with GRAPH_LOCK:
            if STORE is None:
                return work(*args, **kwargs)
            before = None
            try:
                if STORAGE_FAILED:
                    raise ValueError("storage failed")
                before = deepcopy(snapshot_state())
                result = work(*args, **kwargs)
                if not isinstance(result, tuple) or result[0] < 400:
                    STORE.save(snapshot_state())
                return result
            except Exception:
                # A disk error can have an uncertain commit outcome. Stop serving until restart.
                STORAGE_FAILED = True
                if before is not None:
                    restore_state(before)
                failure = {"error": "semantic_storage_unavailable", "status": "unavailable", "message": "语义存储提交失败；实例已停止读写，请检查存储并重启恢复。"}
                return failure if work.__name__ == "reset_demo" else (503, failure)
    return perform


def graph_stats() -> dict:
    if not SEMANTICA_AVAILABLE or GRAPH is None:
        return {"node_count": 0, "edge_count": 0}
    return GRAPH.stats()


def build_context(role_id: str) -> dict:
    return {
        "service": "semantic-context-service",
        "status": "healthy",
        "engine": "semantica" if SEMANTICA_AVAILABLE else "projection-fallback",
        "role": role_id,
        "time": timestamp(),
        "graph": graph_stats(),
        "boundary": "The platform API enforces identity, policy and data minimisation before this localhost Demo boundary.",
    }


def entity_values(fact: dict) -> list[str]:
    supplied = fact.get("entities")
    if isinstance(supplied, list):
        return sorted({str(value) for value in supplied if value})
    payload = fact.get("payload") or {}
    return sorted({str(value) for key, value in payload.items() if key in ENTITY_KEYS and value})


def validate_fact(fact: object, run_id: str) -> str | None:
    if not isinstance(fact, dict):
        return "事实必须是对象。"
    required = ("id", "sourceSystem", "sourceRecordId", "objectType", "eventType", "status", "classification", "occurredAt")
    missing = [key for key in required if not isinstance(fact.get(key), str) or not fact[key].strip()]
    if missing:
        return f"事实缺少受控溯源字段：{', '.join(missing)}。"
    if fact.get("simulated") is not True:
        return "仅允许写入 simulated=true 的 Demo 事实。"
    if fact.get("runId") != run_id:
        return "事实 runId 与请求 runId 不一致。"
    if not isinstance(fact.get("payload", {}), dict):
        return "事实 payload 必须是对象。"
    return None


def add_edge_once(source: str, target: str, predicate: str, provenance: str) -> None:
    marker = (source, target, predicate)
    if marker not in INGESTED_EDGES:
        GRAPH.add_edge(source, target, predicate, provenance=provenance)
        INGESTED_EDGES.add(marker)


def fact_content(fact: dict) -> str:
    details = "；".join(f"{key}={value}" for key, value in fact.get("payload", {}).items() if value is not None)
    return f"{fact['sourceSystem']} {fact['objectType']} {fact['eventType']} {fact['status']}；{details}"


@durable_mutation
def ingest_demo(payload: dict) -> tuple[int, dict]:
    if not SEMANTICA_AVAILABLE or GRAPH is None:
        return 503, {"error": "semantica_unavailable", "message": "本机 Semantica 依赖不可用，未将事实写入语义图。"}
    if os.environ.get("SEMANTIC_DEMO_INGEST_ENABLED", "true").lower() not in {"1", "true", "yes"}:
        return 403, {"error": "demo_ingest_disabled", "message": "Semantica Demo 写入开关未启用。"}
    run_id = payload.get("runId")
    scenario_id = payload.get("scenarioId")
    facts = payload.get("facts")
    expected_systems = payload.get("expectedSystems", [])
    if not isinstance(run_id, str) or not run_id or not isinstance(scenario_id, str) or not scenario_id:
        return 400, {"error": "invalid_demo_run", "message": "runId 和 scenarioId 为必填项。"}
    if not isinstance(facts, list) or not facts or len(facts) > MAX_FACTS_PER_REQUEST:
        return 400, {"error": "invalid_facts", "message": f"facts 必须为 1 至 {MAX_FACTS_PER_REQUEST} 条。"}
    if not isinstance(expected_systems, list) or not all(isinstance(item, str) for item in expected_systems):
        return 400, {"error": "invalid_expected_systems", "message": "expectedSystems 必须为系统编码数组。"}
    for fact in facts:
        error = validate_fact(fact, run_id)
        if error:
            return 400, {"error": "invalid_fact", "message": error}

    with GRAPH_LOCK:
        fact_ids = [fact["id"] for fact in facts]
        if len(set(fact_ids)) != len(fact_ids) or any(fact["id"] in FACTS and FACTS[fact["id"]] != fact for fact in facts):
            return 409, {"error": "fact_identity_conflict", "message": "事实标识重复或与已接收内容冲突，未写入。"}
        existing_run = RUNS.get(run_id)
        if existing_run and (existing_run["scenarioId"] != scenario_id or existing_run["businessKey"] != payload.get("businessKey", "") or existing_run["expectedSystems"] != sorted(set(expected_systems))):
            return 409, {"error": "run_identity_conflict", "message": "场景标识与已接收内容冲突，未写入。"}
        scenario_node = f"scenario:{run_id}"
        if run_id not in RUNS:
            GRAPH.add_node(
                scenario_node, "Scenario", f"{scenario_id}；业务标识={payload.get('businessKey', '')}",
                source="Mock Runtime", scenario_id=scenario_id, run_id=run_id,
                business_key=payload.get("businessKey", ""), classification="演练数据", simulated=True,
            )
            RUNS[run_id] = {"runId": run_id, "scenarioId": scenario_id, "businessKey": payload.get("businessKey", ""), "factIds": [], "expectedSystems": sorted(set(expected_systems)), "ingestedAt": timestamp()}
        added = 0
        for fact in facts:
            record_node = f"record:{fact['id']}"
            if fact["id"] not in INGESTED_RECORD_IDS:
                GRAPH.add_node(
                    record_node, fact["objectType"], fact_content(fact),
                    source_system=fact["sourceSystem"], source_record_id=fact["sourceRecordId"],
                    occurred_at=fact["occurredAt"], classification=fact["classification"],
                    event_type=fact["eventType"], status=fact["status"], run_id=run_id, simulated=True,
                    **model_annotation(fact["objectType"]),
                )
                INGESTED_RECORD_IDS.add(fact["id"])
                RUNS[run_id]["factIds"].append(fact["id"])
                added += 1
            # Keep only canonical Demo facts for modelling discovery. This is
            # not a general data cache and is cleared together with the graph.
            FACTS[fact["id"]] = fact
            add_edge_once(scenario_node, record_node, "produced_fact", fact["sourceRecordId"])
            for value in entity_values(fact):
                entity_node = f"entity:{value}"
                GRAPH.add_node(entity_node, "BusinessEntity", value, entity_id=value, simulated=True)
                add_edge_once(entity_node, record_node, "referenced_by", fact["sourceRecordId"])
                add_edge_once(record_node, entity_node, "affects_entity", fact["sourceRecordId"])
        RUNS[run_id]["lastValidatedAt"] = timestamp()
        summary = demo_run_summary(run_id)
    return 200, {"engine": "semantica", "status": "verified", "ingestedFacts": added, "run": summary, "graph": graph_stats(), "validation": summary["validation"]}


def demo_run_summary(run_id: str) -> dict:
    run = RUNS.get(run_id)
    if not run:
        return {"runId": run_id, "status": "not_found"}
    fact_ids = set(run["factIds"])
    systems = set()
    complete_provenance = True
    for fact_id in fact_ids:
        attrs = GRAPH.get_node_attributes(f"record:{fact_id}")
        systems.add(attrs.get("source_system"))
        complete_provenance = complete_provenance and all(attrs.get(field) for field in ("source_system", "source_record_id", "occurred_at", "classification"))
    systems.discard(None)
    expected = set(run.get("expectedSystems", []))
    validation = {
        "facts_have_provenance": complete_provenance,
        "expected_systems_present": expected.issubset(systems),
        "cross_system_context_built": len(systems) >= 2,
        "all_facts_simulated": True,
        "passed": complete_provenance and expected.issubset(systems) and len(systems) >= 2,
    }
    return {
        "runId": run_id, "scenarioId": run["scenarioId"], "businessKey": run["businessKey"],
        "facts": len(fact_ids), "systems": sorted(systems), "expectedSystems": sorted(expected),
        "validatedAt": run.get("lastValidatedAt"), "validation": validation,
    }


@durable_mutation
def reset_demo() -> dict:
    global GRAPH
    with GRAPH_LOCK:
        GRAPH = ContextGraph() if SEMANTICA_AVAILABLE else None
        INGESTED_RECORD_IDS.clear()
        INGESTED_EDGES.clear()
        RUNS.clear()
        FACTS.clear()
    return {"status": "reset", "engine": "semantica" if SEMANTICA_AVAILABLE else "projection-fallback", "graph": graph_stats()}


def model_annotation(object_type: str) -> dict:
    if not MODEL_DEFINITION:
        return {"model_binding": "unconfigured"}
    definition = next((item for item in MODEL_DEFINITION["objectTypes"] if item["id"] == object_type or item.get("semanticType") == object_type), None)
    if not definition:
        return {"model_binding": "unmapped", "model_version": MODEL_DEFINITION["version"]}
    return {"model_binding": "mapped", "model_id": MODEL_DEFINITION["id"], "model_version": MODEL_DEFINITION["version"], "semantic_type": definition["semanticType"], "core_object": definition["coreObject"]}


def validate_model_definition(definition: object) -> tuple[dict | None, dict]:
    if not isinstance(definition, dict):
        return None, {"status": "failed", "checks": [{"name": "模型结构", "status": "failed", "detail": "definition 必须是对象。"}]}
    objects = definition.get("objectTypes")
    relationships = definition.get("relationshipTypes")
    if not isinstance(definition.get("id"), str) or not definition.get("id", "").strip() or not isinstance(objects, list) or not isinstance(relationships, list):
        return None, {"status": "failed", "checks": [{"name": "模型结构", "status": "failed", "detail": "模型标识、对象和关系为必填项。"}]}
    asset_names = ["metrics", "glossaryTerms", "dataContracts", "qualityRules", "accessPolicies", "lineageEdges", "stateMachines", "events"]
    if not 1 <= len(objects) <= 40 or len(relationships) > 40 or any(not isinstance(item, dict) for item in objects + relationships) or any(
        not isinstance(definition.get(name, []), list) or any(not isinstance(item, dict) for item in definition.get(name, [])) for name in asset_names
    ) or any(not isinstance(item.get("fields"), list) or not isinstance(item.get("sourceSystems"), list) for item in objects):
        return None, {"status": "failed", "checks": [{"name": "模型结构", "status": "failed", "detail": "对象、关系和治理资产格式无效或超过限制；不会静默丢弃。"}]}
    normalized_objects = []
    for item in objects:
        if not isinstance(item, dict):
            continue
        normalized_objects.append({
            "id": str(item.get("id", "")).strip(), "semanticType": str(item.get("semanticType", "")).strip(),
            "coreObject": str(item.get("coreObject", "")).strip(), "key": str(item.get("key", "")).strip(),
            "fields": [str(field).strip() for field in item.get("fields", []) if str(field).strip()],
            "sourceSystems": [str(system).strip().upper() for system in item.get("sourceSystems", []) if str(system).strip()],
            "granularity": str(item.get("granularity", "unspecified")),
        })
    object_ids = {item["id"] for item in normalized_objects if item["id"]}
    for original, normalized in zip(objects, normalized_objects):
        if "fieldDefinitions" in original:
            fields = original["fieldDefinitions"]
            if not isinstance(fields, list) or len(fields) > 100 or any(not isinstance(field, dict) or field.get("name") not in normalized["fields"] for field in fields):
                return None, {"status": "failed", "checks": [{"name": "字段引用", "status": "failed", "detail": "字段定义必须引用已声明字段；不静默丢弃。"}]}
            normalized["fieldDefinitions"] = deepcopy(fields)
    normalized_relationships = [{"from": str(item.get("from", "")).strip(), "to": str(item.get("to", "")).strip(), "predicate": str(item.get("predicate", "")).strip(), "cardinality": item.get("cardinality", "1:n"), "evidence": item.get("evidence", ""), "provenanceType": item.get("provenanceType", "declared"), "validFrom": item.get("validFrom"), "validTo": item.get("validTo")} for item in relationships]
    for original, normalized in zip(relationships, normalized_relationships):
        if "keyMapping" in original:
            if not isinstance(original["keyMapping"], dict):
                return None, {"status": "failed", "checks": [{"name": "主键映射", "status": "failed", "detail": "映射定义必须为对象；未执行转换。"}]}
            normalized["keyMapping"] = deepcopy(original["keyMapping"])
    metrics = definition.get("metrics", []) if isinstance(definition.get("metrics", []), list) else []
    data_contracts = definition.get("dataContracts", []) if isinstance(definition.get("dataContracts", []), list) else []
    quality_rules = definition.get("qualityRules", []) if isinstance(definition.get("qualityRules", []), list) else []
    access_policies = definition.get("accessPolicies", []) if isinstance(definition.get("accessPolicies", []), list) else []
    lineage_edges = definition.get("lineageEdges", []) if isinstance(definition.get("lineageEdges", []), list) else []
    glossary_terms = definition.get("glossaryTerms", []) if isinstance(definition.get("glossaryTerms", []), list) else []
    checks = [
        {"name": "对象标识与主键", "status": "passed" if len(object_ids) == len(normalized_objects) and all(item["key"] and item["key"] in item["fields"] for item in normalized_objects) else "failed", "detail": "每个对象须具有唯一编码，且业务主键必须出现在字段列表中。"},
        {"name": "语义锚点与来源", "status": "passed" if all(item["semanticType"] and (item["coreObject"] in CORE_META_OBJECTS or item["coreObject"] == item["id"]) and item["sourceSystems"] and "待观察" not in item["sourceSystems"] for item in normalized_objects) else "failed", "detail": "对象可绑定核心锚点或保持独立类型；独立类型不授予数据访问权限。"},
        {"name": "关系引用", "status": "passed" if all(item["from"] in object_ids and item["to"] in object_ids and item["predicate"] for item in normalized_relationships) else "failed", "detail": "每条关系必须引用已定义对象并具备谓词。"},
        {"name": "指标与数据契约", "status": "passed" if all(str(item.get("grain", "")) in object_ids and item.get("expression") for item in metrics if isinstance(item, dict)) and all(str(item.get("objectType", "")) in object_ids and item.get("schemaVersion") for item in data_contracts if isinstance(item, dict)) else "failed", "detail": "指标粒度和数据契约对象必须引用已登记对象。"},
        {"name": "质量、权限与血缘", "status": "passed" if all(str(item.get("objectType", "")) in object_ids and item.get("rule") for item in quality_rules if isinstance(item, dict)) and all(str(item.get("objectType", "")) in object_ids and item.get("effect") for item in access_policies if isinstance(item, dict)) and all(str(item.get("to", "")) in object_ids and item.get("from") for item in lineage_edges if isinstance(item, dict)) else "failed", "detail": "质量规则、访问策略与来源血缘必须引用已登记对象。"},
    ]
    validation = {"status": "passed" if all(item["status"] == "passed" for item in checks) else "failed", "scope": "structural_definition_only", "businessSemanticsVerified": False, "checks": checks, "checkedAt": timestamp()}
    normalized = {"id": definition["id"], "code": str(definition.get("code", definition["id"])), "version": str(definition.get("version", "draft")), "sourceFingerprint": str(definition.get("sourceFingerprint", "")), "objectTypes": normalized_objects, "relationshipTypes": normalized_relationships, "metrics": metrics[:50], "glossaryTerms": glossary_terms[:100], "dataContracts": data_contracts[:50], "qualityRules": quality_rules[:100], "accessPolicies": access_policies[:100], "lineageEdges": lineage_edges[:100]}
    normalized.update({"modelingProfile": definition.get("modelingProfile", "oa-approval"), "scenario": definition.get("scenario"), "stateMachines": definition.get("stateMachines", []), "events": definition.get("events", [])})
    if definition.get("worldModel"):
        normalized["worldModel"] = definition["worldModel"]
    return normalized, validation


def model_definition_status(model_id=None) -> dict:
    definition = MODEL_DEFINITION if model_id is None else MODEL_DEFINITIONS.get(model_id)
    receipt = {} if model_id is None else {"modelId": model_id, "modelProtocol": 1, "projectionScope": "definition_only", "runtimeReadEnabled": False}
    if not definition:
        return {"status": "not_published", "engine": "semantica", "objectCount": 0, "relationshipCount": 0, **receipt}
    return {"status": "published", "engine": "semantica", "id": definition["id"], "version": definition["version"], "fingerprint": definition["fingerprint"], "sourceFingerprint": definition.get("sourceFingerprint", ""), "objectCount": len(definition["objectTypes"]), "relationshipCount": len(definition["relationshipTypes"]), "publishedAt": definition["publishedAt"], **receipt}


@durable_mutation
def publish_namespaced_model(model_id, payload):
    if not valid_model_namespace(model_id):
        return 400, {"error": "invalid_model_namespace"}
    if set(payload) - {"definition", "expectedFingerprint"} or "expectedFingerprint" not in payload:
        return 400, {"error": "model_publication_contract_invalid"}
    normalized, validation = validate_model_definition(payload.get("definition"))
    if validation["status"] != "passed":
        return 422, {"status": "failed", "validation": validation}
    serialized = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    fingerprint = sha256(serialized.encode("utf-8")).hexdigest()[:20]
    existing = MODEL_DEFINITIONS.get(model_id)
    if existing and existing["fingerprint"] == fingerprint:
        return 200, {"status": "published", "deployment": model_definition_status(model_id), "validation": validation, "idempotentReplay": True}
    expected = existing["fingerprint"] if existing else None
    if payload["expectedFingerprint"] != expected:
        return 409, {"error": "model_publication_conflict", "modelId": model_id}
    if existing is None and len(MODEL_DEFINITIONS) >= MAX_MODEL_NAMESPACES:
        return 409, {"error": "model_namespace_capacity"}
    MODEL_DEFINITIONS[model_id] = {**normalized, "fingerprint": fingerprint, "publishedAt": timestamp()}
    return 200, {"status": "published", "deployment": model_definition_status(model_id), "validation": validation}


@durable_mutation
def ingest_namespaced_graph(model_id, payload, tenant_id):
    if os.environ.get("SEMANTIC_DEMO_INGEST_ENABLED", "true").lower() not in {"1", "true", "yes"}:
        return 403, {"error": "demo_ingest_disabled"}
    return MODEL_GRAPHS.ingest(model_id, payload, MODEL_DEFINITIONS.get(model_id), tenant_id)


@durable_mutation
def reset_namespaced_graph(model_id, payload, tenant_id):
    return MODEL_GRAPHS.reset(model_id, payload, MODEL_DEFINITIONS.get(model_id), tenant_id)


@durable_mutation
def materialize_namespaced_relationships(model_id, payload, tenant_id):
    # Authenticated synthetic instance operation; never an enterprise IAM grant.
    if os.environ.get("SEMANTIC_DEMO_INGEST_ENABLED", "true").lower() not in {"1", "true", "yes"}:
        return 403, {"error": "demo_ingest_disabled"}
    return MODEL_GRAPHS.materialize_relationships(model_id, payload, MODEL_DEFINITIONS.get(model_id), tenant_id)


@durable_mutation
def publish_model_definition(payload: dict) -> tuple[int, dict]:
    global MODEL_DEFINITION
    normalized, validation = validate_model_definition(payload.get("definition"))
    if validation["status"] != "passed":
        return 422, {"engine": "semantica", "status": "failed", "validation": validation}
    serialized = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    fingerprint = sha256(serialized.encode("utf-8")).hexdigest()[:20]
    if MODEL_DEFINITION and MODEL_DEFINITION["fingerprint"] == fingerprint:
        return 200, {"engine": "semantica", "status": "published", "validation": validation, "deployment": model_definition_status(), "idempotentReplay": True}
    if MODEL_DEFINITION and normalized.get("sourceFingerprint") and MODEL_DEFINITION.get("sourceFingerprint") == normalized.get("sourceFingerprint"):
        return 409, {"error": "model_source_fingerprint_conflict", "status": "failed"}
    MODEL_DEFINITION = {**normalized, "fingerprint": fingerprint, "publishedAt": timestamp()}
    return 200, {"engine": "semantica", "status": "published", "validation": validation, "deployment": model_definition_status()}


def model_candidates() -> dict:
    """Expose an explainable modelling projection, never raw user data.

    Candidates are derived from the canonical synthetic facts held by the
    graph. When no Demo run has been ingested, the catalog is clearly labelled
    as a contract template rather than an observed fact.
    """
    grouped: dict[str, list[dict]] = {}
    for fact in FACTS.values():
        grouped.setdefault(fact["objectType"], []).append(fact)
    candidates = []
    for type_id, definition in SEMANTIC_TYPE_CATALOG.items():
        records = grouped.get(type_id, [])
        fields = sorted({key for record in records for key in record.get("payload", {}).keys()})
        source_systems = sorted({record["sourceSystem"] for record in records})
        candidates.append({
            "id": type_id, "label": definition["label"], "coreObject": definition["coreObject"],
            "description": definition["description"], "fields": fields or ["business_id", "status", "occurred_at"],
            "sourceSystems": source_systems or ["待观察"], "classification": records[0]["classification"] if records else "内部受限",
            "observedFacts": len(records), "origin": "semantica_observed" if records else "platform_contract_template",
        })
    relationship_counts: dict[tuple[str, str], dict] = {}
    for run in RUNS.values():
        run_facts = [FACTS[fact_id] for fact_id in run["factIds"] if fact_id in FACTS]
        for left_index, left in enumerate(run_facts):
            left_entities = set(entity_values(left))
            for right in run_facts[left_index + 1:]:
                shared = left_entities.intersection(entity_values(right))
                if not shared or left["objectType"] == right["objectType"]:
                    continue
                key = tuple(sorted((left["objectType"], right["objectType"])))
                entry = relationship_counts.setdefault(key, {"evidence": set(), "runs": set()})
                entry["evidence"].update(shared)
                entry["runs"].add(run["runId"])
    relationships = [
        {
            "from": pair[0], "to": pair[1], "predicate": "correlates_with", "label": "共享业务标识关联",
            "evidenceCount": len(entry["evidence"]), "observedRuns": len(entry["runs"]), "origin": "semantica_observed",
        }
        for pair, entry in sorted(relationship_counts.items())
    ]
    return {
        "engine": "semantica" if SEMANTICA_AVAILABLE else "projection-fallback",
        "status": "observed" if FACTS else "template_only", "graph": graph_stats(),
        "observedRunCount": len(RUNS), "candidateObjects": candidates, "candidateRelationships": relationships,
        "modelDeployment": model_definition_status(),
        "boundary": "Only synthetic Demo fact schemas, source-system codes and relationship evidence are returned. No raw business records or permissions are exposed.",
    }


class Handler(BaseHTTPRequestHandler):
    def authorize_instance(self) -> bool:
        self.instance_authorized = False
        self.model_namespace = None
        instance = getattr(self.server, "instance_config", None)
        if instance is None:
            return True
        expected = {"Authorization": "Bearer " + instance["token"],
                    "X-Semantic-Tenant": instance["tenantId"], "X-Semantic-Deployment": instance["deploymentId"]}
        valid = True
        for key, value in expected.items():
            supplied = self.headers.get_all(key, [])
            if len(supplied) != 1 or not supplied[0].isascii() or not compare_digest(supplied[0], value):
                valid = False
        if not valid:
            self.send_json(403, {"error": "instance_access_denied"})
            return False
        self.instance_authorized = True
        return True

    def model_route(self, path):
        """Authenticated bounded model protocols; no namespace fallback or business grant."""
        if not path.startswith("/models/"):
            return None
        match = re.fullmatch(r"/models/([a-z][a-z0-9-]{1,63})/(instance|definition|definition/validate|definition/publish|graph|graph/ingest|graph/reset|graph/runs/[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}|graph/relationships/materialize|graph/relationships/runs/[A-Za-z0-9][A-Za-z0-9_.:-]{0,119})", path)
        if not getattr(self, "instance_authorized", False):
            self.send_json(403, {"error": "instance_access_denied"})
            return False
        if not match or not valid_model_namespace(match[1]):
            self.send_json(400, {"error": "invalid_model_namespace"})
            return False
        self.model_namespace = match[1]
        return match[1], match[2]

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if getattr(self, "instance_authorized", False):
            instance = self.server.instance_config
            self.send_header("X-Semantic-Tenant", instance["tenantId"])
            self.send_header("X-Semantic-Deployment", instance["deploymentId"])
            self.send_header("X-Semantic-Protocol", "1")
            if getattr(self, "model_namespace", None):
                self.send_header("X-Semantic-Model", self.model_namespace)
                self.send_header("X-Semantic-Model-Protocol", "1")
                self.send_header("X-Semantic-Graph-Protocol", "1")
                self.send_header("X-Semantic-Relationship-Protocol", "1")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> tuple[dict | None, str | None]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None, "Content-Length 无效。"
        if length <= 0 or length > MAX_BODY_BYTES:
            return None, "请求体为空或超过 Demo 限制。"
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None, "请求体必须是 UTF-8 JSON。"
        if not isinstance(payload, dict):
            return None, "请求体必须是 JSON 对象。"
        return payload, None

    def do_GET(self):
        with GRAPH_LOCK:
            self.read_request()

    def read_request(self):
        if not self.authorize_instance():
            return
        if STORAGE_FAILED:
            self.send_json(503, {"error": "semantic_storage_unavailable"})
            return
        path = urlparse(self.path).path
        route = self.model_route(path)
        if route is False:
            return
        if route:
            model_id, operation = route
            if operation == "instance":
                self.send_json(200, {"status": "ready", "modelId": model_id, "modelProtocol": 1,
                                     "projectionScope": "definition_only", "runtimeReadEnabled": False, **storage_status()})
            elif operation == "definition":
                self.send_json(200, model_definition_status(model_id))
            elif operation.startswith("graph/relationships/runs/"):
                result = MODEL_GRAPHS.relationship_summary(model_id, operation.removeprefix("graph/relationships/runs/"),
                    MODEL_DEFINITIONS.get(model_id), self.server.instance_config["tenantId"])
                self.send_json(409 if result.get("error") else 404 if result["status"] == "not_found" else 200, result)
            elif operation == "graph" or operation.startswith("graph/runs/"):
                run_id = operation.removeprefix("graph/runs/") if operation.startswith("graph/runs/") else None
                result = MODEL_GRAPHS.summary(model_id, MODEL_DEFINITIONS.get(model_id), run_id)
                self.send_json(409 if result.get("error") else 404 if result["status"] == "not_found" else 200, result)
            else:
                self.send_json(405, {"error": "method_not_allowed"})
            return
        if path == "/instance" and getattr(self, "instance_authorized", False):
            self.send_json(200, {"status": "ready", "protocol": 1,
                                 "engine": "semantica" if SEMANTICA_AVAILABLE else "projection-fallback",
                                 **storage_status()})
            return
        if path == "/health":
            self.send_json(200, build_context("service"))
            return
        if path.startswith("/context/"):
            self.send_json(200, build_context(unquote(path.rsplit("/", 1)[-1]) or "unknown"))
            return
        if path.startswith("/demo/runs/"):
            run_id = unquote(path.rsplit("/", 1)[-1])
            with GRAPH_LOCK:
                summary = demo_run_summary(run_id)
                response = {"engine": "semantica" if SEMANTICA_AVAILABLE else "projection-fallback", "run": summary, "graph": graph_stats()}
            self.send_json(200 if summary.get("status") != "not_found" else 404, response)
            return
        if path == "/demo/model-candidates":
            with GRAPH_LOCK:
                self.send_json(200, model_candidates())
            return
        if path == "/demo/model-definition":
            with GRAPH_LOCK:
                self.send_json(200, model_definition_status())
            return
        self.send_error(404, "not found")

    def do_POST(self):
        if not self.authorize_instance():
            return
        if STORAGE_FAILED:
            self.send_json(503, {"error": "semantic_storage_unavailable"})
            return
        path = urlparse(self.path).path
        route = self.model_route(path)
        if route is False:
            return
        if route:
            model_id, operation = route
            if operation not in ("definition/validate", "definition/publish", "graph/ingest", "graph/reset", "graph/relationships/materialize"):
                self.send_json(405, {"error": "method_not_allowed"})
                return
            payload, error = self.read_json()
            if error:
                self.send_json(400, {"error": "invalid_json"})
                return
            if operation.startswith("graph/"):
                tenant_id = self.server.instance_config["tenantId"]
                action = {"graph/ingest": ingest_namespaced_graph, "graph/reset": reset_namespaced_graph,
                          "graph/relationships/materialize": materialize_namespaced_relationships}[operation]
                status, response = action(model_id, payload, tenant_id)
                self.send_json(status, response)
            elif operation == "definition/validate":
                _, validation = validate_model_definition(payload.get("definition"))
                self.send_json(200, {"modelId": model_id, "status": validation["status"], "validation": validation})
            else:
                status, response = publish_namespaced_model(model_id, payload)
                self.send_json(status, response)
            return
        if path == "/demo/ingest":
            payload, error = self.read_json()
            if error:
                self.send_json(400, {"error": "invalid_json", "message": error})
                return
            status, response = ingest_demo(payload)
            self.send_json(status, response)
            return
        if path == "/demo/reset":
            result = reset_demo()
            self.send_json(503 if result.get("error") else 200, result)
            return
        if path == "/demo/model-definition/validate":
            payload, error = self.read_json()
            if error:
                self.send_json(400, {"error": "invalid_json", "message": error})
                return
            _, validation = validate_model_definition(payload.get("definition"))
            self.send_json(200, {"engine": "semantica", "status": validation["status"], "validation": validation})
            return
        if path == "/demo/model-definition/publish":
            payload, error = self.read_json()
            if error:
                self.send_json(400, {"error": "invalid_json", "message": error})
                return
            status, response = publish_model_definition(payload)
            self.send_json(status, response)
            return
        self.send_error(404, "not found")

    def log_message(self, _format, *_args):
        return


if __name__ == "__main__":
    port = int(os.environ.get("SEMANTIC_CONTEXT_PORT", "3011"))
    instance_config = read_instance_configuration()
    initialize_storage(instance_config)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.instance_config = instance_config
    print(f"Semantic Context Service listening on http://127.0.0.1:{server.server_address[1]}", flush=True)
    server.serve_forever()
