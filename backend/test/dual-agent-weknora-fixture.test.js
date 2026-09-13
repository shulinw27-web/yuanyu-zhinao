import test from 'node:test';
import assert from 'node:assert/strict';
import { dictionary, samples, documents, plan } from '../../examples/knowledge/dual-agent-mock/scenario.mjs';
import { expected, complexReplayCases } from '../../examples/knowledge/dual-agent-mock/expected.mjs';
import { discoverSchemasFromAttachments } from '../src/services/semantic-schema-discovery-service.js';
import { executeOntologyReadPlan } from '../src/services/ontology-read-plan-service.js';

test('dual Agent material pack separates four source documents from the answer oracle and retains adversarial branches', () => {
  assert.equal(documents.length, 4); assert.equal(dictionary.tables.length, 18);
  assert.ok(documents.every(d => d.text.includes('WK-DUAL-20260913')));
  assert.ok(documents.find(d => d.name.includes('draft-b')).text.includes('未发布'));
  assert.equal(samples.records.filter(r => r.id === 'CR-T1').length, 2);
  assert.ok(samples.records.every(r => !r.id.includes('-X')));
  assert.equal(samples.records.find(r => r.id === 'AP-T1').payload.execution_receipt_id, null);
  assert.equal(samples.records.find(r => r.id === 'TI-T1').payload.received_qty, 0);
  assert.equal(samples.records.find(r => r.id === 'LINE-T2').payload.status, 'cancelled');
});

test('dual Agent synthetic totals match independently calculated oracle through real read algebra', async () => {
  const discovered = discoverSchemasFromAttachments({ attachments: [{ id: 'dict', name: 'dictionary.json', mimeType: 'application/json' }], reports: [{ attachmentId: 'dict', status: 'content_scanned', structuredSchemaCandidate: true }], documents: [{ attachmentId: 'dict', text: JSON.stringify(dictionary) }] });
  const previous = process.env.ONTOLOGY_RUNTIME_GRANTS_JSON;
  try {
    process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify({ 'demo-enterprise': { executive: { metadata: true, objects: Object.fromEntries(dictionary.tables.map(t => [t.name, { system: t.system, fields: t.fields.map(f => f.name), classifications: ['internal'] }])) } } });
    const draft = { ...discovered, scenario: { requireCaseReplay: true, decisionBindings: [], readPlans: [plan] }, accessPolicies: discovered.objectTypes.map(o => ({ objectType: o.id, effect: 'allow', roles: ['executive'], condition: 'iam_scope' })) };
    const result = await executeOntologyReadPlan({ draft, plan, target: 'ORD-T900', roleId: 'executive', scope: { tenantId: 'demo-enterprise', subjectId: 'demo:executive:fixture', source: 'demo_header' },
      retrieve: async (type, query) => samples.records.filter(r => r.objectType === type.id && query.filter.values.includes(r.payload[query.filter.field])) });
    assert.deepEqual(Object.fromEntries(result.results.map(r => [r.id,r.value])), expected);
    for (const item of complexReplayCases(plan.id, samples.records)) {
      const run = () => executeOntologyReadPlan({ draft, plan, target: item.target, roleId: 'executive', scope: { tenantId: 'demo-enterprise', subjectId: 'demo:executive:fixture', source: 'demo_header' },
        retrieve: async (type, query) => item.records.filter(r => r.objectType === type.id && query.filter.values.includes(r.payload[query.filter.field])) });
      if (item.expectedError) await assert.rejects(run, { message: item.expectedError }, item.label);
      else assert.deepEqual(Object.fromEntries((await run()).results.map(r => [r.id, r.value])), item.expected, item.label);
    }
  } finally { if (previous === undefined) delete process.env.ONTOLOGY_RUNTIME_GRANTS_JSON; else process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = previous; }
});
