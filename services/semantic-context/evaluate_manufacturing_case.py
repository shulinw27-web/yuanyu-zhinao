"""Isolated real Semantica graph check; no HTTP server or model publication.

The human dictionary control is explicitly separate from Agent candidates.
Only the checked-in synthetic fixture is accepted; this is not a Connector.
"""
import importlib.util
import json
from pathlib import Path
from semantica.context import ContextGraph

ROOT = Path(__file__).resolve().parents[2]
INPUT = ROOT / 'examples/semantic-schemas/manufacturing-case'
OUTPUT = ROOT / 'output/semantic-manufacturing-fixed'
spec = importlib.util.spec_from_file_location('isolated_semantic_app', Path(__file__).with_name('app.py'))
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
assert service.SEMANTICA_AVAILABLE, 'Real Semantica is required; no fallback allowed'
data = json.loads((INPUT / 'sample-events.json').read_text(encoding='utf-8'))
assert data['synthetic'] is True
for record in data['records']:
    assert record['id'].startswith('SYN-EV-') and record['tenantId'] == 'demo-enterprise'
    assert record['organizationId'] == 'org-quality-dept'
dictionary = json.loads((INPUT / 'data-dictionary.json').read_text(encoding='utf-8'))


def analyze(label, definition):
    _, validation = service.validate_model_definition(definition)
    objects = {item['id']: item for item in definition['objectTypes']}
    graph = ContextGraph()
    admitted = []
    rejected = []
    seen = set()
    duplicate_count = 0
    nodes = {}
    for record in data['records']:
        event_key = (record['system'], record['id'], record['version'])
        if event_key in seen:
            duplicate_count += 1
            continue
        seen.add(event_key)
        obj = objects.get(record['objectType'])
        if not obj or record['system'] not in obj['sourceSystems']:
            rejected.append({'recordId': record['id'], 'reason': 'model_source_or_type_mismatch'})
            continue
        key = record['payload'].get(obj['key'])
        if not key:
            rejected.append({'recordId': record['id'], 'reason': 'model_key_missing'})
            continue
        node_id = f"{record['system']}:{record['objectType']}:{key}"
        nodes[(record['objectType'], key)] = node_id
        graph.add_node(node_id, record['objectType'], json.dumps(record['payload'], ensure_ascii=False),
                       source_system=record['system'], source_record_id=record['id'],
                       simulated=True, occurred_at=record['occurredAt'])
        admitted.append((record, obj, node_id))
    edge_count = 0
    for record, obj, node_id in admitted:
        for field in obj.get('fieldDefinitions', []):
            target = field.get('reference')
            value = record['payload'].get(field['name'])
            if not target or not value:
                continue
            if not any(r['from'] == obj['id'] and r['to'] == target for r in definition['relationshipTypes']):
                continue
            target_id = nodes.get((target, value))
            if target_id:
                graph.add_edge(node_id, target_id, f"references_{field['name']}", provenance=record['id'])
                edge_count += 1
    return {'label': label, 'structuralValidation': validation, 'graph': graph.stats(),
            'inputEvents': len(data['records']), 'duplicatesSkipped': duplicate_count,
            'admittedRecords': len(admitted), 'rejectedRecords': rejected,
            'explicitInstanceEdges': edge_count, 'badLotSearchHits': len(graph.query('LOT-SYN-B')),
            'automaticProductionIntegration': False}


reports = []
for case in ['T4-context-build', 'T5-api-only', 'T6-api-dictionary', 'T6-api-dictionary-retry', 'T8-merge-batch', 'T9-dictionary-only']:
    path = OUTPUT / f'{case}.json'
    if not path.exists():
        continue
    row = json.loads(path.read_text(encoding='utf-8'))
    proposal = row.get('task', {}).get('proposal')
    if not proposal:
        reports.append({'label': case, 'status': 'no_candidate'})
        continue
    reports.append(analyze(case, {'id': f'synthetic-{case}', 'modelingProfile': 'general',
                                 'objectTypes': proposal['objectTypes'], 'relationshipTypes': proposal['relationshipTypes']}))

# Capability control, NOT an Agent output and never fed back into model prompts.
reference = {'id': 'human-dictionary-control', 'modelingProfile': 'general', 'objectTypes': [], 'relationshipTypes': []}
for table in dictionary['tables']:
    reference['objectTypes'].append({'id': table['name'], 'semanticType': table['name'], 'coreObject': table['name'],
                                    'key': table['primaryKey'], 'sourceSystems': [table['system']], 'granularity': table['granularity'],
                                    'fields': [field['name'] for field in table['fields']], 'fieldDefinitions': table['fields']})
    for field in table['fields']:
        if field.get('reference'):
            reference['relationshipTypes'].append({'from': table['name'], 'to': field['reference'],
                                                   'predicate': f"references_{field['name']}", 'cardinality': 'n:1'})
reports.append(analyze('human_dictionary_control_not_agent_output', reference))
result = {'engine': 'semantica.ContextGraph', 'isolatedProcess': True, 'published': False,
          'scope': 'candidate_driven_sample_binding_with_separate_human_control', 'results': reports}
(OUTPUT / 'semantica-graphs.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
