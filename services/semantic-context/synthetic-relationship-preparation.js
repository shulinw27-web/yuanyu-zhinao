// Internal read-only composition. A successful check is not a reusable grant.
import { createHash } from 'node:crypto';
import { prepareSyntheticFactTransfer } from './synthetic-fact-preparation.js';
import { safeSyntheticConnection } from './synthetic-fact-transfer.js';
import { syntheticWire, wireFingerprint } from './synthetic-proof.js';
import { runWithIAMStoreContext, getIAMVersion } from '../../backend/src/services/iam-store.js';
import { getEffectiveAccess } from '../../backend/src/services/access-control-service.js';
import { readSemanticGovernanceState } from '../../backend/src/services/semantic-governance-store.js';
import { semanticInstanceConnection, requestSemanticInstance } from '../../backend/src/services/semantic-instance-transport.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u.test(value);
const deny = code => ({ status: 'rejected', code, relationshipWriteAttempted: false, writeAuthorizationIssued: false });
const iamSnapshot = identity => runWithIAMStoreContext(() => ({ version: getIAMVersion(),
  access: JSON.stringify(getEffectiveAccess(null, identity)) }), identity.tenantId);

export async function prepareSyntheticRelationships({ identityScope, body, runId, scenarioId,
  connection = semanticInstanceConnection, request = requestSemanticInstance }) {
  try {
    if (!validId(runId) || !validId(scenarioId)) return deny('SYNTHETIC_RELATION_INPUT_INVALID');
    const identity = structuredClone(identityScope); const input = structuredClone(body);
    const target = structuredClone(connection());
    if (!safeSyntheticConnection(target) || target.tenantId !== identity.tenantId) return deny('SYNTHETIC_RELATION_LOCAL_INSTANCE_REQUIRED');
    const pinned = hash(target);
    const inspect = () => {
      if (hash(connection()) !== pinned) throw new Error('Changed instance');
      return request(target, `/models/${input.modelId}/definition`, { modelId: input.modelId });
    };
    const prepare = () => prepareSyntheticFactTransfer({ identityScope: identity, body: input, inspect });
    const beforeIAM = await iamSnapshot(identity);
    const ready = await prepare();
    if (ready.status !== 'preparation_passed') return deny(ready.code);
    const journal = await readSemanticGovernanceState('semantic_synthetic_transfers', 'index', {});
    const entry = journal[runId];
    const proof = wireFingerprint(syntheticWire(input, identity, ready, runId, scenarioId), input.modelId, ready.version);
    if (!entry || entry.status !== 'completed' || entry.subjectId !== identity.subjectId || entry.tenantId !== identity.tenantId
      || entry.modelId !== input.modelId || entry.scenarioId !== scenarioId || entry.inputDigest !== hash({ input, scenarioId })) {
      return deny('SYNTHETIC_RELATION_COMPLETED_TRANSFER_REQUIRED');
    }
    if (entry.deploymentId !== target.deploymentId || entry.version !== ready.version || entry.graphFingerprint !== ready.graphFingerprint
      || entry.sourceFingerprint !== ready.sourceFingerprint || entry.proofFingerprint !== proof || hash(connection()) !== pinned) {
      return deny('SYNTHETIC_RELATION_CONTEXT_CHANGED');
    }
    const observed = await request(target, `/models/${input.modelId}/graph/runs/${runId}`, { modelId: input.modelId, projectionScope: 'synthetic_graph' });
    const instance = observed?.instance;
    if (observed?.status !== 'ready' || observed.modelId !== input.modelId || observed.modelVersion !== ready.version
      || observed.modelFingerprint !== ready.graphFingerprint || observed.projectionScope !== 'synthetic_graph' || observed.graphProtocol !== 1
      || observed.runtimeReadEnabled !== false || observed.run?.runId !== runId || observed.run.proofFingerprint !== proof
      || observed.run.facts !== input.records.length || instance?.identityVerified !== true || instance.tenantId !== identity.tenantId
      || instance.deploymentId !== target.deploymentId || instance.modelId !== input.modelId || instance.protocol !== 1
      || instance.modelProtocol !== 1 || instance.graphProtocol !== 1 || instance.projectionScope !== 'synthetic_graph'
      || instance.runtimeReadEnabled !== false) return deny('SYNTHETIC_RELATION_FACT_PROOF_UNCONFIRMED');
    const after = await prepare();
    if (after.status !== 'preparation_passed') return deny(after.code);
    const current = (await readSemanticGovernanceState('semantic_synthetic_transfers', 'index', {}))[runId];
    const final = await prepare();
    if (final.status !== 'preparation_passed') return deny(final.code);
    // Reload IAM after all repository/network awaits; never reuse outer snapshots.
    const afterIAM = await iamSnapshot(identity);
    if (hash(current) !== hash(entry) || hash(ready) !== hash(after) || hash(ready) !== hash(final)
      || hash(beforeIAM) !== hash(afterIAM) || hash(connection()) !== pinned) {
      return deny('SYNTHETIC_RELATION_CONTEXT_CHANGED');
    }
    return { status: 'relationship_preparation_passed', modelId: input.modelId, runId, version: ready.version,
      sourceFingerprint: ready.sourceFingerprint, graphFingerprint: ready.graphFingerprint, runProofFingerprint: proof,
      recordCount: input.records.length, projectionScope: 'relationship_preparation', runtimeReadEnabled: false,
      relationshipWriteAttempted: false, writeAuthorizationIssued: false };
  } catch {
    return deny('SYNTHETIC_RELATION_PREPARATION_FAILED');
  }
}
