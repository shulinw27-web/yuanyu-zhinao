import unittest
from copy import deepcopy
from relationship_projection import preview_relationships


def fixture():
    return {"definition": {"objectTypes": [
        {"id": "Order", "key": "id", "fields": ["id", "supplier_id"], "sourceSystems": ["ERP"],
         "fieldDefinitions": [{"name": "supplier_id", "reference": "Supplier", "referenceField": "id"}]},
        {"id": "Supplier", "key": "id", "fields": ["id"], "sourceSystems": ["OA"]}],
        "relationshipTypes": [{"from": "Order", "to": "Supplier", "predicate": "ordered_from", "cardinality": "n:1", "provenanceType": "declared"}]},
        "runs": {"run": {"factIds": ["order", "supplier"]}}, "facts": {
            "order": {"id": "order", "objectType": "Order", "payload": {"id": "same", "supplier_id": "same"},
                      "organizationId": "org", "sourceVersion": "v1", "occurredAt": "2026-10-11T04:00:00Z"},
            "supplier": {"id": "supplier", "objectType": "Supplier", "payload": {"id": "same"},
                         "organizationId": "org", "sourceVersion": "v1", "occurredAt": "2026-10-11T12:00:00+08:00"}}}


class RelationshipPreviewTests(unittest.TestCase):
    def test_explicit_direction_and_foreign_key_only_counts_without_mutation_or_values(self):
        state = fixture(); before = deepcopy(state)
        result = preview_relationships(state, "run")
        self.assertEqual(result["status"], "preview_passed")
        self.assertEqual(result["candidateEdgeCount"], 1)
        self.assertEqual(result["relationships"][0]["fromField"], "supplier_id")
        self.assertFalse(result["materialized"]); self.assertFalse(result["runtimeReadEnabled"])
        self.assertNotIn("same", str(result)); self.assertEqual(state, before)

    def test_same_ids_cannot_invent_a_binding_or_reverse_a_relation(self):
        for patch in [{"fieldDefinitions": []}, {"fieldDefinitions": [{"name": "supplier_id", "reference": "Supplier", "referenceField": "unknown"}]}]:
            state = fixture(); state["definition"]["objectTypes"][0].update(patch)
            self.assertEqual(preview_relationships(state, "run")["code"], "relationship_field_binding_ambiguous")
        state = fixture(); relation = state["definition"]["relationshipTypes"][0]; relation["from"], relation["to"] = relation["to"], relation["from"]
        self.assertEqual(preview_relationships(state, "run")["status"], "blocked")

    def test_organization_time_type_and_run_are_not_implicitly_joined(self):
        for patch in [{"organizationId": "other"}, {"occurredAt": "2026-10-11T04:00:01Z"}, {"payload": {"id": 1}}]:
            state = fixture(); state["facts"]["supplier"].update(patch)
            self.assertEqual(preview_relationships(state, "run")["candidateEdgeCount"], 0)
        state = fixture(); del state["facts"]["supplier"]["sourceVersion"]
        self.assertEqual(preview_relationships(state, "run")["code"], "relationship_provenance_required")
        self.assertEqual(preview_relationships(fixture(), "other-run")["code"], "relationship_run_required")

    def test_ambiguous_targets_and_one_to_one_cardinality_fail_without_partial_counts(self):
        state = fixture(); state["facts"]["supplier2"] = {**state["facts"]["supplier"], "id": "supplier2"}; state["runs"]["run"]["factIds"].append("supplier2")
        result = preview_relationships(state, "run"); self.assertEqual(result["code"], "relationship_target_ambiguous"); self.assertNotIn("relationships", result)
        state = fixture(); state["definition"]["relationshipTypes"][0]["cardinality"] = "1:1"
        state["facts"]["order2"] = {**state["facts"]["order"], "id": "order2"}; state["runs"]["run"]["factIds"].append("order2")
        self.assertEqual(preview_relationships(state, "run")["code"], "relationship_cardinality_conflict")

    def test_unsupported_transform_temporal_and_inferred_declarations_are_not_executed(self):
        for patch in [{"keyMapping": {"script": "not executable"}}, {"validFrom": "2026-10-10"}, {"provenanceType": "inferred"}, {"cardinality": "1:n"}]:
            state = fixture(); state["definition"]["relationshipTypes"][0].update(patch)
            self.assertEqual(preview_relationships(state, "run")["code"], "relationship_projection_unsupported")
        state = fixture(); state["definition"]["objectTypes"][0]["sourceSystems"].append("MES")
        self.assertEqual(preview_relationships(state, "run")["status"], "blocked")

    def test_large_run_is_rejected_without_partial_candidates(self):
        state = fixture(); state["runs"]["run"]["factIds"] = ["order"] * 101
        self.assertEqual(preview_relationships(state, "run")["code"], "relationship_preview_capacity")

    def test_internal_edges_are_explicit_and_duplicate_declarations_block_the_whole_batch(self):
        state = fixture()
        self.assertNotIn("_edges", preview_relationships(state, "run"))
        edges = preview_relationships(state, "run", include_edges=True)["_edges"]
        self.assertEqual([(edge["fromRecord"], edge["toRecord"], edge["predicate"]) for edge in edges], [("order", "supplier", "ordered_from")])
        state["definition"]["relationshipTypes"].append(deepcopy(state["definition"]["relationshipTypes"][0]))
        result = preview_relationships(state, "run", include_edges=True)
        self.assertEqual(result["code"], "relationship_declaration_ambiguous")
        self.assertNotIn("_edges", result)
