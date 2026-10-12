import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { runWithSemanticTenant, currentSemanticTenant, semanticTenantStateKey, currentSemanticModel, currentSemanticModelRegistered, runWithSemanticModelWorkspace, DEFAULT_SEMANTIC_MODEL_ID, semanticModelStateKey } from '../src/services/semantic-tenant-context.js';
import { getOAMetaModelDraft, saveOAMetaModelDraft, getOAMetaModelSimulation, simulateBuildOAMetaModel, publishOAMetaModel, getPublishedOntologyModel } from '../src/services/meta-model-service.js';
import { getRole } from '../src/services/authorization-service.js';
import { handleGovernanceRoutes } from '../src/routes/governance-routes.js';
import { createSemanticOperationsProposal, applySemanticOperationsProposal, rollbackSemanticOperationsSnapshot, listSemanticOperationsSnapshots } from '../src/services/semantic-operations-agent-service.js';
import { readSemanticGovernanceState, mutateSemanticGovernanceState, mutateSemanticGovernanceStates, mutateSemanticGovernanceWithEvent, configureSemanticGovernanceRepository } from '../src/services/semantic-governance-store.js';
import { getWorldModelTemplates, createWorldModelDraft, getWorldModelDrafts, validateWorldModelDraft } from '../src/services/world-model-template-service.js';
import { getSemanticaModelDiscovery, getSemanticaModelDeployment, publishSemanticaModelDefinition, resetSemanticaDemoGraph } from '../src/services/semantica-demo-bridge-service.js';
import { createSemanticInspectionSchedule, runSemanticInspectionCycle } from '../src/services/semantic-inspection-schedule-service.js';
import { listDomainEvents } from '../src/infrastructure/domain-events/domain-event-outbox.js';
import { semanticModelRegistry } from '../src/services/semantic-model-registry.js';
import { publishGovernedOntology } from '../src/services/ontology-runtime-service.js';
import { getPublishedAgentOntology } from '../src/services/published-ontology-agent-service.js';
import { archiveSemanticOperationsTask, createSemanticOperationsTask, executeSemanticOperationsTask, getSemanticOperationsTask, issueSemanticOperationsTaskConfirmation, listSemanticOperationsTasks, prepareOnboardingSemanticTask, recordSemanticOperationsReportExport, reviseSemanticOperationsTaskProposal } from '../src/services/semantic-operations-task-service.js';
import { semanticOperationsPrincipalKey } from '../src/services/semantic-operations-identity.js';
import { semanticFingerprint } from '../src/services/semantic-model-fingerprint.js';
import { asyncRuntimeStateRepository } from '../src/repositories/async-runtime-state-repository.js';
import { runWithIAMStoreContext, configureIAMRepository } from '../src/services/iam-store.js';
import { createInitialIAMWorkspace } from '../src/services/iam-workspace-model.js';
import { prepareSyntheticFactTransfer } from '../../services/semantic-context/synthetic-fact-preparation.js';
import { transferSyntheticFacts } from '../../services/semantic-context/synthetic-fact-transfer.js';
import { reconcileSyntheticTransfer } from '../../services/semantic-context/synthetic-fact-reconciliation.js';
import { prepareSyntheticRelationships } from '../../services/semantic-context/synthetic-relationship-preparation.js';
import { materializeSyntheticRelationships, reconcileSyntheticRelationships } from '../../services/semantic-context/synthetic-relationship-execution.js';
import { wireFingerprint } from '../../services/semantic-context/synthetic-proof.js';
import { getEffectiveAccess } from '../src/services/access-control-service.js';
import { previewSyntheticFactAdmission } from '../src/services/semantic-synthetic-fact-admission.js';

if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'memory') throw new Error('Use the runtime-test-bootstrap memory store.');
const role = getRole('executive');
const identity = tenantId => ({ tenantId, subjectId: 'same-architect', deviceId: 'same-device' });
const within = (tenant, work) => runWithSemanticTenant(identity(tenant), work);
test('SQLite transfer journal survives independent process restarts, blocks resend and reconciles only via reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-transfer-restart-'));
  try {
    const env = { ...process.env, NODE_ENV: 'test', RUNTIME_STORE_DRIVER: 'sqlite', RUNTIME_SQLITE_PATH: join(directory, 'runtime.db') };
    for (const mode of ['seed', 'verify', 'reconcile', 'verify-again', 'relation-seed', 'relation-verify', 'relation-reconcile', 'relation-verify-again']) {
      const result = await promisify(execFile)(process.execPath, ['backend/test/helpers/synthetic-transfer-worker.mjs', mode], { env, windowsHide: true });
      assert.equal(JSON.parse(result.stdout).status, 'passed');
    }
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
test.beforeEach(() => resetRuntimeState(['semantic_model_registry', 'oa_meta_model_runtime', 'ontology_publication', 'world_model_runtime', 'semantic_operations_agent_tasks', 'semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'semantic_inspection_schedules', 'semantic_operations_notifications', 'semantic_synthetic_transfers', 'semantic_synthetic_relationships', 'domain_event_outbox']));

async function seedValidationTask(principal, modelId = currentSemanticModel()) {
  const task = { id: 'same-task', modelId, owner: semanticOperationsPrincipalKey(principal), originRoleId: role.id,
    status: 'waiting_confirmation', intent: 'validate_model', command: 'validate_model', requiredPermission: 'meta_model.draft.save',
    confirmationRequired: true, confirmation: { state: 'not_issued' }, createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z',
    messages: [], events: [], reviewContext: { draftFingerprint: semanticFingerprint(await getOAMetaModelDraft()) } };
  await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, () => ({ value: { [task.id]: task } }));
  return task;
}

test('model tasks: wrong-model records and parent references deny every access and mutation', async () => {
  const principal = identity('task-model-test');
  await within(principal.tenantId, async () => {
    await seedValidationTask(principal, 'finance');
    const request = { taskId: 'same-task', identityScope: principal, role };
    assert.equal(await getSemanticOperationsTask(request), null);
    const listed = await listSemanticOperationsTasks({ identityScope: principal });
    assert.equal(listed.length, 0);
    assert.equal((await archiveSemanticOperationsTask(request)).code, 'SEMANTIC_TASK_NOT_FOUND');
    assert.equal((await recordSemanticOperationsReportExport({ ...request, receipt: { destination: 'semantic_reports', fileName: 'test.md', sha256: 'a'.repeat(64), bytes: 10 } })).code, 'SEMANTIC_TASK_NOT_FOUND');
    assert.equal((await reviseSemanticOperationsTaskProposal({ ...request, body: {} })).code, 'SEMANTIC_TASK_NOT_FOUND');
    assert.equal((await issueSemanticOperationsTaskConfirmation(request)).code, 'SEMANTIC_TASK_REVIEW_ACCESS_DENIED');
    assert.equal((await executeSemanticOperationsTask(request)).code, 'SEMANTIC_TASK_REVIEW_ACCESS_DENIED');
    assert.equal((await createSemanticOperationsTask({ role, identityScope: principal, body: { text: '继续', parentTaskId: 'same-task' } })).code, 'SEMANTIC_PARENT_TASK_NOT_FOUND');
    assert.equal((await createSemanticOperationsTask({ role, identityScope: principal, body: { text: '你好', modelId: 'finance' } })).code, 'SEMANTIC_TASK_MODEL_MISMATCH');
    const stored = await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {});
    assert.equal(stored['same-task'].confirmation.state, 'not_issued'); assert.equal(stored['same-task'].events.length, 0);
  });
});

test('synthetic admission preview binds published model, explicit provenance and authorized organization without sending data', async () => {
  const principal = { tenantId: 'demo-enterprise', subjectId: 'usr-001' };
  await runWithIAMStoreContext(() => runWithSemanticTenant(principal, async () => {
    await semanticModelRegistry.register({ role, identityScope: principal, body: { id: 'finance', label: '财务模型', expectedRevision: 0 } });
    await semanticModelRegistry.withWorkspace({ role, identityScope: principal, modelId: 'finance', work: async () => {
      const draft = await getOAMetaModelDraft(); const fingerprint = semanticFingerprint(draft);
      const type = draft.objectTypes[0];
      const organizationId = getEffectiveAccess(null, principal).organizationIds[0];
      await mutateSemanticGovernanceState('oa_meta_model_runtime', 'workspace', {}, state => ({ value: { ...state, publishedModel: { tenantId: principal.tenantId, version: 'synthetic-v1', fingerprint, draft } } }));
      const body = { modelId: 'finance', version: 'synthetic-v1', fingerprint, records: [{ id: 'record-1', ...{ tenantId: principal.tenantId },
        organizationId, version: 'source-v1', occurredAt: '2026-10-11T01:00:00Z', classification: 'internal', sourceSystem: type.sourceSystems[0], objectType: type.id,
        simulated: true, payload: { [type.key]: 'synthetic-key' } }] };
      const run = input => previewSyntheticFactAdmission({ identityScope: principal, body: input });
      const result = await run(body);
      assert.equal(result.status, 'preview_passed', JSON.stringify(result)); assert.equal(result.recordCount, 1);
      assert.equal(result.requestAttempted, false); assert.doesNotMatch(JSON.stringify(result), /synthetic-key|record-1|org-001/);
      for (const patch of [{ simulated: false }, { tenantId: 'other' }, { organizationId: 'unknown-org' }, { version: '' }, { occurredAt: '2026-10-11' }]) {
        const invalid = structuredClone(body); Object.assign(invalid.records[0], patch);
        assert.equal((await run(invalid)).code, 'SYNTHETIC_FACT_PROVENANCE_INVALID');
      }
      assert.equal((await run({ ...body, modelId: 'production' })).code, 'SYNTHETIC_FACT_INPUT_INVALID');
      assert.equal((await run({ ...body, version: 'old' })).code, 'SYNTHETIC_FACT_PUBLICATION_STALE');
      const unknown = structuredClone(body); unknown.records[0].sourceSystem = 'WMS';
      assert.equal((await run(unknown)).code, 'SYNTHETIC_FACT_SOURCE_UNDECLARED');
      const nested = structuredClone(body); nested.records[0].payload[type.key] = { script: 'not executable' };
      assert.equal((await run(nested)).code, 'SYNTHETIC_FACT_SCHEMA_INVALID');
      assert.equal((await previewSyntheticFactAdmission({ identityScope: { ...principal, subjectId: 'missing-user' }, body })).code, 'SYNTHETIC_FACT_FORBIDDEN');
    } });
  }), principal.tenantId);
});

test('synthetic preparation and local transfer retain fresh IAM, scoped provenance and no-retry outcomes', async () => {
  const principal = { tenantId: 'demo-enterprise', subjectId: 'usr-001' };
  await runWithSemanticTenant(principal, async () => {
    await semanticModelRegistry.register({ role, identityScope: principal, body: { id: 'finance', label: '财务模型', expectedRevision: 0 } });
    await semanticModelRegistry.withWorkspace({ role, identityScope: principal, modelId: 'finance', work: async () => {
      const draft = await getOAMetaModelDraft(); const fingerprint = semanticFingerprint(draft); const type = draft.objectTypes[0];
      const publishedModel = { tenantId: principal.tenantId, version: 'synthetic-v1', fingerprint, draft };
      const lock = { status: 'completed', modelId: 'finance', version: publishedModel.version, fingerprint,
        target: { tenantId: principal.tenantId, modelId: 'finance', deploymentId: 'synthetic-deployment' } };
      const seed = async () => {
        await mutateSemanticGovernanceState('oa_meta_model_runtime', 'workspace', {}, state => ({ value: { ...state, publishedModel: structuredClone(publishedModel) } }));
        await mutateSemanticGovernanceState('ontology_publication', 'current', null, () => ({ value: structuredClone(lock) }));
      };
      await seed();
      const body = { modelId: 'finance', version: publishedModel.version, fingerprint, records: [{ id: 'record-1', tenantId: principal.tenantId,
        organizationId: getEffectiveAccess(null, principal).organizationIds[0], version: 'source-v1', occurredAt: '2026-10-11T01:00:00Z',
        classification: 'internal', sourceSystem: type.sourceSystems[0], objectType: type.id, simulated: true, payload: { [type.key]: 'private-synthetic-key' } }] };
      const receipt = { status: 'published', id: 'oa-governance', modelId: 'finance', modelProtocol: 1, version: publishedModel.version, sourceFingerprint: fingerprint,
        fingerprint: 'e'.repeat(20), projectionScope: 'definition_only', runtimeReadEnabled: false,
        instance: { ...lock.target, protocol: 1, modelProtocol: 1, identityVerified: true, projectionScope: 'definition_only', runtimeReadEnabled: false } };
      const run = inspect => prepareSyntheticFactTransfer({ identityScope: principal, body, inspect });
      const passed = await run(async () => structuredClone(receipt));
      assert.equal(passed.status, 'preparation_passed', JSON.stringify(passed));
      assert.equal(passed.graphFingerprint, receipt.fingerprint); assert.equal(passed.sourceFingerprint, fingerprint);
      assert.equal(passed.factWriteAttempted, false); assert.equal(passed.writeAuthorizationIssued, false);
      assert.doesNotMatch(JSON.stringify(passed), /private-synthetic-key|synthetic-deployment|record-1/);
      for (const patch of [{ id: 'other-definition' }, { sourceFingerprint: 'old' }, { version: 'old' }, { modelId: 'production' }, { fingerprint: '' }, { runtimeReadEnabled: true }]) {
        assert.equal((await run(async () => ({ ...receipt, ...patch }))).code, 'SYNTHETIC_FACT_DEPLOYMENT_DRIFT');
      }
      assert.equal((await run(async () => ({ ...receipt, instance: { ...receipt.instance, deploymentId: 'other' } }))).code, 'SYNTHETIC_FACT_DEPLOYMENT_DRIFT');
      assert.equal((await run(async () => { throw new Error('secret-url-token'); })).code, 'SYNTHETIC_FACT_PREPARATION_FAILED');
      const invalid = structuredClone(body); invalid.records[0].simulated = false;
      const denied = await prepareSyntheticFactTransfer({ identityScope: principal, body: invalid, inspect: async () => { throw new Error('Must not inspect'); } });
      assert.equal(denied.code, 'SYNTHETIC_FACT_PROVENANCE_INVALID'); assert.equal(denied.readRequestAttempted, false);
      let calls = 0;
      await mutateSemanticGovernanceState('ontology_publication', 'current', null, () => ({ value: { ...lock, status: 'reconciliation_required' } }));
      assert.equal((await run(async () => { calls++; return receipt; })).code, 'SYNTHETIC_FACT_DEPLOYMENT_REQUIRED'); assert.equal(calls, 0);
      await seed();
      assert.equal((await run(async () => {
        await mutateSemanticGovernanceState('ontology_publication', 'current', null, () => ({ value: { ...lock, completedAt: 'changed' } })); return receipt;
      })).code, 'SYNTHETIC_FACT_CONTEXT_CHANGED');
      await seed();
      assert.equal((await run(async () => {
        await mutateSemanticGovernanceState('oa_meta_model_runtime', 'workspace', {}, state => ({ value: { ...state, publishedModel: { ...publishedModel, version: 'v2' } } })); return receipt;
      })).code, 'SYNTHETIC_FACT_PUBLICATION_STALE');
      await seed();
      // Simulates PostgreSQL request snapshots: the outer snapshot stays old,
      // while each nested context must load the repository again after await.
      let iam = createInitialIAMWorkspace(); let loads = 0;
      configureIAMRepository({ readState: async () => { loads++; return structuredClone(iam); },
        mutateState: async () => { throw new Error('Unexpected IAM write'); }, mutateStates: async () => { throw new Error('Unexpected IAM write'); } });
      try {
        assert.equal((await runWithIAMStoreContext(() => run(async () => structuredClone(receipt)), principal.tenantId)).status, 'preparation_passed');
        assert.ok(loads >= 3);
        assert.equal((await runWithIAMStoreContext(() => run(async () => { iam.configurationVersion++; return receipt; }), principal.tenantId)).code, 'SYNTHETIC_FACT_CONTEXT_CHANGED');
        iam = createInitialIAMWorkspace();
        assert.equal((await runWithIAMStoreContext(() => run(async () => { iam.users.find(user => user.id === principal.subjectId).roleIds = []; return receipt; }), principal.tenantId)).code, 'SYNTHETIC_FACT_FORBIDDEN');
      } finally { configureIAMRepository(null); }
      const target = { tenantId: principal.tenantId, deploymentId: lock.target.deploymentId, endpoint: 'http://127.0.0.1:9999', guarded: true, token: 'isolated-test-token' };
      let writes = 0;
      const transfer = (runId, patch = {}) => transferSyntheticFacts({ identityScope: principal, body, runId, scenarioId: 'isolated-test', confirmed: true,
        connection: () => target, request: async (_connection, _path, options) => {
          if (options.method !== 'POST') return structuredClone(receipt);
          writes++; const fact = options.body.facts[0];
          assert.equal(fact.organizationId, body.records[0].organizationId); assert.equal(fact.sourceVersion, body.records[0].version);
          assert.equal(fact.modelFingerprint, receipt.fingerprint); assert.equal(options.body.expectedFingerprint, receipt.fingerprint);
          return { status: 'ingested', modelId: 'finance', graphProtocol: 1, projectionScope: 'synthetic_graph', runtimeReadEnabled: false,
            modelVersion: body.version, modelFingerprint: receipt.fingerprint, run: { runId, proofFingerprint: wireFingerprint(options.body, 'finance', body.version) }, ingestedFacts: 1,
            instance: { ...receipt.instance, graphProtocol: 1, projectionScope: 'synthetic_graph' } };
        }, ...patch });
      assert.equal((await transfer('completed-run', { confirmed: false })).code, 'SYNTHETIC_TRANSFER_CONFIRMATION_REQUIRED');
      assert.equal((await transfer('completed-run', { connection: () => ({ ...target, endpoint: 'https://enterprise.example' }) })).code, 'SYNTHETIC_TRANSFER_LOCAL_INSTANCE_REQUIRED');
      assert.equal(writes, 0);
      const sent = await transfer('completed-run'); assert.equal(sent.status, 'completed', JSON.stringify(sent)); assert.equal(writes, 1);
      assert.doesNotMatch(JSON.stringify(sent), /private-synthetic-key|isolated-test-token|record-1/);
      assert.equal((await transfer('completed-run')).status, 'already_completed'); assert.equal(writes, 1);
      assert.equal((await transfer('completed-run', { request: async () => ({ ...receipt, fingerprint: 'f'.repeat(20) }) })).code, 'SYNTHETIC_TRANSFER_CONTEXT_CHANGED');
      assert.equal(writes, 1);
      const journal = await readSemanticGovernanceState('semantic_synthetic_transfers', 'index', {});
      assert.equal(journal['completed-run'].provenance[0].sourceVersion, 'source-v1');
      assert.doesNotMatch(JSON.stringify(journal), /private-synthetic-key|isolated-test-token/); assert.equal(journal['completed-run'].token, undefined);
      const runReceipt = { status: 'ready', modelId: 'finance', modelVersion: body.version, modelFingerprint: receipt.fingerprint,
        graphProtocol: 1, projectionScope: 'synthetic_graph', runtimeReadEnabled: false,
        run: { runId: 'completed-run', facts: 1, proofFingerprint: journal['completed-run'].proofFingerprint },
        instance: { ...receipt.instance, graphProtocol: 1, projectionScope: 'synthetic_graph' } };
      let relationReads = 0;
      const relationPrepare = (patch = {}, onRead = async () => {}) => prepareSyntheticRelationships({ identityScope: principal, body,
        runId: 'completed-run', scenarioId: 'isolated-test', connection: () => target, request: async (_target, path, options) => {
          assert.notEqual(options.method, 'POST');
          if (path.endsWith('/definition')) return structuredClone(receipt);
          relationReads++; await onRead(); return { ...structuredClone(runReceipt), ...patch };
        } });
      const preparedRelations = await relationPrepare();
      assert.equal(preparedRelations.status, 'relationship_preparation_passed', JSON.stringify(preparedRelations));
      assert.equal(preparedRelations.runProofFingerprint, journal['completed-run'].proofFingerprint);
      assert.equal(preparedRelations.relationshipWriteAttempted, false); assert.equal(preparedRelations.writeAuthorizationIssued, false);
      assert.doesNotMatch(JSON.stringify(preparedRelations), /private-synthetic-key|isolated-test-token|record-1|synthetic-deployment/);
      for (const patch of [{ status: 'not_found' }, { modelId: 'production' }, { modelVersion: 'old' }, { modelFingerprint: 'old' },
        { run: { ...runReceipt.run, proofFingerprint: 'forged' } }, { run: { ...runReceipt.run, facts: 2 } }, { runtimeReadEnabled: true },
        { instance: { ...runReceipt.instance, deploymentId: 'other' } }]) {
        assert.equal((await relationPrepare(patch)).code, 'SYNTHETIC_RELATION_FACT_PROOF_UNCONFIRMED');
      }
      for (const patch of [{ status: 'dispatching' }, { subjectId: 'other' }, { inputDigest: 'forged' }]) {
        await mutateSemanticGovernanceState('semantic_synthetic_transfers', 'index', {}, index => ({ value: { ...index, 'completed-run': { ...journal['completed-run'], ...patch } } }));
        const beforeReads = relationReads;
        assert.equal((await relationPrepare()).code, 'SYNTHETIC_RELATION_COMPLETED_TRANSFER_REQUIRED');
        assert.equal(relationReads, beforeReads);
      }
      await mutateSemanticGovernanceState('semantic_synthetic_transfers', 'index', {}, () => ({ value: structuredClone(journal) }));
      assert.equal((await relationPrepare({}, async () => {
        await mutateSemanticGovernanceState('semantic_synthetic_transfers', 'index', {}, index => {
          index['completed-run'].updatedAt = 'changed'; return { value: index };
        });
      })).code, 'SYNTHETIC_RELATION_CONTEXT_CHANGED');
      await mutateSemanticGovernanceState('semantic_synthetic_transfers', 'index', {}, () => ({ value: structuredClone(journal) }));
      let relationIAM = createInitialIAMWorkspace();
      configureIAMRepository({ readState: async () => structuredClone(relationIAM), mutateState: async () => { throw new Error('No IAM writes'); }, mutateStates: async () => { throw new Error('No IAM writes'); } });
      try {
        assert.equal((await runWithIAMStoreContext(() => relationPrepare({}, async () => { relationIAM.configurationVersion++; }), principal.tenantId)).code, 'SYNTHETIC_RELATION_CONTEXT_CHANGED');
        relationIAM = createInitialIAMWorkspace();
        assert.equal((await runWithIAMStoreContext(() => relationPrepare({}, async () => { relationIAM.users.find(user => user.id === principal.subjectId).roleIds = []; }), principal.tenantId)).code, 'SYNTHETIC_FACT_FORBIDDEN');
      } finally { configureIAMRepository(null); }
      assert.equal(writes, 1); assert.deepEqual(await readSemanticGovernanceState('semantic_synthetic_transfers', 'index', {}), journal);
      let relationWrites = 0;
      const projectedReceipt = { status: 'materialized', modelId: 'finance', runId: 'completed-run', modelVersion: body.version,
        modelFingerprint: receipt.fingerprint, runProofFingerprint: journal['completed-run'].proofFingerprint,
        projectionFingerprint: 'b'.repeat(64), relationshipCount: 1, relationshipProtocol: 1, projectionScope: 'synthetic_relationships', runtimeReadEnabled: false,
        instance: { ...receipt.instance, relationshipProtocol: 1, projectionScope: 'synthetic_relationships' } };
      const relationArgs = { identityScope: principal, body, runId: 'completed-run', scenarioId: 'isolated-test', confirmed: true,
        connection: () => target, request: async (_target, path, options) => {
          if (path.endsWith('/definition')) return structuredClone(receipt);
          if (options.projectionScope === 'synthetic_graph') return structuredClone(runReceipt);
          if (options.method === 'POST') relationWrites++;
          return structuredClone(projectedReceipt);
        } };
      assert.equal((await materializeSyntheticRelationships({ ...relationArgs, confirmed: false })).code, 'SYNTHETIC_RELATION_CONFIRMATION_REQUIRED');
      assert.equal(relationWrites, 0);
      const materialized = await materializeSyntheticRelationships(relationArgs);
      assert.equal(materialized.status, 'completed', JSON.stringify(materialized)); assert.equal(relationWrites, 1);
      assert.equal((await materializeSyntheticRelationships(relationArgs)).status, 'already_completed'); assert.equal(relationWrites, 1);
      const relationJournal = await readSemanticGovernanceState('semantic_synthetic_relationships', 'index', {});
      assert.equal(relationJournal['completed-run'].projectionFingerprint, projectedReceipt.projectionFingerprint);
      assert.doesNotMatch(JSON.stringify(relationJournal), /private-synthetic-key|isolated-test-token/); assert.equal(relationJournal['completed-run'].token, undefined);
      resetRuntimeState(['semantic_synthetic_relationships']);
      const concurrentRelations = await Promise.all([materializeSyntheticRelationships(relationArgs), materializeSyntheticRelationships(relationArgs)]);
      assert.equal(concurrentRelations.filter(item => item.status === 'completed').length, 1); assert.equal(relationWrites, 2);
      resetRuntimeState(['semantic_synthetic_relationships']);
      assert.equal((await materializeSyntheticRelationships({ ...relationArgs, request: async (...args) => {
        const result = await relationArgs.request(...args);
        if (args[2]?.method === 'POST') throw new Error('Synthetic reply lost after materialization');
        return result;
      } })).status, 'reconciliation_required');
      assert.equal((await materializeSyntheticRelationships(relationArgs)).code, 'SYNTHETIC_RELATION_RECONCILIATION_REQUIRED');
      assert.equal(relationWrites, 3);
      const reconcileRelations = patch => reconcileSyntheticRelationships({ ...relationArgs, request: async (...args) => {
        assert.notEqual(args[2]?.method, 'POST'); const result = await relationArgs.request(...args);
        return args[2]?.projectionScope === 'synthetic_relationships' ? { ...result, ...patch } : result;
      } });
      for (const patch of [{ status: 'not_materialized' }, { runProofFingerprint: 'forged' }, { modelId: 'production' },
        { relationshipCount: 1001 }, { projectionFingerprint: 'bad' }, { runtimeReadEnabled: true }]) {
        assert.equal((await reconcileRelations(patch)).code, 'SYNTHETIC_RELATION_PROOF_UNCONFIRMED');
      }
      await mutateSemanticGovernanceState('semantic_synthetic_relationships', 'index', {}, index => {
        index['completed-run'].status = 'dispatching'; index['completed-run'].leaseExpiresAt = new Date(Date.now() + 60000).toISOString(); return { value: index };
      });
      assert.equal((await reconcileRelations({})).code, 'SYNTHETIC_RELATION_BUSY');
      await mutateSemanticGovernanceState('semantic_synthetic_relationships', 'index', {}, index => {
        index['completed-run'].leaseExpiresAt = '2000-01-01T00:00:00Z'; return { value: index };
      });
      assert.equal((await reconcileRelations({})).status, 'reconciled'); assert.equal(relationWrites, 3);
      assert.equal((await materializeSyntheticRelationships(relationArgs)).status, 'already_completed'); assert.equal(relationWrites, 3);
      resetRuntimeState(['semantic_synthetic_relationships']);
      relationIAM = createInitialIAMWorkspace();
      configureIAMRepository({ readState: async () => structuredClone(relationIAM), mutateState: async () => { throw new Error('No IAM writes'); }, mutateStates: async () => { throw new Error('No IAM writes'); } });
      try {
        const revokedAfterSend = await runWithIAMStoreContext(() => materializeSyntheticRelationships({ ...relationArgs, request: async (...args) => {
          const result = await relationArgs.request(...args);
          if (args[2]?.method === 'POST') relationIAM.users.find(user => user.id === principal.subjectId).roleIds = [];
          return result;
        } }), principal.tenantId);
        assert.equal(revokedAfterSend.status, 'reconciliation_required'); assert.equal(revokedAfterSend.relationshipWriteAttempted, true);
        assert.equal((await runWithIAMStoreContext(() => reconcileRelations({}), principal.tenantId)).code, 'SYNTHETIC_FACT_FORBIDDEN');
      } finally { configureIAMRepository(null); }
      const changed = structuredClone(body); changed.records[0].payload[type.key] = 'changed';
      assert.equal((await transfer('completed-run', { body: changed })).code, 'SYNTHETIC_TRANSFER_IDENTITY_CONFLICT'); assert.equal(writes, 1);
      const concurrent = await Promise.all([transfer('parallel-run'), transfer('parallel-run')]);
      assert.equal(concurrent.filter(result => result.status === 'completed').length, 1);
      assert.equal(writes, 2);
      const staleReceipt = await transfer('stale-receipt-run', { request: async (_connection, _path, options) => {
        if (options.method !== 'POST') return receipt;
        writes++; return { status: 'ingested', modelId: 'production' };
      } });
      assert.equal(staleReceipt.status, 'reconciliation_required'); assert.equal(writes, 3);
      assert.equal((await transfer('after-stale-receipt')).code, 'SYNTHETIC_TRANSFER_RECONCILIATION_REQUIRED');
      // Test-only reset of isolated transfer state; no production reset endpoint.
      resetRuntimeState(['semantic_synthetic_transfers']);
      const unknown = await transfer('unknown-run', { request: async (_connection, _path, options) => {
        if (options.method !== 'POST') return receipt;
        writes++; throw new Error('secret-provider-error');
      } });
      assert.equal(unknown.status, 'reconciliation_required'); assert.equal(unknown.factWriteAttempted, true);
      assert.doesNotMatch(JSON.stringify(unknown), /secret-provider-error/);
      assert.equal((await transfer('unknown-run')).code, 'SYNTHETIC_TRANSFER_RECONCILIATION_REQUIRED');
      assert.equal((await transfer('different-run')).code, 'SYNTHETIC_TRANSFER_RECONCILIATION_REQUIRED'); assert.equal(writes, 4);
      const uncertain = (await readSemanticGovernanceState('semantic_synthetic_transfers', 'index', {}))['unknown-run'];
      const reconcile = patch => reconcileSyntheticTransfer({ identityScope: principal, body, runId: 'unknown-run', scenarioId: 'isolated-test',
        connection: () => target, request: async (_target, path, options) => {
          assert.notEqual(options.method, 'POST');
          if (path.endsWith('/definition')) return receipt;
          return { status: 'ready', modelId: 'finance', modelVersion: body.version, modelFingerprint: receipt.fingerprint,
            projectionScope: 'synthetic_graph', runtimeReadEnabled: false, graphProtocol: 1,
            run: { runId: 'unknown-run', facts: 1, proofFingerprint: uncertain.proofFingerprint },
            instance: { ...receipt.instance, graphProtocol: 1, projectionScope: 'synthetic_graph' }, ...patch };
        } });
      assert.equal((await reconcile({ run: { runId: 'unknown-run', facts: 1, proofFingerprint: 'forged' } })).code, 'SYNTHETIC_TRANSFER_PROOF_UNCONFIRMED');
      assert.equal((await reconcile({ status: 'not_found' })).code, 'SYNTHETIC_TRANSFER_PROOF_UNCONFIRMED');
      assert.equal((await transfer('still-blocked')).code, 'SYNTHETIC_TRANSFER_RECONCILIATION_REQUIRED');
      await mutateSemanticGovernanceState('semantic_synthetic_transfers', 'index', {}, index => {
        index['unknown-run'].status = 'dispatching'; index['unknown-run'].leaseExpiresAt = new Date(Date.now() + 60000).toISOString();
        return { value: index };
      });
      assert.equal((await reconcile({})).code, 'SYNTHETIC_TRANSFER_BUSY');
      await mutateSemanticGovernanceState('semantic_synthetic_transfers', 'index', {}, index => {
        index['unknown-run'].leaseExpiresAt = '2000-01-01T00:00:00Z'; return { value: index };
      });
      assert.equal((await reconcile({})).status, 'reconciled'); assert.equal(writes, 4);
      assert.equal((await transfer('unknown-run')).status, 'already_completed'); assert.equal(writes, 4);
      iam = createInitialIAMWorkspace(); loads = 0;
      configureIAMRepository({ readState: async () => {
        if (++loads === 3) iam.users.find(user => user.id === principal.subjectId).roleIds = [];
        return structuredClone(iam);
      }, mutateState: async () => { throw new Error('Unexpected IAM write'); }, mutateStates: async () => { throw new Error('Unexpected IAM write'); } });
      try {
        assert.equal((await run(async () => structuredClone(receipt))).code, 'SYNTHETIC_FACT_CONTEXT_CHANGED');
        assert.equal(loads, 3);
      } finally { configureIAMRepository(null); }
      assert.equal((await run(async () => {
        await mutateSemanticGovernanceState('semantic_model_registry', 'index', {}, state => { state.models[0].lifecycle = 'disabled'; return { value: state }; }); return receipt;
      })).code, 'SEMANTIC_MODEL_WORKSPACE_REVOKED');
    } });
  });
  assert.deepEqual(await within('other-tenant', () => readSemanticGovernanceState('semantic_synthetic_transfers', 'index', {})), {});
  assert.deepEqual(await within(principal.tenantId, () => readSemanticGovernanceState('semantic_synthetic_transfers', 'index', {})), {});
});

test('model tasks: legacy records work only in default, legacy onboarding cannot prepare an independent model', async () => {
  const principal = identity('task-model-test');
  await within(principal.tenantId, async () => {
    await seedValidationTask(principal);
    await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { delete index['same-task'].modelId; return { value: index }; });
    assert.equal((await getSemanticOperationsTask({ taskId: 'same-task', identityScope: principal })).modelId, DEFAULT_SEMANTIC_MODEL_ID);
    await semanticModelRegistry.register({ role, identityScope: principal, body: { id: 'finance', label: '财务模型', expectedRevision: 0 } });
    await semanticModelRegistry.withWorkspace({ role, identityScope: principal, modelId: 'finance', work: async () => {
      await seedValidationTask(principal, undefined);
      await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => { delete index['same-task'].modelId; return { value: index }; });
      assert.equal(await getSemanticOperationsTask({ taskId: 'same-task', identityScope: principal }), null);
      const prepared = await prepareOnboardingSemanticTask({ id: 'synthetic-prepared', identityScope: principal, roleId: role.id,
        proposal: { id: 'synthetic', objectTypes: [], relationshipTypes: [], critic: { status: 'passed' }, mappingValidation: { status: 'passed' } },
        onboardingSource: { projectId: 'synthetic-project', materialRevision: 1 } });
      assert.equal(prepared.code, 'MODEL_ONBOARDING_BINDING_REQUIRED');
      assert.equal(prepared.task, undefined); assert.equal(prepared.publicTask, undefined);
    } });
  });
});

test('model tasks: a revoked registration blocks dispatch without consuming confirmation', async () => {
  const principal = identity('task-model-test');
  await within(principal.tenantId, async () => {
    await semanticModelRegistry.register({ role, identityScope: principal, body: { id: 'finance', label: '财务模型', expectedRevision: 0 } });
    await semanticModelRegistry.withWorkspace({ role, identityScope: principal, modelId: 'finance', work: async () => {
      await seedValidationTask(principal);
      const request = { taskId: 'same-task', identityScope: principal, role };
      const issued = await issueSemanticOperationsTaskConfirmation(request);
      await mutateSemanticGovernanceState('semantic_model_registry', 'index', {}, state => { state.models[0].lifecycle = 'disabled'; return { value: state }; });
      assert.equal((await executeSemanticOperationsTask({ ...request, confirmationToken: issued.confirmationToken })).code, 'SEMANTIC_MODEL_WORKSPACE_REVOKED');
      const stored = await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {});
      assert.equal(stored['same-task'].confirmation.state, 'issued'); assert.equal(stored['same-task'].status, 'waiting_confirmation');
    } });
  });
});

test('model tasks: a stale executor cannot complete a successor lease or expose its token', async () => {
  const principal = identity('task-lease-test');
  await within(principal.tenantId, async () => {
    await seedValidationTask(principal);
    const request = { taskId: 'same-task', identityScope: principal, role };
    const issued = await issueSemanticOperationsTaskConfirmation(request);
    let replaced = false;
    configureSemanticGovernanceRepository({ ...asyncRuntimeStateRepository, mutateState: async (...args) => {
      const result = await asyncRuntimeStateRepository.mutateState(...args);
      if (args[0] === 'oa_meta_model_runtime' && !replaced) {
        replaced = true;
        await mutateSemanticGovernanceState('semantic_operations_agent_tasks', 'index', {}, index => {
          index['same-task'].execution.leaseToken = 'synthetic-successor-secret'; index['same-task'].execution.attempt++;
          return { value: index };
        });
      }
      return result;
    } });
    try {
      assert.equal((await executeSemanticOperationsTask({ ...request, confirmationToken: issued.confirmationToken })).code, 'SEMANTIC_TASK_STATE_CONFLICT');
    } finally { configureSemanticGovernanceRepository(null); }
    assert.equal(replaced, true);
    const task = await getSemanticOperationsTask(request);
    assert.equal(task.status, 'executing'); assert.equal(task.execution.attempt, 2);
    assert.doesNotMatch(JSON.stringify(task), /synthetic-successor-secret|leaseToken/);
    assert.equal(task.events.some(event => event.type === 'execution_completed'), false);
  });
});

test('model tasks: independent execution stays in its admitted slot and rejects in-flight registration loss', async () => {
  const principal = identity('task-running-model-test');
  await within(principal.tenantId, async () => {
    for (const [expectedRevision, id] of ['finance', 'production'].entries()) await semanticModelRegistry.register({ role, identityScope: principal, body: { id, label: `${id}模型`, expectedRevision } });
    const workspace = (modelId, work) => semanticModelRegistry.withWorkspace({ role, identityScope: principal, modelId, work });
    await workspace('production', () => seedValidationTask(principal));
    await workspace('finance', async () => {
      await seedValidationTask(principal);
      const request = { taskId: 'same-task', identityScope: principal, role };
      const issued = await issueSemanticOperationsTaskConfirmation(request);
      let revoked = false;
      configureSemanticGovernanceRepository({ ...asyncRuntimeStateRepository, mutateState: async (...args) => {
        const result = await asyncRuntimeStateRepository.mutateState(...args);
        if (args[0] === 'oa_meta_model_runtime' && !revoked) {
          revoked = true;
          assert.equal(currentSemanticModel(), 'finance');
          await mutateSemanticGovernanceState('semantic_model_registry', 'index', {}, state => { state.models.find(item => item.id === 'finance').lifecycle = 'disabled'; return { value: state }; });
        }
        return result;
      } });
      try {
        const execution = await executeSemanticOperationsTask({ ...request, confirmationToken: issued.confirmationToken });
        assert.equal(execution.code, 'SEMANTIC_TASK_EXECUTION_BLOCKED');
        assert.equal(execution.task.status, 'retryable');
        assert.equal(execution.task.modelId, 'finance');
        assert.equal(execution.task.events.some(event => event.type === 'execution_completed'), false);
      } finally { configureSemanticGovernanceRepository(null); }
      assert.equal(revoked, true);
    });
    await workspace('production', async () => {
      const request = { taskId: 'same-task', identityScope: principal, role };
      assert.equal((await getSemanticOperationsTask(request)).status, 'waiting_confirmation');
      const issued = await issueSemanticOperationsTaskConfirmation(request);
      const execution = await executeSemanticOperationsTask({ ...request, confirmationToken: issued.confirmationToken });
      assert.equal(execution.task.status, 'completed'); assert.equal(execution.task.modelId, 'production');
    });
    assert.equal(await getSemanticOperationsTask({ taskId: 'same-task', identityScope: principal }), null);
  });
});

test('model registry foundation: tenant metadata and legacy workspace are independent, registration grants no runtime binding', async () => {
  const register = tenant => within(tenant, () => semanticModelRegistry.register({ role, identityScope: identity(tenant), body: { id: 'supply-chain', label: '供应链世界模型', expectedRevision: 0 } }));
  const [a, b] = await Promise.all([register('company-a'), register('company-b')]);
  assert.equal(a.model.lifecycle, 'registered'); assert.equal(b.model.runtimeBinding, 'not_bound');
  assert.equal(a.runtimeSelectionEnabled, false);
  const list = tenant => within(tenant, () => semanticModelRegistry.list({ role, identityScope: identity(tenant) }));
  assert.equal((await list('company-a')).models.length, 2);
  assert.equal((await list('company-c')).models.length, 1);
  assert.equal(within('company-a', getPublishedOntologyModel), null);
  assert.equal(within('company-a', getOAMetaModelSimulation), null);
  const events = await listDomainEvents({ tenantId: 'company-a' });
  assert.equal(events.length, 1); assert.equal(events[0].type, 'governance.semantic_model.registered');
  assert.equal(events[0].payload.modelId, 'supply-chain');
});

test('model registry foundation: stale/concurrent/duplicate/forged writes fail without state or events', async () => {
  await within('company-a', async () => {
    const register = body => semanticModelRegistry.register({ role, identityScope: identity('company-a'), body });
    const results = await Promise.all(['finance', 'production'].map(id => register({ id, label: `${id}模型`, expectedRevision: 0 })));
    assert.equal(results.filter(r => !r.error).length, 1);
    assert.equal(results.find(r => r.error).code, 'MODEL_REGISTRY_REVISION_CONFLICT');
    const chosen = results.find(r => !r.error).model;
    assert.equal((await register({ id: chosen.id, label: '重复标识', expectedRevision: 1 })).code, 'MODEL_REGISTRY_DUPLICATE');
    for (const body of [
      { id: 'oa-governance', label: '覆盖旧工作区', expectedRevision: 1 },
      { id: '../foreign', label: '越界模型', expectedRevision: 1 },
      { id: 'new-model', label: '新模型', expectedRevision: 1, tenantId: 'company-b' },
      { id: 'new-model', label: '新模型', expectedRevision: 1, runtimeBinding: 'published' },
      { id: 'new-model', label: '<script>模型', expectedRevision: 1 }
    ]) assert.equal((await register(body)).code, 'MODEL_REGISTRY_INPUT_INVALID');
    assert.equal((await semanticModelRegistry.list({ role, identityScope: identity('company-a') })).revision, 1);
    assert.equal((await listDomainEvents({ tenantId: 'company-a' })).length, 1);
  });
});

test('model registry foundation: bound tenant, complete identity and server role are required', async () => {
  const options = { role, identityScope: identity('company-a') };
  await assert.rejects(within('company-b', () => semanticModelRegistry.list(options)), /SEMANTIC_TENANT_CONTEXT_MISMATCH/);
  assert.equal((await within('company-a', () => semanticModelRegistry.list({ ...options, role: getRole('quality_manager') }))).status, 403);
  assert.equal((await within('company-a', () => semanticModelRegistry.list({ ...options, identityScope: { tenantId: 'company-a' } }))).status, 403);
});

test('model registry foundation: full catalogue rejects atomically without evicting or activating any model', async () => {
  await within('company-a', async () => {
    for (let i = 0; i < 31; i++) assert.equal((await semanticModelRegistry.register({ role, identityScope: identity('company-a'), body: { id: `model-${i}`, label: `模型${i}`, expectedRevision: i } })).revision, i + 1);
    const before = await semanticModelRegistry.list({ role, identityScope: identity('company-a') });
    const overflow = await semanticModelRegistry.register({ role, identityScope: identity('company-a'), body: { id: 'extra-model', label: '额外模型', expectedRevision: 31 } });
    assert.equal(overflow.code, 'MODEL_REGISTRY_LIMIT');
    assert.deepEqual(await semanticModelRegistry.list({ role, identityScope: identity('company-a') }), before);
    assert.equal(before.models.length, 32);
    assert.equal((await listDomainEvents({ tenantId: 'company-a' })).length, 31);
  });
});

async function registerWorkspaces(tenant = 'company-a') {
  for (const [i, modelId] of ['finance', 'production'].entries()) {
    const result = await within(tenant, () => semanticModelRegistry.register({ role, identityScope: identity(tenant), body: { id: modelId, label: `${modelId}模型`, expectedRevision: i } }));
    assert.ok(!result.error, JSON.stringify(result));
  }
}
const workspace = (modelId, work, tenant = 'company-a') => within(tenant, () => semanticModelRegistry.withWorkspace({ role, identityScope: identity(tenant), modelId, work }));

test('model workspace: concurrent registered models preserve context and legacy data without implicit switching', async () => {
  await registerWorkspaces();
  within('company-a', () => saveOAMetaModelDraft({ policies: ['LEGACY_ONLY'] }, role));
  const results = await Promise.all(['finance', 'production'].map(modelId => workspace(modelId, async () => {
    assert.ok(!getOAMetaModelDraft().policies.includes('LEGACY_ONLY'));
    await Promise.resolve(); await saveOAMetaModelDraft({ policies: [modelId] }, role);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(currentSemanticTenant(), 'company-a'); assert.equal(currentSemanticModel(), modelId);
    assert.equal(currentSemanticModelRegistered(), true);
    assert.equal(within('company-a', currentSemanticModel), modelId);
    assert.throws(() => runWithSemanticModelWorkspace(identity('company-a'), 'other-model', () => null), /SEMANTIC_MODEL_CONTEXT_MISMATCH/);
    assert.throws(() => runWithSemanticTenant(identity('company-b'), () => null), /SEMANTIC_TENANT_CONTEXT_MISMATCH/);
    return getOAMetaModelDraft().policies;
  })));
  assert.deepEqual(results, [['finance'], ['production']]);
  assert.equal(currentSemanticModel(), DEFAULT_SEMANTIC_MODEL_ID);
  assert.deepEqual(within('company-a', getOAMetaModelDraft).policies, ['LEGACY_ONLY']);
  let invoked = 0;
  assert.equal((await workspace('unknown-model', () => { invoked++; })).code, 'MODEL_REGISTRY_NOT_FOUND');
  assert.equal((await workspace('finance', () => { invoked++; }, 'company-b')).code, 'MODEL_REGISTRY_NOT_FOUND');
  assert.equal(invoked, 0);
  await assert.rejects(workspace('finance', async () => { throw new Error('test_callback_failure'); }), /test_callback_failure/);
  assert.equal(currentSemanticModel(), DEFAULT_SEMANTIC_MODEL_ID);
});

test('model workspace: actual proposal adoption and rollback cannot cross models for the same principal', async () => {
  await registerWorkspaces();
  const apply = modelId => workspace(modelId, () => {
    const proposal = createSemanticOperationsProposal({ input: '建立供应商和原料批次语义模型', identityScope: identity('company-a') });
    return applySemanticOperationsProposal({ proposalId: proposal.id, role, identityScope: identity('company-a') });
  });
  const a = await apply('finance'); const b = await apply('production');
  assert.ok(a.snapshot && b.snapshot);
  const beforeB = await workspace('production', getOAMetaModelDraft);
  const rejected = await workspace('production', () => applySemanticOperationsProposal({ proposalId: a.proposal.id, role, identityScope: identity('company-a') }));
  assert.equal(rejected.code, 'SEMANTIC_PROPOSAL_NOT_FOUND');
  const wrongRollback = await workspace('production', () => rollbackSemanticOperationsSnapshot({ snapshotId: a.snapshot.id, role, identityScope: identity('company-a') }));
  assert.ok(wrongRollback.error);
  assert.equal((await workspace('production', () => listSemanticOperationsSnapshots({ identityScope: identity('company-a') }))).length, 1);
  assert.equal((await workspace('finance', () => rollbackSemanticOperationsSnapshot({ snapshotId: a.snapshot.id, role, identityScope: identity('company-a') }))).error, undefined);
  assert.deepEqual(await workspace('production', getOAMetaModelDraft), beforeB);
  assert.equal((await within('company-a', () => listSemanticOperationsSnapshots({ identityScope: identity('company-a') }))).length, 0);
});

test('model workspace: publication, replay and multi-state keys stay isolated, audit binds the model', async () => {
  await registerWorkspaces();
  for (const modelId of ['finance', 'production']) await workspace(modelId, async () => {
    assert.equal(await getOAMetaModelSimulation(), null);
    await simulateBuildOAMetaModel(role);
    assert.equal((await publishOAMetaModel(role, { version: 'same-version' })).error, undefined);
    await mutateSemanticGovernanceStates([
      { name: 'lock', namespace: 'ontology_publication', key: 'current', initialValue: null },
      { name: 'replay', namespace: 'ontology_case_replay', key: 'same-principal', initialValue: null },
      { name: 'task', namespace: 'semantic_operations_agent_tasks', key: 'index', initialValue: {} },
      { name: 'relations', namespace: 'semantic_synthetic_relationships', key: 'index', initialValue: {} }
    ], () => ({ values: { lock: { modelId }, replay: { modelId }, task: { sameId: { modelId } }, relations: { sameId: { modelId } } } }));
  });
  for (const modelId of ['finance', 'production']) await workspace(modelId, async () => {
    assert.equal((await readSemanticGovernanceState('ontology_publication', 'current')).modelId, modelId);
    assert.equal((await readSemanticGovernanceState('ontology_case_replay', 'same-principal')).modelId, modelId);
    assert.equal((await readSemanticGovernanceState('semantic_operations_agent_tasks', 'index')).sameId.modelId, modelId);
    assert.equal((await readSemanticGovernanceState('semantic_synthetic_relationships', 'index')).sameId.modelId, modelId);
    assert.equal((await getPublishedOntologyModel()).version, 'same-version');
    assert.equal((await getPublishedOntologyModel()).modelId, modelId);
    assert.equal((await getPublishedOntologyModel()).runtimeReadEnabled, false);
    const previousGrants = process.env.ONTOLOGY_RUNTIME_GRANTS_JSON;
    try {
      process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify({ 'company-a': { executive: { metadata: true, objects: {} } } });
      assert.equal(await getPublishedAgentOntology('executive', identity('company-a')), null);
    } finally {
      if (previousGrants === undefined) delete process.env.ONTOLOGY_RUNTIME_GRANTS_JSON;
      else process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = previousGrants;
    }
  });
  assert.equal(within('company-a', getPublishedOntologyModel), null);
  const events = (await listDomainEvents({ tenantId: 'company-a' })).filter(event => event.type === 'governance.meta_model.published');
  assert.deepEqual(events.map(event => event.payload.modelId).sort(), ['finance', 'production']);
});

test('model workspace: unsupported shared projection, live publication, runtime read and scheduling all fail before I/O', async () => {
  await registerWorkspaces('demo-enterprise');
  const previousFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected IO'); };
  try {
    await workspace('finance', async () => {
      for (const result of await Promise.all([getSemanticaModelDiscovery(), getSemanticaModelDeployment(), resetSemanticaDemoGraph(),
        publishSemanticaModelDefinition({ id: 'finance' }, 'v1')])) {
        assert.equal(result.reason, 'model_namespace_unsupported'); assert.equal(result.requestAttempted, false);
      }
      await simulateBuildOAMetaModel(role);
      const publish = await publishGovernedOntology({ role, identityScope: identity('demo-enterprise') });
      assert.equal(publish.code, 'PUBLICATION_NOT_ATTEMPTED', JSON.stringify(publish));
      assert.equal(await getPublishedOntologyModel(), null);
      assert.equal(await getPublishedAgentOntology(role.id, identity('demo-enterprise')), null);
      assert.equal((await createSemanticInspectionSchedule({ body: { checks: ['source_readiness'] }, role, identityScope: identity('demo-enterprise') })).code, 'SEMANTIC_MODEL_INSPECTION_CHECK_UNSUPPORTED');
    }, 'demo-enterprise');
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('model workspace: async single/batch/event repository operations use the same isolated key', async () => {
  const observed = [];
  configureSemanticGovernanceRepository({
    readState: async (namespace, key) => { observed.push([namespace, key]); return null; },
    mutateState: async (namespace, key) => { observed.push([namespace, key]); return null; },
    mutateStates: async entries => { observed.push(...entries.map(entry => [entry.namespace, entry.key])); return null; }
  });
  try {
    await runWithSemanticModelWorkspace(identity('company-a'), 'finance', async () => {
      await readSemanticGovernanceState('oa_meta_model_runtime', 'workspace');
      await mutateSemanticGovernanceState('oa_meta_model_runtime', 'workspace', null, () => ({}));
      await mutateSemanticGovernanceStates([{ name: 'model', namespace: 'oa_meta_model_runtime', key: 'workspace' }], () => ({}));
      await mutateSemanticGovernanceWithEvent({ namespace: 'oa_meta_model_runtime', key: 'workspace', initialValue: null, mutation: () => ({}) });
      assert.notEqual(semanticModelStateKey('x'), semanticModelStateKey('x:y'));
    });
    await runWithSemanticModelWorkspace(identity('company-a'), 'production', () => readSemanticGovernanceState('oa_meta_model_runtime', 'workspace'));
    const models = observed.filter(([namespace]) => namespace === 'oa_meta_model_runtime');
    assert.ok(models.slice(0, 4).every(([, key]) => key === models[0][1]));
    assert.notEqual(models[0][1], models[4][1]);
    assert.ok(models.every(([, key]) => key.startsWith('["semantic-model-v1",')));
    assert.deepEqual(observed.find(([namespace]) => namespace === 'domain_event_outbox'), ['domain_event_outbox', 'events']);
  } finally { configureSemanticGovernanceRepository(null); }
});

async function draftRequest(tenant, method, body) {
  let response;
  await handleGovernanceRoutes({ req: { method }, res: {}, url: new URL('http://test/api/meta-models/oa-governance/draft'), role: 'executive',
    agentIdentity: identity(tenant), selectActionRole: () => role, readBody: async () => body,
    send: (_res, status, value) => { response = { status, value }; } });
  assert.equal(response.status, 200); return response.value;
}

async function snapshotsRequest(tenant, { pagePermissionIds = ['page.semantic-operations.view'], buttonPermissionIds = [] } = {}) {
  let response;
  const allowed = buttonPermissionIds.includes('meta_model.draft.save');
  await handleGovernanceRoutes({ req: { method: 'GET' }, res: {}, url: new URL('http://test/api/semantic-operations/snapshots'), role: 'executive',
    agentIdentity: identity(tenant), effectiveAccess: { pagePermissionIds, buttonPermissionIds },
    selectActionRole: permissionId => permissionId === 'meta_model.draft.save' && allowed ? role : null,
    denyButton: permissionId => { response = { status: 403, value: { denied: permissionId } }; },
    send: (_res, status, value) => { response = { status, value }; } });
  return response;
}

test('tenant model: real routes isolate manual drafts and ignore body tenant IDs', async () => {
  await draftRequest('company-a', 'POST', { policies: ['A_ONLY'], tenantId: 'company-b' });
  const history = await snapshotsRequest('company-a');
  assert.equal(history.status, 200);
  assert.equal(history.value.snapshots.length, 1);
  assert.equal(history.value.snapshots[0].sourceType, 'manual_save');
  assert.equal(history.value.snapshots[0].rollbackAllowed, true);
  assert.equal((await snapshotsRequest('company-a', { pagePermissionIds: [] })).status, 403);
  assert.deepEqual((await snapshotsRequest('company-b')).value.snapshots, []);
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
