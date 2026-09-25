import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { runWithSemanticTenant, currentSemanticTenant, semanticTenantStateKey } from '../src/services/semantic-tenant-context.js';
import { getOAMetaModelDraft, saveOAMetaModelDraft, getOAMetaModelSimulation, simulateBuildOAMetaModel, publishOAMetaModel, getPublishedOntologyModel } from '../src/services/meta-model-service.js';
import { getRole } from '../src/services/authorization-service.js';
import { handleGovernanceRoutes } from '../src/routes/governance-routes.js';
import { createSemanticOperationsProposal, applySemanticOperationsProposal, rollbackSemanticOperationsSnapshot } from '../src/services/semantic-operations-agent-service.js';
import { readSemanticGovernanceState, mutateSemanticGovernanceState, mutateSemanticGovernanceStates, configureSemanticGovernanceRepository } from '../src/services/semantic-governance-store.js';
import { getWorldModelTemplates, createWorldModelDraft, getWorldModelDrafts, validateWorldModelDraft } from '../src/services/world-model-template-service.js';
import { getSemanticaModelDiscovery, getSemanticaModelDeployment, publishSemanticaModelDefinition, resetSemanticaDemoGraph } from '../src/services/semantica-demo-bridge-service.js';
import { createSemanticInspectionSchedule, runSemanticInspectionCycle } from '../src/services/semantic-inspection-schedule-service.js';
import { listDomainEvents } from '../src/infrastructure/domain-events/domain-event-outbox.js';

if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'memory') throw new Error('Use the runtime-test-bootstrap memory store.');
const role = getRole('executive');
const identity = tenantId => ({ tenantId, subjectId: 'same-architect', deviceId: 'same-device' });
const within = (tenant, work) => runWithSemanticTenant(identity(tenant), work);
test.beforeEach(() => resetRuntimeState(['oa_meta_model_runtime', 'ontology_publication', 'world_model_runtime', 'semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_inspection_schedules', 'semantic_operations_notifications', 'domain_event_outbox']));

async function draftRequest(tenant, method, body) {
  let response;
  await handleGovernanceRoutes({ req: { method }, res: {}, url: new URL('http://test/api/meta-models/oa-governance/draft'), role: 'executive',
    agentIdentity: identity(tenant), selectActionRole: () => role, readBody: async () => body,
    send: (_res, status, value) => { response = { status, value }; } });
  assert.equal(response.status, 200); return response.value;
}

test('tenant model: real routes isolate manual drafts and ignore body tenant IDs', async () => {
  await draftRequest('company-a', 'POST', { policies: ['A_ONLY'], tenantId: 'company-b' });
  assert.ok((await draftRequest('company-a', 'GET')).policies.includes('A_ONLY'));
  assert.ok(!(await draftRequest('company-b', 'GET')).policies.includes('A_ONLY'));
  await draftRequest('company-b', 'POST', { policies: ['B_ONLY'] });
  assert.deepEqual((await draftRequest('company-a', 'GET')).policies, ['A_ONLY']);
  assert.deepEqual((await draftRequest('company-b', 'GET')).policies, ['B_ONLY']);
  assert.throws(() => handleGovernanceRoutes({ url: new URL('http://test/api/meta-models/oa-governance/draft') }), error => error.code === 'SEMANTIC_TENANT_REQUIRED');
});

test('tenant model: concurrent async continuations retain independent trusted tenant context', async () => {
  const results = await Promise.all(['company-a', 'company-b'].map(tenant => within(tenant, async () => {
    await Promise.resolve(); saveOAMetaModelDraft({ policies: [tenant] }, role);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(currentSemanticTenant(), tenant); return getOAMetaModelDraft().policies;
  })));
  assert.deepEqual(results, [['company-a'], ['company-b']]);
  assert.throws(() => within('company-a', () => within('company-b', () => getOAMetaModelDraft())), error => error.code === 'SEMANTIC_TENANT_CONTEXT_MISMATCH');
});

test('tenant model: Demo legacy data is preserved but never copied into a new tenant', () => {
  saveOAMetaModelDraft({ policies: ['LEGACY_DEMO_ONLY'] }, role);
  assert.deepEqual(within('demo-enterprise', getOAMetaModelDraft).policies, ['LEGACY_DEMO_ONLY']);
  assert.ok(!within('new-company', getOAMetaModelDraft).policies.includes('LEGACY_DEMO_ONLY'));
  assert.notEqual(within('a:b', () => semanticTenantStateKey('c')), within('a', () => semanticTenantStateKey('b:c')));
  assert.throws(() => runWithSemanticTenant({ tenantId: ' invalid ' }, () => null), error => error.code === 'SEMANTIC_TENANT_REQUIRED');
});

test('tenant model: missing context in production is rejected, not mapped to Demo', () => {
  const prior = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try {
    assert.throws(getOAMetaModelDraft, error => error.code === 'SEMANTIC_TENANT_REQUIRED');
    assert.ok(within('verified-company', getOAMetaModelDraft).objectTypes.length);
  } finally { process.env.NODE_ENV = prior; }
});

test('tenant model: proposal adoption and rollback mutate only the bound tenant workspace', () => {
  const apply = tenant => within(tenant, () => {
    saveOAMetaModelDraft({ policies: [tenant] }, role);
    const proposal = createSemanticOperationsProposal({ input: '建立供应商和原料批次语义模型', identityScope: identity(tenant) });
    return applySemanticOperationsProposal({ proposalId: proposal.id, role, identityScope: identity(tenant) });
  });
  const a = apply('company-a'); const b = apply('company-b'); assert.ok(a.snapshot); assert.ok(b.snapshot);
  const bBefore = within('company-b', getOAMetaModelDraft);
  const rolled = within('company-a', () => rollbackSemanticOperationsSnapshot({ snapshotId: a.snapshot.id, role, identityScope: identity('company-a') }));
  assert.equal(rolled.error, undefined); assert.deepEqual(within('company-b', getOAMetaModelDraft), bBefore);
  assert.throws(() => within('company-a', () => applySemanticOperationsProposal({ proposalId: b.proposal.id, role, identityScope: identity('company-b') })), error => error.code === 'SEMANTIC_TENANT_CONTEXT_MISMATCH');
});

test('tenant model: simulation, published versions, publication locks and outbox tenant tags are independent', async () => {
  within('company-a', () => {
    simulateBuildOAMetaModel(role);
    assert.equal(publishOAMetaModel(role, { version: 'A-v1', tenantId: 'company-a' }).error, undefined);
    mutateSemanticGovernanceState('ontology_publication', 'current', null, () => ({ value: { status: 'publishing', fingerprint: 'A' } }));
  });
  within('company-b', () => {
    assert.equal(getOAMetaModelSimulation(), null); assert.equal(getPublishedOntologyModel(), null);
    assert.equal(readSemanticGovernanceState('ontology_publication', 'current', null), null);
    simulateBuildOAMetaModel(role); assert.equal(publishOAMetaModel(role, { version: 'B-v1' }).error, undefined);
  });
  assert.equal(within('company-a', getPublishedOntologyModel).version, 'A-v1');
  assert.equal(within('company-b', getPublishedOntologyModel).tenantId, 'company-b');
  assert.equal((await listDomainEvents({ tenantId: 'company-a' })).length, 1);
  assert.equal((await listDomainEvents({ tenantId: 'company-b' })).length, 1);
});

test('tenant model: legacy world-template drafts are also tenant scoped', () => {
  const template = getWorldModelTemplates()[0];
  const a = within('company-a', () => createWorldModelDraft({ templateId: template.id, targetId: 'lims' }, role));
  assert.ok(a.draft);
  assert.equal(within('company-b', () => getWorldModelDrafts('executive')).length, 0);
  assert.ok(within('company-b', () => validateWorldModelDraft(a.draft.id, role)).error);
  assert.equal(within('company-a', () => getWorldModelDrafts('executive')).length, 1);
});

test('tenant model: non-Demo tenants cannot read, reset or publish to the shared Semantica Demo instance', async () => {
  const originalFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Must not send a shared projection request'); };
  try {
    for (const operation of [getSemanticaModelDiscovery, getSemanticaModelDeployment, resetSemanticaDemoGraph, () => publishSemanticaModelDefinition({}, 'v1')]) {
      const response = await within('company-a', operation);
      assert.equal(response.reason, 'tenant_endpoint_required'); assert.equal(response.requestAttempted, false);
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('tenant model: scheduled inspection restores its stored tenant context', async () => {
  for (const tenant of ['company-a', 'company-b']) {
    within(tenant, () => saveOAMetaModelDraft({ policies: [tenant] }, role));
    await createSemanticInspectionSchedule({ body: { checks: ['schema_integrity'] }, role, identityScope: identity(tenant) });
  }
  const observed = [];
  await runSemanticInspectionCycle({ workerId: 'tenant-test', executeInspection: async schedule => {
    observed.push([schedule.identityScope.tenantId, (await getOAMetaModelDraft()).policies[0]]);
    return { severity: 'info', summary: 'Synthetic scoped check', findings: [] };
  } });
  assert.equal(observed.length, 2); assert.ok(observed.every(([tenant, policy]) => tenant === policy));
});

test('tenant model: async repository receives scoped keys for single and multi-state operations', async () => {
  const observed = [];
  configureSemanticGovernanceRepository({
    readState: async (namespace, key) => { observed.push([namespace, key]); return null; },
    mutateState: async (namespace, key) => { observed.push([namespace, key]); return null; },
    mutateStates: async entries => { observed.push(...entries.map(entry => [entry.namespace, entry.key])); return null; }
  });
  try {
    await within('company-a', async () => {
      await readSemanticGovernanceState('oa_meta_model_runtime', 'workspace');
      await mutateSemanticGovernanceState('ontology_publication', 'current', null, () => ({}));
      await mutateSemanticGovernanceStates([{ name: 'model', namespace: 'oa_meta_model_runtime', key: 'workspace' }], () => ({}));
    });
    await within('company-b', () => readSemanticGovernanceState('oa_meta_model_runtime', 'workspace'));
    assert.equal(observed[0][1], observed[2][1]); assert.notEqual(observed[0][1], observed[3][1]);
    assert.ok(observed.every(([, key]) => key.startsWith('["semantic-tenant-v1",')));
  } finally { configureSemanticGovernanceRepository(null); }
});
