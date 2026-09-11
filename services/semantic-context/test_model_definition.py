"""Contract tests only; importing the service does not start its HTTP server."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("semantic_app", Path(__file__).with_name("app.py"))
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


def fixture():
    return {"id": "quality", "modelingProfile": "general", "scenario": {"objective": "质量分析", "questions": ["何时需要调查？"]},
            "objectTypes": [{"id": "QualityEvent", "semanticType": "QualityEvent", "coreObject": "QualityEvent", "key": "id", "fields": ["id", "status"], "sourceSystems": ["QMS"], "granularity": "event"}],
            "relationshipTypes": []}


class ModelDefinitionTests(unittest.TestCase):
    def test_object_limit_matches_api(self):
        for count in [20, 21, 40, 41]:
            value = fixture()
            value["objectTypes"] = [{**fixture()["objectTypes"][0], "id": f"Type{i}", "coreObject": f"Type{i}"} for i in range(count)]
            normalized, validation = app.validate_model_definition(value)
            self.assertEqual(validation["status"], "passed" if count <= 40 else "failed")
            if normalized:
                self.assertEqual(len(normalized["objectTypes"]), count)

    def test_independent_single_object(self):
        normalized, validation = app.validate_model_definition(fixture())
        self.assertEqual(validation["status"], "passed")
        self.assertEqual(normalized["objectTypes"][0]["granularity"], "event")
        self.assertEqual(normalized["scenario"], fixture()["scenario"])
        self.assertEqual(validation["scope"], "structural_definition_only")
        self.assertFalse(validation["businessSemanticsVerified"])

    def test_world_requirements_preserved_not_executed(self):
        value = fixture()
        value["worldModel"] = {"schemaVersion": "semantic-world-model.v1", "rules": [{"id": "r1", "evidence": "审批不是执行", "executable": False}]}
        normalized, validation = app.validate_model_definition(value)
        self.assertEqual(normalized["worldModel"], value["worldModel"])
        self.assertFalse(validation["businessSemanticsVerified"])

    def test_reject_invalid_instead_of_silent_drop(self):
        for change in [{"objectTypes": []}, {"objectTypes": [None]}, {"relationshipTypes": [None]}, {"qualityRules": [None]}, {"id": ""}]:
            with self.subTest(change=change):
                normalized, validation = app.validate_model_definition({**fixture(), **change})
                self.assertIsNone(normalized)
                self.assertEqual(validation["status"], "failed")

    def test_reject_unknown_anchor_and_broken_reference(self):
        value = fixture()
        value["objectTypes"][0]["coreObject"] = "UnknownAnchor"
        self.assertEqual(app.validate_model_definition(value)[1]["status"], "failed")
        value = fixture()
        value["relationshipTypes"] = [{"from": "Missing", "to": "QualityEvent", "predicate": "affects"}]
        self.assertEqual(app.validate_model_definition(value)[1]["status"], "failed")

    def test_preserve_relation_provenance_and_time(self):
        value = fixture()
        relation = {"from": "QualityEvent", "to": "QualityEvent", "predicate": "follows", "cardinality": "1:1", "evidence": "受控记录", "provenanceType": "confirmed", "validFrom": "2026-09-01T00:00:00Z", "validTo": None}
        value["relationshipTypes"] = [relation]
        normalized, validation = app.validate_model_definition(value)
        self.assertEqual(validation["status"], "passed")
        self.assertEqual(normalized["relationshipTypes"][0], relation)


if __name__ == "__main__":
    unittest.main()
