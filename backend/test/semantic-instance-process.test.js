import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, fork } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { runWithSemanticTenant } from '../src/services/semantic-tenant-context.js';
import { publishSemanticaModelDefinition, getSemanticaModelDeployment, resetSemanticaDemoGraph } from '../src/services/semantica-demo-bridge-service.js';
import { inspectTenantProvisioning } from '../src/services/tenant-provisioning-preflight.js';
import { requestSemanticInstance } from '../src/services/semantic-instance-transport.js';
import { semanticModelRegistry } from '../src/services/semantic-model-registry.js';
import { getRole } from '../src/services/authorization-service.js';
import { simulateBuildOAMetaModel, getPublishedOntologyModel, getOAMetaModelDraft, saveOAMetaModelDraft } from '../src/services/meta-model-service.js';
import { publishGovernedOntology } from '../src/services/ontology-runtime-service.js';
import { resetRuntimeState, writeState } from '../src/repositories/runtime-state-repository.js';
import { createInitialIAMWorkspace, iamWorkspaceKey } from '../src/services/iam-workspace-model.js';
import { runWithIAMStoreContext } from '../src/services/iam-store.js';
import { getEffectiveAccess } from '../src/services/access-control-service.js';
import { transferSyntheticFacts } from '../../services/semantic-context/synthetic-fact-transfer.js';
import { reconcileSyntheticTransfer } from '../../services/semantic-context/synthetic-fact-reconciliation.js';
import { prepareSyntheticRelationships } from '../../services/semantic-context/synthetic-relationship-preparation.js';
import { materializeSyntheticRelationships, reconcileSyntheticRelationships } from '../../services/semantic-context/synthetic-relationship-execution.js';
import { publishLocalModelWorkspace } from '../src/domains/governance/local-model-publication.js';
import { seedTenantIAM } from './helpers/tenant-iam-fixture.js';

// Explicit integration command: requires the real Semantica environment, never silently skips.
const python = process.env.SEMANTIC_TEST_PYTHON || resolve(process.platform === 'win32' ? '.venv-semantica/Scripts/python.exe' : '.venv-semantica/bin/python');
const execute = promisify(execFile);
const within = (tenantId, work) => runWithSemanticTenant({ tenantId }, work);
const headers = item => ({ authorization: `Bearer ${item.token}`, 'x-semantic-tenant': item.tenantId, 'x-semantic-deployment': item.deploymentId });
const definition = suffix => ({ id: `model-${suffix}`, code: `TEST-${suffix}`, modelingProfile: 'general',
  objectTypes: [{ id: 'QualityEvent', semanticType: 'QualityEvent', coreObject: 'QualityEvent', key: 'id', fields: ['id', 'status'], sourceSystems: ['QMS'], granularity: 'event' }], relationshipTypes: [] });

for (const durable of [false, true]) test(`real Python processes: isolation and restart (${durable ? 'SQLite' : 'memory'})`, { timeout: 120000 }, async t => {
  assert.ok(existsSync(python), 'Install the Semantica environment or set SEMANTIC_TEST_PYTHON to its Python executable.');
  const directory = mkdtempSync(join(tmpdir(), 'semantic-process-test-'));
  const children = [];
  const registryFile = join(directory, 'registry.json');
  const prior = { file: process.env.SEMANTIC_INSTANCES_FILE, enabled: process.env.SEMANTICA_DEMO_BRIDGE_ENABLED };
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    if (prior.file === undefined) delete process.env.SEMANTIC_INSTANCES_FILE; else process.env.SEMANTIC_INSTANCES_FILE = prior.file;
    if (prior.enabled === undefined) delete process.env.SEMANTICA_DEMO_BRIDGE_ENABLED; else process.env.SEMANTICA_DEMO_BRIDGE_ENABLED = prior.enabled;
    await rm(directory, { recursive: true, maxRetries: 10, retryDelay: 100 });
  });
  async function start(suffix, databasePath = join(directory, `${suffix}.db`)) {
    const item = { version: 1, tenantId: `synthetic-${suffix}`, deploymentId: `process-${suffix}`, token: randomBytes(32).toString('base64url'), enabled: true };
    const configFile = join(directory, `${suffix}.json`); writeFileSync(configFile, JSON.stringify(item));
    const child = spawn(python, ['-u', 'services/semantic-context/app.py'], { cwd: resolve('.'), windowsHide: true,
      env: { ...process.env, SEMANTIC_CONTEXT_PORT: '0', SEMANTIC_INSTANCE_CONFIG_FILE: configFile, SEMANTIC_REQUIRE_INSTANCE_AUTH: 'true',
        SEMANTIC_INSTANCE_DB: durable ? databasePath : '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); child.stderr.on('data', () => {});
    const endpoint = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Semantic instance startup timed out')), 45000);
      let output = '';
      child.stdout.on('data', bytes => { output += bytes.toString(); const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/u); if (match) { clearTimeout(timer); resolveReady(match[1]); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Semantic instance exited ${code}`)); });
    });
    const health = await fetch(`${endpoint}/instance`, { headers: headers(item) });
    const status = await health.json(); assert.equal(health.status, 200); assert.equal(status.engine, 'semantica'); assert.equal(status.durable, durable);
    assert.equal(status.storage, durable ? 'sqlite-snapshot' : 'process-memory');
    return { ...item, endpoint, child };
  }
  const [a, b] = await Promise.all([start('a'), start('b')]);
  const bindings = [a, b].map(({ child: _child, ...item }) => item);
  const save = items => writeFileSync(registryFile, JSON.stringify({ version: 1, instances: items }));
  save(bindings); process.env.SEMANTIC_INSTANCES_FILE = registryFile; process.env.SEMANTICA_DEMO_BRIDGE_ENABLED = 'true';

  await t.test('portal resource preflight verifies durable instance but never invents IAM readiness', async () => {
    const result = await inspectTenantProvisioning({ tenantId: b.tenantId });
    assert.equal(result[0].status, durable ? 'passed' : 'blocked');
    assert.ok(result.slice(1).every(item => item.status === 'blocked'));
  });

  await t.test('every read and write route rejects missing identity or another tenant credential', async () => {
    for (const [path, method] of [['/health', 'GET'], ['/context/executive', 'GET'], ['/instance', 'GET'], ['/demo/model-candidates', 'GET'], ['/demo/runs/anything', 'GET'], ['/demo/model-definition', 'GET'], ['/demo/ingest', 'POST'], ['/demo/reset', 'POST'], ['/demo/model-definition/validate', 'POST'], ['/demo/model-definition/publish', 'POST'], ['/models/finance/instance', 'GET'], ['/models/finance/definition', 'GET'], ['/models/finance/definition/publish', 'POST'], ['/models/finance/definition/validate', 'POST'], ['/models/finance/graph', 'GET'], ['/models/finance/graph/runs/same-run', 'GET'], ['/models/finance/graph/ingest', 'POST'], ['/models/finance/graph/reset', 'POST']]) {
      for (const supplied of [{}, headers(a), { ...headers(b), 'x-semantic-tenant': a.tenantId }]) {
        const response = await fetch(`${b.endpoint}${path}`, { method, headers: supplied });
        assert.equal(response.status, 403, path); assert.deepEqual(await response.json(), { error: 'instance_access_denied' });
        assert.equal(response.headers.get('x-semantic-tenant'), null);
      }
    }
  });
  await t.test('parallel publications return only their own tenant model and version', async () => {
    const result = await Promise.all([a, b].map((item, index) => within(item.tenantId, () => publishSemanticaModelDefinition(definition(index), `v${index + 1}`))));
    assert.deepEqual(result.map(value => value.status), ['published', 'published']);
    const read = await Promise.all([a, b].map(item => within(item.tenantId, getSemanticaModelDeployment)));
    assert.deepEqual(read.map(value => value.id), ['model-0', 'model-1']);
    assert.deepEqual(read.map(value => value.version), ['v1', 'v2']);
  });
  const modelReceipts = new Map();
  await t.test('namespace protocol deploys independent definitions and rejects stale updates in each tenant', async () => {
    for (const item of [a, b]) {
      for (const modelId of ['finance', 'manufacturing']) {
        const projected = definition('shared-id'); projected.objectTypes[0].sourceSystems = ['ERP', 'QMS'];
        const result = await requestSemanticInstance({ ...item, guarded: true }, `/models/${modelId}/definition/publish`, {
          method: 'POST', modelId, body: { definition: { ...projected, version: `${item.tenantId}-${modelId}` }, expectedFingerprint: null }
        });
        assert.equal(result.deployment.modelId, modelId);
        assert.equal(result.instance.modelId, modelId);
        assert.equal(result.deployment.runtimeReadEnabled, false);
        modelReceipts.set(`${item.tenantId}/${modelId}`, result.deployment);
      }
      const conflict = await fetch(`${item.endpoint}/models/finance/definition/publish`, {
        method: 'POST', headers: { ...headers(item), 'content-type': 'application/json' },
        body: JSON.stringify({ definition: { ...definition('shared-id'), version: 'stale' }, expectedFingerprint: null })
      });
      assert.equal(conflict.status, 409);
    }
    assert.deepEqual((await Promise.all([a, b].map(item => within(item.tenantId, getSemanticaModelDeployment)))).map(value => value.id), ['model-0', 'model-1']);
  });
  const graphCall = (item, modelId, operation, options = {}) => requestSemanticInstance({ ...item, guarded: true }, `/models/${modelId}/graph${operation}`,
    { ...options, modelId, projectionScope: 'synthetic_graph' });
  const relationReceipts = new Map();
  const relationCall = (item, modelId, operation, options = {}) => requestSemanticInstance({ ...item, guarded: true }, `/models/${modelId}/graph/relationships/${operation}`,
    { ...options, modelId, projectionScope: 'synthetic_relationships' });
  await t.test('real relationship protocol binds synthetic proofs across tenants and models without runtime reads', async () => {
    for (const item of [a, b]) for (const modelId of ['relations-finance', 'relations-production']) {
      const projected = definition('relations'); projected.version = `${item.tenantId}-${modelId}`;
      projected.objectTypes[0].fields.push('material_id');
      projected.objectTypes[0].fieldDefinitions = [{ name: 'material_id', reference: 'RawMaterial', referenceField: 'id' }];
      projected.objectTypes.push({ id: 'RawMaterial', semanticType: 'RawMaterial', coreObject: 'RawMaterial', key: 'id', fields: ['id'], sourceSystems: ['ERP'] });
      projected.relationshipTypes.push({ from: 'QualityEvent', to: 'RawMaterial', predicate: 'inspects', cardinality: 'n:1' });
      const publication = await requestSemanticInstance({ ...item, guarded: true }, `/models/${modelId}/definition/publish`,
        { modelId, method: 'POST', body: { definition: projected, expectedFingerprint: null } });
      const binding = publication.deployment;
      const facts = ['QualityEvent', 'RawMaterial'].map((objectType, index) => ({ id: `relation-fact-${index}`, sourceRecordId: `source-${index}`,
        sourceSystem: index ? 'ERP' : 'QMS', objectType, eventType: 'reported', status: 'observed', classification: 'synthetic',
        occurredAt: '2026-10-11T00:00:00Z', organizationId: 'synthetic-org', sourceVersion: 'v1', simulated: true,
        tenantId: item.tenantId, modelId, modelVersion: binding.version, modelFingerprint: binding.fingerprint, runId: 'same-run',
        payload: index ? { id: 'material-1' } : { id: 'quality-1', material_id: 'material-1' } }));
      const input = { runId: 'same-run', scenarioId: 'synthetic-relations', expectedSystems: ['ERP', 'QMS'], expectedFingerprint: binding.fingerprint, facts };
      const ingested = await graphCall(item, modelId, '/ingest', { method: 'POST', body: input });
      assert.equal((await relationCall(item, modelId, 'runs/same-run')).status, 'not_materialized');
      const body = { runId: 'same-run', expectedFingerprint: binding.fingerprint, expectedRunProof: ingested.run.proofFingerprint, confirmed: true };
      const result = await relationCall(item, modelId, 'materialize', { method: 'POST', body });
      assert.equal(result.relationshipCount, 1); assert.equal(result.runtimeReadEnabled, false); assert.equal(result.instance.relationshipProtocol, 1);
      assert.equal((await relationCall(item, modelId, 'materialize', { method: 'POST', body })).idempotentReplay, true);
      const { instance: _instance, ...readReceipt } = await relationCall(item, modelId, 'runs/same-run');
      assert.equal(readReceipt.runProofFingerprint, ingested.run.proofFingerprint);
      assert.equal(JSON.stringify(readReceipt).includes('material-1'), false);
      relationReceipts.set(`${item.tenantId}/${modelId}`, readReceipt);
      for (const supplied of [{}, headers(item === a ? b : a)]) {
        const denied = await fetch(`${item.endpoint}/models/${modelId}/graph/relationships/materialize`, { method: 'POST', headers: supplied });
        assert.equal(denied.status, 403);
      }
      await assert.rejects(relationCall(item, modelId, 'materialize', { method: 'POST', body: { ...body, expectedRunProof: 'forged' } }));
      assert.equal((await graphCall(item, modelId, '/runs/same-run')).run.proofFingerprint, body.expectedRunProof);
    }
    assert.equal(new Set([...relationReceipts.values()].map(item => item.projectionFingerprint)).size, 4);
  });
  await t.test('same synthetic records and run IDs stay isolated by tenant and model; resets touch only the requested graph', async () => {
    for (const item of [a, b]) {
      for (const modelId of ['finance', 'manufacturing']) {
        const definition = modelReceipts.get(`${item.tenantId}/${modelId}`);
        const body = { runId: 'same-run', scenarioId: 'synthetic-graphs', expectedSystems: ['ERP', 'QMS'], expectedFingerprint: definition.fingerprint,
          facts: ['ERP', 'QMS'].map((system, index) => ({ id: `same-fact-${index}`, sourceSystem: system, sourceRecordId: `same-record-${index}`,
            objectType: 'QualityEvent', eventType: 'reported', status: 'open', classification: 'synthetic', occurredAt: '2026-10-11T00:00:00Z',
            runId: 'same-run', tenantId: item.tenantId, modelId, modelVersion: definition.version, modelFingerprint: definition.fingerprint,
            simulated: true, payload: { id: 'same-business-id', status: `${item.tenantId}-${modelId}` } })) };
        const result = await graphCall(item, modelId, '/ingest', { method: 'POST', body });
        assert.equal(result.ingestedFacts, 2); assert.equal(result.instance.graphProtocol, 1);
        assert.equal(result.runtimeReadEnabled, false);
        assert.equal((await graphCall(item, modelId, '/runs/same-run')).run.facts, 2);
        assert.equal((await graphCall(item, modelId, '/ingest', { method: 'POST', body })).ingestedFacts, 0);
        const invalid = structuredClone(body); invalid.facts[0].tenantId = 'foreign-tenant';
        const rejected = await fetch(`${item.endpoint}/models/${modelId}/graph/ingest`, { method: 'POST', headers: { ...headers(item), 'content-type': 'application/json' }, body: JSON.stringify(invalid) });
        assert.equal(rejected.status, 400);
      }
    }
    const expectedFingerprint = modelReceipts.get(`${a.tenantId}/finance`).fingerprint;
    assert.equal((await graphCall(a, 'finance', '/reset', { method: 'POST', body: { expectedFingerprint } })).status, 'reset');
    assert.equal((await graphCall(a, 'finance', '')).facts, 0);
    assert.equal((await graphCall(a, 'manufacturing', '')).facts, 2);
    assert.equal((await graphCall(b, 'finance', '')).facts, 2);
  });
  const governedReceipts = new Map();
  await t.test('registered workspace governance publishes, updates and reconciles real namespace definitions without runtime activation', async () => {
    resetRuntimeState(['semantic_model_registry', 'oa_meta_model_runtime', 'ontology_publication', 'domain_event_outbox']);
    const role = getRole('executive');
    for (const item of [a, b]) {
      const identityScope = { tenantId: item.tenantId, subjectId: 'synthetic-architect' };
      for (const [revision, modelId] of ['reviewed-finance', 'reviewed-production'].entries()) {
        const registered = await within(item.tenantId, () => semanticModelRegistry.register({ role, identityScope,
          body: { id: modelId, label: `${modelId}模型`, expectedRevision: revision } }));
        assert.equal(registered.error, undefined);
        await within(item.tenantId, () => semanticModelRegistry.withWorkspace({ role, identityScope, modelId, work: async () => {
          await simulateBuildOAMetaModel(role);
          const first = await publishGovernedOntology({ role, identityScope });
          assert.equal(first.error, undefined, JSON.stringify(first));
          assert.equal(first.semanticDeployment.deployment.modelId, modelId);
          const draft = await getOAMetaModelDraft(); draft.policies.push('Synthetic revised policy');
          assert.equal((await saveOAMetaModelDraft(draft, role)).error, undefined);
          await simulateBuildOAMetaModel(role);
          const lost = await publishGovernedOntology({ role, identityScope, deploy: async (...args) => {
            const actual = await publishSemanticaModelDefinition(...args);
            assert.equal(actual.status, 'published', JSON.stringify(actual));
            throw new Error('Synthetic lost response after actual namespace commit');
          } });
          assert.equal(lost.code, 'PUBLICATION_OUTCOME_UNKNOWN');
          const recovered = await publishGovernedOntology({ role, identityScope, deploy: async () => assert.fail('reconciliation must not write') });
          assert.equal(recovered.error, undefined, JSON.stringify(recovered));
          assert.equal(recovered.semanticDeployment.reconciled, true);
          assert.equal((await getPublishedOntologyModel()).runtimeReadEnabled, false);
          const { instance: _instance, ...receipt } = await getSemanticaModelDeployment();
          governedReceipts.set(`${item.tenantId}/${modelId}`, receipt);
        } }));
      }
    }
  });
  await t.test('platform synthetic admission sends to isolated real models and retains scoped provenance', async () => {
    resetRuntimeState(['semantic_synthetic_transfers']);
    for (const item of [a, b]) {
      // Explicit isolated test IAM fixture, never an enrollment or a runtime grant.
      writeState('iam', iamWorkspaceKey(item.tenantId), createInitialIAMWorkspace());
      const identityScope = { tenantId: item.tenantId, subjectId: 'usr-001' }; const role = getRole('executive');
      for (const modelId of ['reviewed-finance', 'reviewed-production']) {
        await runWithIAMStoreContext(() => within(item.tenantId, () => semanticModelRegistry.withWorkspace({ role, identityScope, modelId, work: async () => {
          const published = await getPublishedOntologyModel(); const type = published.draft.objectTypes[0];
          const body = { modelId, version: published.version, fingerprint: published.fingerprint, records: [{ id: 'platform-fact', tenantId: item.tenantId,
            organizationId: getEffectiveAccess(null, identityScope).organizationIds[0], version: 'source-v1', occurredAt: '2026-10-11T04:22:00Z',
            classification: 'internal', sourceSystem: type.sourceSystems[0], objectType: type.id, simulated: true, payload: { [type.key]: 'platform-key' } }] };
          const request = { identityScope, body, runId: 'platform-run', scenarioId: 'platform-synthetic', confirmed: true };
          const sent = await transferSyntheticFacts(request);
          assert.equal(sent.status, 'completed', JSON.stringify(sent)); assert.equal(sent.ingestedFacts, 1);
          assert.equal((await transferSyntheticFacts(request)).status, 'already_completed');
          assert.equal((await graphCall(item, modelId, '/runs/platform-run')).run.facts, 1);
          const prepared = await prepareSyntheticRelationships(request);
          assert.equal(prepared.status, 'relationship_preparation_passed', JSON.stringify(prepared));
          assert.equal(prepared.relationshipWriteAttempted, false); assert.equal(prepared.writeAuthorizationIssued, false);
          assert.equal(prepared.runProofFingerprint, (await graphCall(item, modelId, '/runs/platform-run')).run.proofFingerprint);
          if (modelId === 'reviewed-finance') {
            const lostBody = structuredClone(body); lostBody.records[0].id = 'lost-platform-fact'; lostBody.records[0].payload[type.key] = 'lost-platform-key';
            const lostRequest = { ...request, body: lostBody, runId: 'lost-platform-run', request: async (...args) => {
              const result = await requestSemanticInstance(...args);
              if (args[2]?.method === 'POST') throw new Error('Synthetic reply loss after commit');
              return result;
            } };
            assert.equal((await transferSyntheticFacts(lostRequest)).status, 'reconciliation_required');
            assert.equal((await prepareSyntheticRelationships({ ...request, body: lostBody, runId: 'lost-platform-run' })).code, 'SYNTHETIC_RELATION_COMPLETED_TRANSFER_REQUIRED');
            const recovered = await reconcileSyntheticTransfer({ ...lostRequest, request: async (...args) => {
              assert.notEqual(args[2]?.method, 'POST'); return requestSemanticInstance(...args);
            } });
            assert.equal(recovered.status, 'reconciled', JSON.stringify(recovered));
            assert.equal((await prepareSyntheticRelationships({ ...request, body: lostBody, runId: 'lost-platform-run' })).status, 'relationship_preparation_passed');
          }
        } })), item.tenantId);
      }
    }
  });
  const linkedReceipts = new Map();
  await t.test('Node governed publication, fact transfer, relationship execution and read-only recovery form a real linked loop', async () => {
    resetRuntimeState(['semantic_synthetic_relationships']);
    for (const item of [a, b]) {
      const identityScope = { tenantId: item.tenantId, subjectId: 'usr-001' }; const role = getRole('executive');
      for (const [index, modelId] of ['linked-quality', 'linked-stock'].entries()) {
        await runWithIAMStoreContext(() => within(item.tenantId, async () => {
          assert.equal((await semanticModelRegistry.register({ role, identityScope, body: { id: modelId, label: `${modelId}模型`, expectedRevision: index + 2 } })).error, undefined);
          await semanticModelRegistry.withWorkspace({ role, identityScope, modelId, work: async () => {
            const draft = await getOAMetaModelDraft();
            const objects = [
              { id: 'QualityEvent', label: '合成检验事件', key: 'id', fields: ['id', 'material_id'], source: 'qms.events', sourceSystems: ['QMS'], coreObject: 'RawMaterial', semanticType: 'QualityEvent', classification: '内部', granularity: 'event',
                fieldDefinitions: [{ name: 'material_id', reference: 'RawMaterial', referenceField: 'id' }] },
              { id: 'RawMaterial', label: '合成原料', key: 'id', fields: ['id', 'name'], source: 'erp.materials', sourceSystems: ['ERP'], coreObject: 'RawMaterial', semanticType: 'RawMaterial', classification: '内部', granularity: 'master' }
            ];
            const input = { ...draft, modelingProfile: 'general', objectTypes: objects,
              relationshipTypes: [{ from: 'QualityEvent', to: 'RawMaterial', predicate: 'inspects', cardinality: 'n:1', evidence: '合成数据字典显式外键', provenanceType: 'declared' }],
              scenario: { objective: '隔离合成关系闭环', questions: ['检验关联哪个原料？'], decisionBindings: [], actionBindings: [], readPlans: [] },
              policies: ['仅合成验证，不授予企业业务权限'], stateMachines: [], events: [], metrics: [],
              dataContracts: objects.map(object => ({ id: object.id, objectType: object.id, sourceSystem: object.sourceSystems[0], schemaVersion: 'synthetic-v1' })),
              qualityRules: objects.map(object => ({ id: object.id, objectType: object.id, rule: 'not_null' })),
              glossaryTerms: [{ term: '合成检验', definition: '仅用于独立模型联调', objectType: 'QualityEvent' }],
              accessPolicies: objects.map(object => ({ objectType: object.id, effect: 'allow', roles: ['executive'], condition: 'iam_scope' })),
              lineageEdges: objects.map(object => ({ from: object.source, to: object.id })) };
            assert.equal((await saveOAMetaModelDraft(input, role)).error, undefined);
            await simulateBuildOAMetaModel(role);
            const publication = await publishGovernedOntology({ role, identityScope });
            assert.equal(publication.error, undefined, JSON.stringify(publication));
            const published = await getPublishedOntologyModel();
            const body = { modelId, version: published.version, fingerprint: published.fingerprint,
              records: objects.map((object, ordinal) => ({ id: `linked-fact-${ordinal}`, tenantId: item.tenantId,
                organizationId: getEffectiveAccess(null, identityScope).organizationIds[0], version: 'source-v1', occurredAt: '2026-10-11T05:04:00Z',
                classification: 'internal', sourceSystem: object.sourceSystems[0], objectType: object.id, simulated: true,
                payload: ordinal ? { id: 'linked-material', name: '合成原料' } : { id: 'linked-quality', material_id: 'linked-material' } })) };
            const args = { identityScope, body, runId: 'linked-run', scenarioId: 'linked-synthetic', confirmed: true };
            assert.equal((await transferSyntheticFacts(args)).status, 'completed');
            let posts = 0;
            const execute = await materializeSyntheticRelationships({ ...args, request: async (...parameters) => {
              const receipt = await requestSemanticInstance(...parameters);
              if (parameters[2]?.method === 'POST') {
                posts++;
                if (modelId === 'linked-stock') throw new Error('Synthetic lost reply after actual materialization');
              }
              return receipt;
            } });
            assert.equal(execute.status, modelId === 'linked-stock' ? 'reconciliation_required' : 'completed', JSON.stringify(execute));
            assert.equal(posts, 1);
            if (modelId === 'linked-stock') {
              assert.equal((await materializeSyntheticRelationships(args)).code, 'SYNTHETIC_RELATION_RECONCILIATION_REQUIRED');
              const recovered = await reconcileSyntheticRelationships({ ...args, request: async (...parameters) => {
                assert.notEqual(parameters[2]?.method, 'POST'); return requestSemanticInstance(...parameters);
              } });
              assert.equal(recovered.status, 'reconciled', JSON.stringify(recovered)); assert.equal(recovered.relationshipCount, 1);
            }
            const repeat = await materializeSyntheticRelationships({ ...args, request: async (...parameters) => {
              assert.notEqual(parameters[2]?.method, 'POST'); return requestSemanticInstance(...parameters);
            } });
            assert.equal(repeat.status, 'already_completed');
            const { instance: _instance, ...receipt } = await relationCall(item, modelId, 'runs/linked-run');
            assert.equal(receipt.relationshipCount, 1); assert.equal(receipt.runtimeReadEnabled, false);
            linkedReceipts.set(`${item.tenantId}/${modelId}`, receipt);
            const revokeBody = structuredClone(body);
            for (const record of revokeBody.records) record.id = 'revoke-' + record.id;
            const revokeArgs = { ...args, body: revokeBody, runId: 'revoked-dispatch-run' };
            assert.equal((await transferSyntheticFacts(revokeArgs)).status, 'completed');
            const beforeGuard = await graphCall(item, modelId, '');
            try {
              const denied = await materializeSyntheticRelationships({ ...revokeArgs, request: async (...parameters) => {
                if (parameters[2]?.method === 'POST') {
                  const revoked = createInitialIAMWorkspace(); revoked.users.find(user => user.id === identityScope.subjectId).roleIds = [];
                  writeState('iam', iamWorkspaceKey(item.tenantId), revoked);
                }
                return requestSemanticInstance(...parameters);
              } });
              assert.equal(denied.status, 'rejected'); assert.equal(denied.relationshipWriteAttempted, false);
              assert.equal((await relationCall(item, modelId, 'runs/revoked-dispatch-run')).status, 'not_materialized');
              assert.deepEqual((await graphCall(item, modelId, '')).graph, beforeGuard.graph);
            } finally {
              writeState('iam', iamWorkspaceKey(item.tenantId), createInitialIAMWorkspace());
            }
          } });
        }), item.tenantId);
      }
    }
    assert.equal(new Set([...linkedReceipts.values()].map(receipt => receipt.projectionFingerprint)).size, 4);
  });
  await t.test('independent graphs retain only their own synthetic fact runs', async () => {
    for (const item of [a, b]) {
      const runId = `run-${item.tenantId}`;
      const facts = ['ERP', 'QMS'].map(system => ({ id: `${runId}-${system}`, sourceSystem: system, sourceRecordId: `${runId}-${system}`, objectType: 'QualityEvent', eventType: 'reported', status: 'open', classification: 'synthetic', occurredAt: '2026-09-16T00:00:00Z', runId, simulated: true, payload: { eventId: runId } }));
      const response = await fetch(`${item.endpoint}/demo/ingest`, { method: 'POST', headers: { ...headers(item), 'content-type': 'application/json' }, body: JSON.stringify({ runId, scenarioId: 'isolated-synthetic', expectedSystems: ['ERP', 'QMS'], facts }) });
      assert.equal(response.status, 200); assert.equal((await response.json()).ingestedFacts, 2);
    }
    const other = await fetch(`${b.endpoint}/demo/runs/run-${a.tenantId}`, { headers: headers(b) });
    assert.equal(other.status, 404);
    const own = await fetch(`${b.endpoint}/demo/runs/run-${b.tenantId}`, { headers: headers(b) });
    assert.equal(own.status, 200);
  });
  await t.test('incorrect endpoint binding and revoked credentials fail before publication', async () => {
    save([{ ...bindings[0], endpoint: b.endpoint }]);
    const misrouted = await within(a.tenantId, () => publishSemanticaModelDefinition(definition('wrong'), 'v3'));
    assert.equal(misrouted.requestAttempted, false); assert.equal(misrouted.reason, 'instance_identity_unverified');
    save([{ ...bindings[0], token: randomBytes(32).toString('base64url') }, bindings[1]]);
    assert.equal((await within(a.tenantId, getSemanticaModelDeployment)).status, 'unavailable');
    save([{ ...bindings[0], enabled: false }, bindings[1]]);
    assert.equal((await within(a.tenantId, getSemanticaModelDeployment)).reason, 'tenant_endpoint_required');
    assert.equal((await within(b.tenantId, getSemanticaModelDeployment)).id, 'model-1');
    save(bindings);
  });
  await t.test('resetting A does not reset B model or graph', async () => {
    assert.equal((await within(a.tenantId, resetSemanticaDemoGraph)).status, 'reset');
    assert.equal((await within(b.tenantId, getSemanticaModelDeployment)).id, 'model-1');
    const response = await fetch(`${b.endpoint}/demo/runs/run-${b.tenantId}`, { headers: headers(b) });
    assert.equal(response.status, 200);
    assert.equal((await graphCall(a, 'manufacturing', '')).facts, 2);
  });
  const localReceipts = new Map();
  const prepareLocal = async (item, modelId) => {
    const identityScope = { tenantId: item.tenantId, subjectId: 'admin@demo.local' }; const role = getRole('executive');
    seedTenantIAM(item.tenantId, ['admin@demo.local']);
    return within(item.tenantId, async () => {
      const registry = await semanticModelRegistry.list({ role, identityScope });
      assert.equal((await semanticModelRegistry.register({ role, identityScope, body: { id: modelId, label: `本机合成-${modelId}`, expectedRevision: registry.revision } })).error, undefined);
      return semanticModelRegistry.withWorkspace({ role, identityScope, modelId, work: async () => {
        await simulateBuildOAMetaModel(role);
        return { identityScope, modelId, body: { confirmed: true, expectedFingerprint: (await getOAMetaModelDraft()).fingerprint } };
      } });
    });
  };
  const localCall = request => runWithSemanticTenant(request.identityScope, () => publishLocalModelWorkspace(request));
  await t.test('actual IAM local publisher deploys two models per tenant with bounded receipts', async () => {
    for (const item of [a, b]) for (const modelId of ['local-live-one', 'local-live-two']) {
      const request = await prepareLocal(item, modelId);
      const result = await localCall(request);
      assert.equal(result.error, undefined, JSON.stringify(result)); assert.equal(result.publication.status, 'completed');
      assert.equal(result.runtimeReadEnabled, false); assert.equal(result.semanticDeployment, undefined);
      assert.equal(JSON.stringify(result).includes(item.token), false); assert.equal(JSON.stringify(result).includes(item.endpoint), false);
      const remote = await requestSemanticInstance({ ...item, guarded: true }, `/models/${modelId}/definition`, { modelId });
      assert.equal(remote.sourceFingerprint, result.publication.fingerprint); assert.equal(remote.version, result.publication.version);
      const { instance: _instance, ...receipt } = remote; localReceipts.set(`${item.tenantId}/${modelId}`, receipt);
    }
  });
  await t.test('real network waits recheck IAM and configuration; committed reply loss only reconciles', async () => {
    for (const mode of ['dispatch-revoke', 'dispatch-config', 'commit-revoke', 'reply-loss']) {
      const modelId = `local-${mode}`; const request = await prepareLocal(a, modelId);
      const actualFetch = globalThis.fetch; let probes = 0; let posts = 0;
      globalThis.fetch = async (url, options) => {
        const response = await actualFetch(url, options);
        const path = new URL(url).pathname;
        if (path === `/models/${modelId}/instance` && ++probes === 2) {
          if (mode === 'dispatch-revoke') { const state = createInitialIAMWorkspace(); state.users.find(user => user.account === request.identityScope.subjectId).roleIds = []; writeState('iam', iamWorkspaceKey(a.tenantId), state); }
          if (mode === 'dispatch-config') save([{ ...bindings[0], token: randomBytes(32).toString('base64url') }, bindings[1]]);
        }
        if (path === `/models/${modelId}/definition/publish` && options?.method === 'POST') {
          posts++; assert.equal(response.status, 200);
          if (mode === 'commit-revoke') { const state = createInitialIAMWorkspace(); state.users.find(user => user.account === request.identityScope.subjectId).roleIds = []; writeState('iam', iamWorkspaceKey(a.tenantId), state); }
          if (mode === 'reply-loss') { await response.body?.cancel(); throw new Error('Synthetic reply loss after real local commit'); }
        }
        return response;
      };
      let result;
      try { result = await localCall(request); }
      finally { globalThis.fetch = actualFetch; save(bindings); seedTenantIAM(a.tenantId, ['admin@demo.local']); }
      assert.ok(result.error); assert.equal(posts, mode.startsWith('dispatch') ? 0 : 1);
      const remote = await requestSemanticInstance({ ...a, guarded: true }, `/models/${modelId}/definition`, { modelId });
      assert.equal(remote.status, mode.startsWith('dispatch') ? 'not_published' : 'published');
      if (!mode.startsWith('dispatch')) {
        let retryPosts = 0;
        globalThis.fetch = async (url, options) => { if (options?.method === 'POST') retryPosts++; return actualFetch(url, options); };
        try { assert.equal((await localCall(request)).publication.status, 'completed'); }
        finally { globalThis.fetch = actualFetch; }
        assert.equal(retryPosts, 0);
      }
    }
  });
  await t.test('authenticated API publishes same model ID in two tenants through real local Python instances', async () => {
    const probe = createServer(); await new Promise(resolvePort => probe.listen(0, '127.0.0.1', resolvePort));
    const port = probe.address().port; await new Promise(resolveClosed => probe.close(resolveClosed));
    const worker = fork('backend/test/helpers/tenant-iam-http-worker.mjs', [], { execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, NODE_ENV: 'test', NODE_TEST_CONTEXT: 'child-v8', RUNTIME_STORE_DRIVER: 'memory', IAM_STORE_DRIVER: 'runtime', IDENTITY_SESSION_STORE_DRIVER: 'runtime',
        IDENTITY_PROVIDERS_FILE: '', DEMO_ALLOW_ROLE_HEADER: 'false', API_HOST: '127.0.0.1', PORT: String(port), SEMANTIC_TEST_HTTP_TENANTS: JSON.stringify([a.tenantId, b.tenantId]) } });
    worker.stdout.on('data', () => {}); worker.stderr.on('data', () => {});
    const closed = once(worker, 'close');
    try {
      const [{ sessions }] = await Promise.race([once(worker, 'message'), closed.then(() => { throw new Error('Isolated API startup failed'); })]);
      const base = `http://127.0.0.1:${port}`;
      for (let attempt = 0; attempt < 50; attempt++) {
        try { if ((await fetch(`${base}/api/health/live`)).ok) break; } catch { /* Isolated listener startup. */ }
        await new Promise(resolveWait => setTimeout(resolveWait, 50));
      }
      const versions = [];
      for (const item of [a, b]) {
        const call = async (path, body) => {
          const response = await fetch(`${base}/api/semantic-operations/models${path}`, { method: body ? 'POST' : 'GET',
            headers: { 'x-identity-session': sessions[item.tenantId], 'x-client-device-id': 'test-device', 'content-type': 'application/json', 'x-tenant-id': item === a ? b.tenantId : a.tenantId },
            ...(body ? { body: JSON.stringify(body) } : {}) });
          return { status: response.status, body: await response.json() };
        };
        assert.equal((await call('', { id: 'local-http-one', label: '隔离HTTP发布', expectedRevision: 0 })).status, 201);
        const confirmation = { confirmed: true, expectedFingerprint: (await call('/local-http-one/draft')).body.draft.fingerprint };
        assert.equal((await call('/local-http-one/simulate', confirmation)).status, 200);
        const published = await call('/local-http-one/publish', confirmation);
        assert.equal(published.status, 200, JSON.stringify(published.body)); assert.equal(published.body.publication.status, 'completed');
        assert.equal(published.body.runtimeReadEnabled, false); assert.equal(published.body.semanticDeployment, undefined);
        assert.equal(JSON.stringify(published.body).includes(item.token), false);
        const remote = await requestSemanticInstance({ ...item, guarded: true }, '/models/local-http-one/definition', { modelId: 'local-http-one' });
        assert.equal(remote.version, published.body.publication.version); assert.equal(remote.sourceFingerprint, confirmation.expectedFingerprint);
        versions.push(remote.version);
        assert.equal((await call('/local-http-one/publish', confirmation)).body.code, 'PUBLICATION_ALREADY_COMPLETED');
      }
      assert.notEqual(versions[0], versions[1]);
    } finally { worker.kill(); await closed; }
  });
  await t.test('abrupt restart and key rotation preserve only committed durable state', async () => {
    const beforeRestart = await within(b.tenantId, getSemanticaModelDeployment);
    const exited = once(b.child, 'exit'); b.child.kill(); await exited;
    let restoredPath;
    if (durable) {
      const runOffline = async (operation, source, target) => {
        const args = ['services/semantic-context/manage_instance_store.py', operation, '--config', join(directory, 'b.json'), '--source', source];
        if (target) args.push('--target', target);
        const result = await execute(python, args, { cwd: resolve('.'), windowsHide: true, timeout: 45000 });
        return JSON.parse(result.stdout.trim());
      };
      const backup = join(directory, 'b-backup.db'); restoredPath = join(directory, 'b-restored.db');
      assert.equal((await runOffline('backup', join(directory, 'b.db'), backup)).status, 'completed');
      assert.equal((await runOffline('verify', backup)).status, 'verified');
      assert.equal((await runOffline('restore', backup, restoredPath)).status, 'completed');
    }
    const restarted = await start('b', restoredPath); save([bindings[0], { tenantId: restarted.tenantId, deploymentId: restarted.deploymentId, token: restarted.token, endpoint: restarted.endpoint, enabled: true }]);
    const oldCredential = await fetch(`${restarted.endpoint}/instance`, { headers: headers(b) });
    assert.equal(oldCredential.status, 403);
    const recovered = await within(b.tenantId, getSemanticaModelDeployment);
    assert.equal(recovered.status, durable ? 'published' : 'not_published');
    if (durable) assert.deepEqual(recovered, beforeRestart);
    for (const modelId of ['local-live-one', 'local-live-two']) {
      const { instance: _instance, ...receipt } = await requestSemanticInstance({ ...restarted, guarded: true }, `/models/${modelId}/definition`, { modelId });
      assert.equal(receipt.status, durable ? 'published' : 'not_published');
      if (durable) assert.deepEqual(receipt, localReceipts.get(`${b.tenantId}/${modelId}`));
    }
    for (const modelId of ['finance', 'manufacturing']) {
      const model = await requestSemanticInstance({ ...restarted, guarded: true }, `/models/${modelId}/definition`, { modelId });
      assert.equal(model.status, durable ? 'published' : 'not_published');
      if (durable) {
        const { instance: _instance, ...receipt } = model;
        assert.deepEqual(receipt, modelReceipts.get(`${b.tenantId}/${modelId}`));
      }
      assert.equal((await graphCall(restarted, modelId, '')).facts, durable ? 2 : 0);
    }
    for (const modelId of ['reviewed-finance', 'reviewed-production']) {
      const model = await requestSemanticInstance({ ...restarted, guarded: true }, `/models/${modelId}/definition`, { modelId });
      assert.equal(model.status, durable ? 'published' : 'not_published');
      if (durable) {
        const { instance: _instance, ...receipt } = model;
        assert.deepEqual(receipt, governedReceipts.get(`${b.tenantId}/${modelId}`));
      }
      assert.equal((await graphCall(restarted, modelId, '')).facts, durable ? modelId === 'reviewed-finance' ? 2 : 1 : 0);
    }
    for (const modelId of ['relations-finance', 'relations-production']) {
      if (durable) {
        const { instance: _instance, ...receipt } = await relationCall(restarted, modelId, 'runs/same-run');
        assert.deepEqual(receipt, relationReceipts.get(`${b.tenantId}/${modelId}`));
      } else {
        const response = await fetch(`${restarted.endpoint}/models/${modelId}/graph/relationships/runs/same-run`, { headers: headers(restarted) });
        assert.equal(response.status, 404);
      }
    }
    for (const modelId of ['linked-quality', 'linked-stock']) {
      if (durable) {
        const { instance: _instance, ...receipt } = await relationCall(restarted, modelId, 'runs/linked-run');
        assert.deepEqual(receipt, linkedReceipts.get(`${b.tenantId}/${modelId}`));
      } else {
        const response = await fetch(`${restarted.endpoint}/models/${modelId}/graph/relationships/runs/linked-run`, { headers: headers(restarted) });
        assert.equal(response.status, 404);
      }
    }
    const run = await fetch(`${restarted.endpoint}/demo/runs/run-${b.tenantId}`, { headers: headers(restarted) });
    assert.equal(run.status, durable ? 200 : 404);
    if (durable) assert.equal((await run.json()).run.validation.passed, true);
    // A reset must remain reset after its own restart, and cannot erase its model.
    const aExit = once(a.child, 'exit'); a.child.kill(); await aExit;
    const recoveredA = await start('a');
    const aRun = await fetch(`${recoveredA.endpoint}/demo/runs/run-${a.tenantId}`, { headers: headers(recoveredA) });
    assert.equal(aRun.status, 404);
    const aModel = await fetch(`${recoveredA.endpoint}/demo/model-definition`, { headers: headers(recoveredA) });
    assert.equal((await aModel.json()).status, durable ? 'published' : 'not_published');
    for (const modelId of ['finance', 'manufacturing']) {
      const model = await requestSemanticInstance({ ...recoveredA, guarded: true }, `/models/${modelId}/definition`, { modelId });
      assert.equal(model.status, durable ? 'published' : 'not_published');
      assert.equal((await graphCall(recoveredA, modelId, '')).facts, durable && modelId === 'manufacturing' ? 2 : 0);
    }
  });
});
