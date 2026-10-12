import assert from 'node:assert/strict';
import { getRole } from '../../src/services/authorization-service.js';
import { runWithSemanticTenant } from '../../src/services/semantic-tenant-context.js';
import { semanticModelRegistry } from '../../src/services/semantic-model-registry.js';
import { getOAMetaModelDraft } from '../../src/services/meta-model-service.js';
import { semanticFingerprint } from '../../src/services/semantic-model-fingerprint.js';
import { mutateSemanticGovernanceState, readSemanticGovernanceState } from '../../src/services/semantic-governance-store.js';
import { getEffectiveAccess } from '../../src/services/access-control-service.js';
import { transferSyntheticFacts } from '../../../services/semantic-context/synthetic-fact-transfer.js';
import { reconcileSyntheticTransfer } from '../../../services/semantic-context/synthetic-fact-reconciliation.js';
import { materializeSyntheticRelationships, reconcileSyntheticRelationships } from '../../../services/semantic-context/synthetic-relationship-execution.js';
import { wireFingerprint } from '../../../services/semantic-context/synthetic-proof.js';

assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.RUNTIME_STORE_DRIVER, 'sqlite');
const mode = process.argv[2]; const identityScope = { tenantId: 'demo-enterprise', subjectId: 'usr-001' }; const role = getRole('executive');
const target = { guarded: true, endpoint: 'http://127.0.0.1:9999', tenantId: identityScope.tenantId, deploymentId: 'isolated-sqlite', token: 'synthetic-only' };
await runWithSemanticTenant(identityScope, async () => {
  if (mode === 'seed') for (const [expectedRevision, id] of ['finance', 'production'].entries()) {
    assert.equal((await semanticModelRegistry.register({ role, identityScope, body: { id, label: `${id}模型`, expectedRevision } })).error, undefined);
  }
  for (const modelId of ['finance', 'production']) await semanticModelRegistry.withWorkspace({ role, identityScope, modelId, work: async () => {
    const draft = await getOAMetaModelDraft(); const fingerprint = semanticFingerprint(draft); const type = draft.objectTypes[0];
    const body = { modelId, version: 'synthetic-v1', fingerprint, records: [{ id: 'same-record', tenantId: identityScope.tenantId,
      organizationId: getEffectiveAccess(null, identityScope).organizationIds[0], version: 'source-v1', occurredAt: '2026-10-11T04:29:00Z',
      classification: 'internal', sourceSystem: type.sourceSystems[0], objectType: type.id, simulated: true, payload: { [type.key]: `${modelId}-private-payload` } }] };
    const instance = { ...target, modelId, identityVerified: true, protocol: 1, modelProtocol: 1, projectionScope: 'definition_only', runtimeReadEnabled: false };
    const definition = { status: 'published', id: 'oa-governance', modelId, modelProtocol: 1, version: body.version, sourceFingerprint: fingerprint,
      fingerprint: 'a'.repeat(20), projectionScope: 'definition_only', runtimeReadEnabled: false, instance };
    if (mode === 'seed') {
      await mutateSemanticGovernanceState('oa_meta_model_runtime', 'workspace', {}, state => ({ value: { ...state,
        publishedModel: { tenantId: identityScope.tenantId, version: body.version, fingerprint, draft } } }));
      await mutateSemanticGovernanceState('ontology_publication', 'current', null, () => ({ value: { status: 'completed', modelId, version: body.version, fingerprint,
        target: { tenantId: identityScope.tenantId, modelId, deploymentId: target.deploymentId } } }));
    }
    const request = async (_target, path, options) => {
      if (path.endsWith('/definition')) return definition;
      if (options.method === 'POST') {
        assert.equal(mode, 'seed', 'Restart must never resend');
        if (modelId === 'finance') throw new Error('Synthetic lost reply');
        return { status: 'ingested', modelId, graphProtocol: 1, modelVersion: body.version, modelFingerprint: definition.fingerprint,
          projectionScope: 'synthetic_graph', runtimeReadEnabled: false, run: { runId: 'same-run', proofFingerprint: wireFingerprint(options.body, modelId, body.version) },
          ingestedFacts: 1, instance: { ...instance, graphProtocol: 1, projectionScope: 'synthetic_graph' } };
      }
      const journal = await readSemanticGovernanceState('semantic_synthetic_transfers', 'index', {});
      return { status: 'ready', modelId, graphProtocol: 1, modelVersion: body.version, modelFingerprint: definition.fingerprint,
        projectionScope: 'synthetic_graph', runtimeReadEnabled: false, run: { runId: 'same-run', facts: 1, proofFingerprint: journal['same-run'].proofFingerprint },
        instance: { ...instance, graphProtocol: 1, projectionScope: 'synthetic_graph' } };
    };
    const input = { identityScope, body, runId: 'same-run', scenarioId: 'synthetic-sqlite', confirmed: true, connection: () => target, request };
    if (mode.startsWith('relation-')) {
      const factEntry = (await readSemanticGovernanceState('semantic_synthetic_transfers', 'index', {}))['same-run'];
      assert.equal(factEntry.status, 'completed');
      const relationshipRequest = async (...args) => {
        const options = args[2];
        if (options.projectionScope !== 'synthetic_relationships') return request(...args);
        if (options.method === 'POST') {
          assert.equal(mode, 'relation-seed', 'Restart must not re-materialize');
          if (modelId === 'finance') throw new Error('Synthetic relationship reply lost');
        }
        return { status: 'materialized', modelId, runId: 'same-run', modelVersion: body.version, modelFingerprint: definition.fingerprint,
          runProofFingerprint: factEntry.proofFingerprint, projectionFingerprint: (modelId === 'finance' ? 'c' : 'd').repeat(64), relationshipCount: 1,
          relationshipProtocol: 1, projectionScope: 'synthetic_relationships', runtimeReadEnabled: false,
          instance: { ...instance, relationshipProtocol: 1, projectionScope: 'synthetic_relationships' } };
      };
      const relationInput = { ...input, request: relationshipRequest };
      if (mode === 'relation-seed') assert.equal((await materializeSyntheticRelationships(relationInput)).status, modelId === 'finance' ? 'reconciliation_required' : 'completed');
      else {
        const saved = (await readSemanticGovernanceState('semantic_synthetic_relationships', 'index', {}))['same-run'];
        assert.equal(saved.modelId, modelId); assert.equal(saved.runProofFingerprint, factEntry.proofFingerprint);
        assert.doesNotMatch(JSON.stringify(saved), /private-payload|synthetic-only/);
        if (mode === 'relation-reconcile') assert.equal((await reconcileSyntheticRelationships(relationInput)).status, 'reconciled');
        else assert.equal((await materializeSyntheticRelationships(relationInput)).status, modelId === 'finance' && mode === 'relation-verify' ? 'rejected' : 'already_completed');
      }
    } else if (mode === 'seed') assert.equal((await transferSyntheticFacts(input)).status, modelId === 'finance' ? 'reconciliation_required' : 'completed');
    else {
      const journal = await readSemanticGovernanceState('semantic_synthetic_transfers', 'index', {});
      assert.equal(journal['same-run'].modelId, modelId); assert.equal(journal['same-run'].provenance[0].sourceVersion, 'source-v1');
      assert.doesNotMatch(JSON.stringify(journal), /private-payload|synthetic-only/);
      if (mode === 'reconcile') assert.equal((await reconcileSyntheticTransfer(input)).status, 'reconciled');
      else assert.equal((await transferSyntheticFacts(input)).status, modelId === 'finance' && mode === 'verify' ? 'rejected' : 'already_completed');
    }
  } });
  assert.deepEqual(await readSemanticGovernanceState('semantic_synthetic_transfers', 'index', {}), {});
  assert.deepEqual(await readSemanticGovernanceState('semantic_synthetic_relationships', 'index', {}), {});
});
process.stdout.write(JSON.stringify({ status: 'passed', mode }));
