import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState, writeState } from '../src/repositories/runtime-state-repository.js';
import { getRole } from '../src/services/authorization-service.js';
import { runWithSemanticTenant, runWithSemanticModelWorkspace } from '../src/services/semantic-tenant-context.js';
import { semanticModelRegistry } from '../src/services/semantic-model-registry.js';
import { getOAMetaModelDraft, getPublishedOntologyModel, saveOAMetaModelDraft, simulateBuildOAMetaModel } from '../src/services/meta-model-service.js';
import { publishGovernedOntology } from '../src/services/ontology-runtime-service.js';
import { readSemanticGovernanceState, mutateSemanticGovernanceState } from '../src/services/semantic-governance-store.js';
import { semanticFingerprint } from '../src/services/semantic-model-fingerprint.js';
import { getPublishedAgentOntology } from '../src/services/published-ontology-agent-service.js';
import { createLocalModelPublisher } from '../src/domains/governance/local-model-publication.js';
import { seedTenantIAM } from './helpers/tenant-iam-fixture.js';
import { iamWorkspaceKey } from '../src/services/iam-workspace-model.js';
import { configureIAMRepository, runWithIAMStoreContext } from '../src/services/iam-store.js';
import { asyncRuntimeStateRepository } from '../src/repositories/async-runtime-state-repository.js';

const role = getRole('executive');
const identity = { tenantId: 'synthetic-model-publisher', subjectId: 'architect' };
const workspace = (modelId, work) => runWithSemanticTenant(identity, () => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work }));
test.beforeEach(() => resetRuntimeState(['semantic_model_registry', 'oa_meta_model_runtime', 'ontology_publication', 'domain_event_outbox']));

async function localPublisherFixture(effect = () => {}) {
  const principal = { ...identity, subjectId: 'admin@demo.local' };
  const iam = seedTenantIAM(identity.tenantId, ['admin@demo.local']);
  await setup();
  let target = { tenantId: identity.tenantId, deploymentId: 'deployment-a', endpoint: 'http://127.0.0.1:31001',
    token: 't'.repeat(48), enabled: true, guarded: true };
  let writes = 0; let stored;
  const publisher = createLocalModelPublisher({ connection: () => target,
    inspect: async () => stored ? { ...stored.deployment, instance: stored.instance } : inspection('finance'),
    deploy: async (candidate, version, options) => {
      effect('dispatch', controls);
      try { await options.beforeDispatch(); }
      catch { return { status: 'unavailable', requestAttempted: false, reason: 'service_unavailable' }; }
      writes++; stored = receipt('finance', candidate, version);
      effect('commit', controls);
      return stored;
    } });
  const controls = {
    revoke: () => { iam.configurationVersion++; iam.users[0].roleIds = []; writeState('iam', iamWorkspaceKey(identity.tenantId), iam); },
    restore: () => seedTenantIAM(identity.tenantId, ['admin@demo.local']),
    changeTarget: () => { target = { ...target, token: 'x'.repeat(48) }; },
    unsafeTarget: () => { target = { ...target, endpoint: 'https://example.invalid' }; },
    writes: () => writes,
    call: async body => runWithSemanticTenant(principal, () => publisher({ identityScope: principal, modelId: 'finance', body })),
    payload: { confirmed: true, expectedFingerprint: semanticFingerprint(await workspace('finance', getOAMetaModelDraft)) }
  };
  return controls;
}

test('local publisher uses actual tenant IAM, bounded DTO and explicit confirmed fingerprint', async () => {
  const fixture = await localPublisherFixture();
  for (const body of [{ ...fixture.payload, endpoint: 'http://127.0.0.1:9999' }, { ...fixture.payload, confirmed: false },
    { ...fixture.payload, expectedFingerprint: Number('123456789012345678901234') }]) {
    assert.equal((await fixture.call(body)).code, 'LOCAL_PUBLICATION_INPUT_INVALID');
  }
  assert.equal(fixture.writes(), 0);
  const result = await fixture.call(fixture.payload);
  assert.equal(result.publication.status, 'completed'); assert.equal(result.runtimeReadEnabled, false);
  assert.equal(result.projectionScope, 'definition_only'); assert.equal(fixture.writes(), 1);
  assert.equal(JSON.stringify(result).includes('31001'), false); assert.equal(result.semanticDeployment, undefined);
});

for (const mutation of ['revoke', 'changeTarget']) test(`local publisher denies ${mutation} immediately before transmission`, async () => {
  const fixture = await localPublisherFixture((phase, controls) => { if (phase === 'dispatch') controls[mutation](); });
  const result = await fixture.call(fixture.payload);
  assert.ok(result.error); assert.equal(fixture.writes(), 0);
  assert.equal(await workspace('finance', getPublishedOntologyModel), null);
});

test('local publisher rejects unsafe target and revoked principal before any remote write', async () => {
  const fixture = await localPublisherFixture(); fixture.unsafeTarget();
  assert.equal((await fixture.call(fixture.payload)).code, 'LOCAL_PUBLICATION_TARGET_REQUIRED');
  fixture.revoke(); assert.equal((await fixture.call(fixture.payload)).code, 'LOCAL_PUBLICATION_FORBIDDEN');
  assert.equal(fixture.writes(), 0);
});

test('local publisher reloads async IAM rather than trusting an enclosing request snapshot', async () => {
  const fixture = await localPublisherFixture((phase, controls) => { if (phase === 'dispatch') controls.revoke(); });
  configureIAMRepository(asyncRuntimeStateRepository);
  try {
    const result = await runWithIAMStoreContext(() => fixture.call(fixture.payload), identity.tenantId);
    assert.equal(result.code, 'LOCAL_PUBLICATION_AUTHORITY_CHANGED'); assert.equal(fixture.writes(), 0);
  } finally { configureIAMRepository(null); }
});

test('local publisher rejects stale confirmation before remote deployment writes', async () => {
  const fixture = await localPublisherFixture();
  const result = await fixture.call({ ...fixture.payload, expectedFingerprint: '0'.repeat(24) });
  assert.equal(result.code, 'LOCAL_PUBLICATION_UNAVAILABLE'); assert.equal(fixture.writes(), 0);
  assert.equal(result.publicationMayHaveCommitted, undefined);
});

test('local publisher retains unknown commit after actual IAM revocation; authorized recovery is read-only', async () => {
  const fixture = await localPublisherFixture((phase, controls) => { if (phase === 'commit') controls.revoke(); });
  const result = await fixture.call(fixture.payload);
  assert.equal(result.code, 'LOCAL_PUBLICATION_AUTHORITY_CHANGED'); assert.equal(result.publicationMayHaveCommitted, true);
  assert.equal(fixture.writes(), 1); assert.equal(await workspace('finance', getPublishedOntologyModel), null);
  assert.equal((await workspace('finance', () => readSemanticGovernanceState('ontology_publication', 'current', null))).status, 'reconciliation_required');
  fixture.restore();
  assert.equal((await fixture.call(fixture.payload)).publication.status, 'completed');
  assert.equal(fixture.writes(), 1);
});

async function setup() {
  for (const [revision, modelId] of ['finance', 'production'].entries()) {
    await runWithSemanticTenant(identity, () => semanticModelRegistry.register({ role, identityScope: identity, body: { id: modelId, label: `${modelId}模型`, expectedRevision: revision } }));
    await workspace(modelId, () => simulateBuildOAMetaModel(role));
  }
}
const instance = (modelId, deploymentId = 'deployment-a') => ({ tenantId: identity.tenantId, deploymentId, modelId,
  identityVerified: true, protocol: 1, modelProtocol: 1, projectionScope: 'definition_only', runtimeReadEnabled: false });
const inspection = (modelId, patch = {}) => ({ status: 'not_published', modelId, modelProtocol: 1,
  projectionScope: 'definition_only', runtimeReadEnabled: false, instance: instance(modelId), ...patch });
const receipt = (modelId, candidate, version, target = instance(modelId)) => ({ status: 'published', requestAttempted: true, instance: target,
  deployment: { ...inspection(modelId), instance: undefined, status: 'published', id: candidate.id, version, fingerprint: 'a'.repeat(20), sourceFingerprint: semanticFingerprint(candidate) } });

test('registered models publish independently, persist deployment targets and stay authoring-only', async () => {
  await setup();
  let calls = 0;
  const results = await Promise.all(['finance', 'production'].map(modelId => workspace(modelId, async () => {
    const result = await publishGovernedOntology({ role, identityScope: identity, inspect: async () => inspection(modelId),
      deploy: async (candidate, version, options) => { calls++; assert.equal(options.expectedDeployment.modelId, modelId); return receipt(modelId, candidate, version); } });
    assert.equal(result.error, undefined);
    const published = await getPublishedOntologyModel();
    assert.equal(published.modelId, modelId); assert.equal(published.runtimeReadEnabled, false);
    const lock = await readSemanticGovernanceState('ontology_publication', 'current');
    assert.equal(lock.status, 'completed'); assert.equal(lock.target.modelId, modelId);
    assert.equal(await getPublishedAgentOntology(role.id, identity), null);
    return published;
  })));
  assert.equal(calls, 2); assert.equal(results[0].fingerprint, results[1].fingerprint);
  assert.equal(runWithSemanticTenant(identity, getPublishedOntologyModel), null);
});

test('wrong tenant identity and unregistered contexts are refused before any external calls', async () => {
  await setup(); let calls = 0;
  const options = { role, identityScope: identity, inspect: async () => { calls++; }, deploy: async () => { calls++; } };
  assert.equal((await workspace('finance', () => publishGovernedOntology({ ...options, identityScope: { ...identity, tenantId: 'other-tenant' } }))).code, 'PUBLICATION_WORKSPACE_FORBIDDEN');
  assert.equal((await runWithSemanticModelWorkspace(identity, 'unregistered', () => publishGovernedOntology(options))).code, 'PUBLICATION_WORKSPACE_FORBIDDEN');
  assert.equal(calls, 0);
});

test('missing, cross-model and cross-tenant preflight receipts do not send definitions', async () => {
  await setup();
  for (const observed of [null, inspection('production'), inspection('finance', { instance: { ...instance('finance'), tenantId: 'other-tenant' } }),
    inspection('finance', { instance: { ...instance('finance'), identityVerified: false } }), inspection('finance', { runtimeReadEnabled: true })]) {
    const result = await workspace('finance', () => publishGovernedOntology({ role, identityScope: identity, inspect: async () => observed,
      deploy: async () => assert.fail('No definition may be sent') }));
    assert.equal(result.code, 'PUBLICATION_NOT_ATTEMPTED');
  }
});

test('foreign or drifted deployment baseline is never overwritten automatically', async () => {
  await setup();
  const result = await workspace('finance', () => publishGovernedOntology({ role, identityScope: identity,
    inspect: async () => inspection('finance', { status: 'published', version: 'foreign', fingerprint: 'a'.repeat(20), sourceFingerprint: 'foreign' }),
    deploy: async () => assert.fail('must not overwrite') }));
  assert.equal(result.code, 'PUBLICATION_DEPLOYMENT_DRIFT');
  assert.equal(await workspace('finance', getPublishedOntologyModel), null);
});

test('wrong model or deployment write receipts stay uncertain, even with matching source and version', async () => {
  for (const patch of ['foreign-model', 'foreign-instance']) {
    resetRuntimeState(['semantic_model_registry', 'oa_meta_model_runtime', 'ontology_publication', 'domain_event_outbox']); await setup();
    const result = await workspace('finance', () => publishGovernedOntology({ role, identityScope: identity, inspect: async () => inspection('finance'),
      deploy: async (candidate, version) => {
        const result = receipt('finance', candidate, version);
        if (patch === 'foreign-model') result.deployment.modelId = 'production';
        else result.instance.deploymentId = 'other-deployment';
        return result;
      } }));
    assert.equal(result.code, 'PUBLICATION_RECEIPT_UNCONFIRMED');
    assert.equal(await workspace('finance', getPublishedOntologyModel), null);
  }
});

test('lost response reconciles only the original model and deployment, without a second write', async () => {
  await setup(); let stored; let calls = 0;
  const deploy = async (candidate, version) => { calls++; stored = receipt('finance', candidate, version); throw new Error('synthetic lost response'); };
  assert.equal((await workspace('finance', () => publishGovernedOntology({ role, identityScope: identity, inspect: async () => inspection('finance'), deploy }))).code, 'PUBLICATION_OUTCOME_UNKNOWN');
  const retry = observed => workspace('finance', () => publishGovernedOntology({ role, identityScope: identity,
    inspect: async () => observed, deploy: async () => assert.fail('must only inspect') }));
  const remote = { ...stored.deployment, instance: stored.instance };
  for (const patch of [{ modelId: 'production' }, { instance: instance('finance', 'other-deployment') }, { sourceFingerprint: 'wrong' }, { version: 'wrong' }]) {
    assert.equal((await retry({ ...remote, ...patch })).code, 'PUBLICATION_RECONCILIATION_REQUIRED');
  }
  const result = await retry(remote);
  assert.equal(result.error, undefined); assert.equal(result.semanticDeployment.reconciled, true); assert.equal(calls, 1);
});

test('same-model overlapping publication has one writer, without blocking the other model', async () => {
  await setup(); let entered; let release;
  const started = new Promise(resolve => { entered = resolve; });
  const first = workspace('finance', () => publishGovernedOntology({ role, identityScope: identity, inspect: async () => inspection('finance'),
    deploy: async (candidate, version) => { entered(); await new Promise(resolve => { release = resolve; }); return receipt('finance', candidate, version); } }));
  await started;
  assert.equal((await workspace('finance', () => publishGovernedOntology({ role, identityScope: identity, deploy: async () => assert.fail('duplicate writer') }))).code, 'PUBLICATION_BUSY');
  assert.equal((await workspace('production', () => publishGovernedOntology({ role, identityScope: identity, inspect: async () => inspection('production'), deploy: async (candidate, version) => receipt('production', candidate, version) }))).error, undefined);
  release(); assert.equal((await first).error, undefined);
});

test('draft change or registry removal during I/O cannot activate a stale or unregistered model', async () => {
  for (const action of ['draft', 'registry']) {
    resetRuntimeState(['semantic_model_registry', 'oa_meta_model_runtime', 'ontology_publication', 'domain_event_outbox']); await setup();
    const result = await workspace('finance', () => publishGovernedOntology({ role, identityScope: identity, inspect: async () => inspection('finance'),
      deploy: async (candidate, version) => {
        if (action === 'draft') {
          const draft = await getOAMetaModelDraft(); draft.policies.push('changed during deployment'); await saveOAMetaModelDraft(draft, role);
        } else await mutateSemanticGovernanceState('semantic_model_registry', 'index', null, state => ({ value: { ...state, models: state.models.filter(item => item.id !== 'finance') } }));
        return receipt('finance', candidate, version);
      } }));
    assert.equal(result.code, action === 'draft' ? 'ONTOLOGY_PUBLICATION_STALE' : 'PUBLICATION_RECEIPT_UNCONFIRMED');
    assert.equal(await runWithSemanticModelWorkspace(identity, 'finance', getPublishedOntologyModel), null);
  }
});

test('an expired publication owner cannot finalize or overwrite a successor lock', async () => {
  await setup();
  const result = await workspace('finance', () => publishGovernedOntology({ role, identityScope: identity, inspect: async () => inspection('finance'),
    deploy: async (candidate, version) => {
      await mutateSemanticGovernanceState('ontology_publication', 'current', null, current => ({ value: { ...current, startedAt: '2099-01-01T00:00:00Z', status: 'completed' } }));
      return receipt('finance', candidate, version);
    } }));
  assert.equal(result.code, 'PUBLICATION_BUSY');
  assert.equal((await workspace('finance', () => readSemanticGovernanceState('ontology_publication', 'current'))).status, 'completed');
  assert.equal(await workspace('finance', getPublishedOntologyModel), null);
});

test('changes during model preflight fail before any deployment write', async () => {
  await setup();
  const result = await workspace('finance', () => publishGovernedOntology({ role, identityScope: identity,
    inspect: async () => {
      const draft = await getOAMetaModelDraft(); draft.policies.push('changed during preflight'); await saveOAMetaModelDraft(draft, role);
      return inspection('finance');
    }, deploy: async () => assert.fail('stale preflight cannot transmit a definition') }));
  assert.equal(result.code, 'PUBLICATION_DRAFT_STALE');
  assert.equal((await workspace('finance', () => readSemanticGovernanceState('ontology_publication', 'current'))).status, 'not_attempted');
  assert.equal(await workspace('finance', getPublishedOntologyModel), null);
});

test('explicit publication fingerprint and trusted guard type reject before external preflight', async () => {
  await setup(); let calls = 0;
  const options = { role, identityScope: identity, inspect: async () => { calls++; return inspection('finance'); }, deploy: async () => { calls++; } };
  for (const expectedFingerprint of [null, 123, 'invalid']) assert.equal((await workspace('finance', () => publishGovernedOntology({ ...options, expectedFingerprint }))).code, 'PUBLICATION_INPUT_INVALID');
  assert.equal((await workspace('finance', () => publishGovernedOntology({ ...options, beforeDispatch: 'client-grant' }))).code, 'PUBLICATION_INPUT_INVALID');
  assert.equal((await workspace('finance', () => publishGovernedOntology({ ...options, expectedFingerprint: 'b'.repeat(24) }))).code, 'PUBLICATION_DRAFT_STALE');
  assert.equal(calls, 0);
});

test('trusted prepare guard can deny before entering a publisher and leaves not-attempted state', async () => {
  await setup(); let writes = 0;
  const result = await workspace('finance', () => publishGovernedOntology({ role, identityScope: identity,
    inspect: async () => inspection('finance'), beforeDispatch: async context => { assert.equal(context.phase, 'prepare'); assert.equal(context.modelId, 'finance'); throw new Error('Synthetic authority revoked'); },
    deploy: async () => { writes++; } }));
  assert.equal(result.code, 'PUBLICATION_DISPATCH_DENIED'); assert.equal(writes, 0);
  assert.equal((await workspace('finance', () => readSemanticGovernanceState('ontology_publication', 'current'))).status, 'not_attempted');
  assert.equal(await workspace('finance', getPublishedOntologyModel), null);
});

test('publisher receives a server-only dispatch hook; a proven pre-transmission denial does not become uncertain', async () => {
  await setup(); const stages = []; let writes = 0;
  const result = await workspace('finance', () => publishGovernedOntology({ role, identityScope: identity,
    inspect: async () => inspection('finance'), beforeDispatch: async context => { stages.push(context.phase); if (context.phase === 'dispatch') throw new Error('Synthetic revoked'); },
    deploy: async (_candidate, _version, options) => {
      try { await options.beforeDispatch(); }
      catch { return { status: 'unavailable', reason: 'service_unavailable', requestAttempted: false }; }
      writes++; assert.fail('No write permitted');
    } }));
  assert.deepEqual(stages, ['prepare', 'dispatch']); assert.equal(writes, 0); assert.equal(result.code, 'PUBLICATION_NOT_ATTEMPTED');
  assert.equal((await workspace('finance', () => readSemanticGovernanceState('ontology_publication', 'current'))).status, 'not_attempted');
});

test('post-receipt guard failure preserves uncertainty and reconciliation never retransmits a definition', async () => {
  await setup(); let remote; let writes = 0; const phases = [];
  const result = await workspace('finance', async () => publishGovernedOntology({ role, identityScope: identity,
    expectedFingerprint: semanticFingerprint(await getOAMetaModelDraft()), inspect: async () => inspection('finance'),
    beforeDispatch: async context => { phases.push(context.phase); if (context.phase === 'commit') throw new Error('Synthetic post-write revocation'); },
    deploy: async (candidate, version, options) => { await options.beforeDispatch(); writes++; remote = receipt('finance', candidate, version); return remote; } }));
  assert.equal(result.code, 'PUBLICATION_AUTHORITY_CHANGED'); assert.deepEqual(phases, ['prepare', 'dispatch', 'commit']);
  assert.equal(await workspace('finance', getPublishedOntologyModel), null);
  assert.equal((await workspace('finance', () => readSemanticGovernanceState('ontology_publication', 'current'))).status, 'reconciliation_required');
  const recovered = await workspace('finance', () => publishGovernedOntology({ role, identityScope: identity,
    inspect: async () => ({ ...remote.deployment, instance: remote.instance }),
    beforeDispatch: async context => assert.equal(context.phase, 'commit'), deploy: async () => assert.fail('No repeat POST allowed') }));
  assert.equal(recovered.error, undefined); assert.equal(recovered.semanticDeployment.reconciled, true); assert.equal(writes, 1);
});

test('publication rereads execution ownership after an asynchronous commit guard', async () => {
  await setup();
  const result = await workspace('finance', () => publishGovernedOntology({ role, identityScope: identity,
    inspect: async () => inspection('finance'), deploy: async (candidate, version, options) => { await options.beforeDispatch(); return receipt('finance', candidate, version); },
    beforeDispatch: async context => {
      if (context.phase === 'commit') await mutateSemanticGovernanceState('ontology_publication', 'current', null, current => ({ value: { ...current, status: 'completed', startedAt: '2099-01-01T00:00:00Z' } }));
    } }));
  assert.equal(result.code, 'PUBLICATION_BUSY'); assert.equal(await workspace('finance', getPublishedOntologyModel), null);
  assert.equal((await workspace('finance', () => readSemanticGovernanceState('ontology_publication', 'current'))).startedAt, '2099-01-01T00:00:00Z');
});
