"""Read-only bounded candidates, not entity equivalence or a runtime grant."""
from datetime import datetime
import math


def preview_relationships(state, run_id, *, include_edges=False):
    def rejected(code):
        return {"status": "blocked", "code": code, "materialized": False, "runtimeReadEnabled": False}

    if not state or run_id not in state["runs"]:
        return rejected("relationship_run_required")
    definition = state["definition"]
    types = {item["id"]: item for item in definition["objectTypes"]}
    facts = [state["facts"][key] for key in state["runs"][run_id]["factIds"]]
    if len(facts) > 100:
        return rejected("relationship_preview_capacity")
    results = []
    edges = []
    signatures = set()
    count = 0
    budget = 10000

    def value_key(value):
        if isinstance(value, bool) or value is None:
            return None
        if isinstance(value, (int, float)):
            try:
                return ("number", float(value)) if math.isfinite(float(value)) else None
            except OverflowError:
                return None
        return ("string", value) if isinstance(value, str) and value.strip() else None

    def context(fact, key):
        if not fact.get("organizationId") or not fact.get("sourceVersion"):
            raise ValueError("relationship_provenance_required")
        return (fact["organizationId"], datetime.fromisoformat(fact["occurredAt"]), key)

    try:
        for relation in definition["relationshipTypes"]:
            signature = (relation["from"], relation["to"], relation["predicate"])
            if signature in signatures:
                return rejected("relationship_declaration_ambiguous")
            signatures.add(signature)
            source, target = types[relation["from"]], types[relation["to"]]
            if relation.get("keyMapping") or relation.get("validFrom") or relation.get("validTo") or relation.get("provenanceType", "declared") != "declared" or relation.get("cardinality") not in ("1:1", "n:1") or len(source["sourceSystems"]) != 1 or len(target["sourceSystems"]) != 1:
                return rejected("relationship_projection_unsupported")
            bindings = [field for field in source.get("fieldDefinitions", []) if field.get("reference") == target["id"] and field.get("referenceField", target["key"]) == target["key"]]
            if len(bindings) != 1:
                return rejected("relationship_field_binding_ambiguous")
            from_field, to_field = bindings[0]["name"], target["key"]
            targets = {}
            for fact in facts:
                budget -= 1
                if budget < 0:
                    return rejected("relationship_preview_capacity")
                if fact["objectType"] != target["id"]:
                    continue
                key = value_key(fact["payload"].get(to_field))
                if key is None:
                    return rejected("relationship_key_invalid")
                scoped_key = context(fact, key)
                if scoped_key in targets:
                    return rejected("relationship_target_ambiguous")
                targets[scoped_key] = fact["id"]
            matched, unmatched, reverse = 0, 0, set()
            for fact in facts:
                budget -= 1
                if budget < 0:
                    return rejected("relationship_preview_capacity")
                if fact["objectType"] != source["id"]:
                    continue
                key = value_key(fact["payload"].get(from_field))
                if key is None:
                    unmatched += 1
                    continue
                target_record = targets.get(context(fact, key))
                if target_record is None or target_record == fact["id"]:
                    unmatched += 1
                    continue
                if relation["cardinality"] == "1:1" and target_record in reverse:
                    return rejected("relationship_cardinality_conflict")
                reverse.add(target_record); matched += 1
                edges.append({"fromRecord": fact["id"], "toRecord": target_record, "from": relation["from"], "to": relation["to"],
                              "predicate": relation["predicate"], "fromField": from_field, "toField": to_field})
            count += matched
            if count > 1000:
                return rejected("relationship_preview_capacity")
            results.append({"from": relation["from"], "to": relation["to"], "predicate": relation["predicate"],
                            "fromField": from_field, "toField": to_field, "matchedFacts": matched, "unmatchedFacts": unmatched})
    except (ValueError, KeyError, TypeError):
        return rejected("relationship_provenance_required")
    return {"status": "preview_passed", "projectionScope": "synthetic_relationship_preview", "materialized": False,
            **({"_edges": edges} if include_edges else {}),
            "runtimeReadEnabled": False, "candidateEdgeCount": count, "relationships": results}
