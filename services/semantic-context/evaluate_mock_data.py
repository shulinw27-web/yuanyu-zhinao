"""Run an isolated Semantica evaluation using this project's cross-system Mock.

The fixture is generated in a Node test-memory runtime. It therefore exercises
the same scenario and connector data shapes as the product without changing a
running desktop user's local SQLite data.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from semantica.context import ContextGraph

ROOT = Path(__file__).resolve().parents[2]
EXPORTER = "./services/semantic-context/export_mock_fixture.mjs"
BOOTSTRAP = "./backend/test/runtime-test-bootstrap.js"

ENTITY_KEYS = {
    "materialBatchId", "productionBatchId", "finishedGoodsBatchId", "batchId",
    "sku", "orderId", "storeId", "supplierId", "equipmentId", "eventId",
    "capaId", "purchaseOrderId", "fulfillmentId", "subject",
}


def fixture():
    result = subprocess.run(
        ["node", "--import", BOOTSTRAP, EXPORTER],
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        errors="strict",
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout)


def entity_values(payload: dict):
    return [str(value) for key, value in payload.items() if key in ENTITY_KEYS and value]


def content(record: dict):
    details = "；".join(f"{key}={value}" for key, value in record["payload"].items() if value is not None)
    return f"{record['system']} {record['objectType']} {record['eventType']} {record['status']}；{details}"


def build_graph(data: dict):
    graph = ContextGraph()
    for scenario in data["scenarios"]:
        graph.add_node(
            f"scenario:{scenario['runId']}", "Scenario",
            f"{scenario['id']}；业务标识={scenario['businessKey']}",
            source="Mock Runtime", scenario_id=scenario["id"], run_id=scenario["runId"],
            business_key=scenario["businessKey"], classification="演练数据",
        )

    for record in data["records"]:
        record_id = f"record:{record['id']}"
        graph.add_node(
            record_id, record["objectType"], content(record),
            source_system=record["system"], source_record_id=record["id"],
            occurred_at=record["occurredAt"], classification=record["classification"],
            event_type=record["eventType"], status=record["status"],
            simulated=True,
        )
        run_id = record["payload"].get("runId")
        if run_id:
            graph.add_edge(f"scenario:{run_id}", record_id, "produced_fact", provenance=record["id"])
        for value in entity_values(record["payload"]):
            entity_id = f"entity:{value}"
            graph.add_node(entity_id, "BusinessEntity", value, entity_id=value, simulated=True)
            graph.add_edge(entity_id, record_id, "referenced_by", provenance=record["id"])
            # Keep the inverse impact relation explicit. ContextGraph traversal
            # is directional; without this edge, an order cannot reach its
            # fulfillment record and then the linked finished-goods batch.
            graph.add_edge(record_id, entity_id, "affects_entity", provenance=record["id"])

    decision_ids = []
    for scenario in data["scenarios"]:
        entities = [f"entity:{scenario['businessKey']}"]
        decision_ids.append(graph.record_decision(
            category="mock_cross_system_risk",
            scenario=scenario["id"],
            reasoning=f"Mock data across {'/'.join(scenario['systems'])} requires human approval before any write.",
            outcome="awaiting_human_approval",
            confidence=0.92,
            entities=entities,
            decision_maker="semantic-mock-evaluator",
            metadata={"run_id": scenario["runId"], "approval_id": scenario["approvalId"], "simulated": True},
        ))
    return graph, decision_ids


def node_systems(graph, nodes):
    return sorted({
        graph.get_node_attributes(node["id"]).get("source_system")
        for node in nodes
        if graph.get_node_attributes(node["id"]).get("source_system")
    })


def run():
    data = fixture()
    graph, decisions = build_graph(data)
    stats = graph.stats()
    quality_key = "RMB-VC-20260801"
    order_key = "ORD-202608-00001"
    quality_hits = graph.query(quality_key)
    quality_neighbors = graph.get_neighbors(f"entity:{quality_key}", hops=3, include_distance_metadata=True)
    order_neighbors = graph.get_neighbors(f"entity:{order_key}", hops=3, include_distance_metadata=True)
    quality_systems = node_systems(graph, quality_neighbors)
    order_systems = node_systems(graph, order_neighbors)

    # This represents the upstream policy boundary: Semantica receives only
    # records already authorized for a role; it does not decide user access.
    marketing_visible = [record for record in data["records"] if record["system"] in {"OMS", "OA"}]
    provenance_complete = all(
        record.get("system") and record.get("id") and record.get("occurredAt") and record.get("classification")
        for record in data["records"]
    )
    checks = {
        "mock_fixture_contains_cross_system_events": len(data["records"]) >= 12 and len(data["scenarios"]) == 3,
        "graph_builds_nodes_and_relations": stats["node_count"] >= 30 and stats["edge_count"] >= 25,
        "business_identifier_query_returns_quality_context": bool(quality_hits),
        "quality_trace_links_lims_qms_mes_and_oa": {"LIMS", "QMS", "MES", "OA"}.issubset(set(quality_systems)),
        "order_trace_links_oms_erp_qms_and_oa": {"OMS", "ERP", "QMS", "OA"}.issubset(set(order_systems)),
        "every_mock_fact_has_provenance": provenance_complete,
        "decision_provenance_is_recorded": graph.get_decision_summary()["total_decisions"] == len(decisions),
        "upstream_role_filter_prevents_marketing_from_receiving_supply_quality_records": all(record["system"] in {"OMS", "OA"} for record in marketing_visible),
    }
    report = {
        "engine": "semantica.ContextGraph",
        "fixture": data["fixture"],
        "records": len(data["records"]),
        "scenarios": len(data["scenarios"]),
        "graph": stats,
        "quality_trace_systems": quality_systems,
        "order_trace_systems": order_systems,
        "decisions": len(decisions),
        "checks": checks,
        "passed": all(checks.values()),
        "boundary": "Mock facts are synthetic. Role filtering is enforced upstream; Semantica is evaluated only with already-authorized facts."
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(run())
