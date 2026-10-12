// Server-only synthetic composition. Unknown results are never retried by POST.
import { createHash, randomUUID } from 'node:crypto';
import { prepareSyntheticRelationships } from './synthetic-relationship-preparation.js';
import { safeSyntheticConnection } from './synthetic-fact-transfer.js';
import { semanticInstanceConnection, requestSemanticInstance } from '../../backend/src/services/semantic-instance-transport.js';
import { readSemanticGovernanceState, mutateSemanticGovernanceState } from '../../backend/src/services/semantic-governance-store.js';

const namespace = 'semantic_synthetic_relationships';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const denied = code => ({ status: 'rejected', code, relationshipWriteAttempted: false });
const pending = ['pending', 'dispatching', 'reconciliation_required'];
const same = (entry, ready, target, identity, inputDigest) => entry?.inputDigest === inputDigest && entry.subjectId === identity.subjectId
  && entry.tenantId === identity.tenantId && entry.modelId === ready.modelId && entry.deploymentId === target.deploymentId
  && entry.version === ready.version && entry.sourceFingerprint === ready.sourceFingerprint
  && entry.graphFingerprint === ready.graphFingerprint && entry.runProofFingerprint === ready.runProofFingerprint;
const verified = (receipt, ready, target, identity) => {
  const instance = receipt?.instance;
  return receipt?.status === 'materialized' && receipt.modelId === ready.modelId && receipt.runId === ready.runId
    && receipt.modelVersion === ready.version && receipt.modelFingerprint === ready.graphFingerprint
    && receipt.runProofFingerprint === ready.runProofFingerprint && /^[a-f0-9]{64}$/u.test(receipt.projectionFingerprint || '')
    && Number.isSafeInteger(receipt.relationshipCount) && receipt.relationshipCount >= 0 && receipt.relationshipCount <= 1000
    && receipt.relationshipProtocol === 1 && receipt.projectionScope === 'synthetic_relationships' && receipt.runtimeReadEnabled === false
    && instance?.identityVerified === true && instance.tenantId === identity.tenantId && instance.deploymentId === target.deploymentId
    && instance.modelId === ready.modelId && instance.protocol === 1 && instance.modelProtocol === 1 && instance.relationshipProtocol === 1
    && instance.projectionScope === 'synthetic_relationships' && instance.runtimeReadEnabled === false;
};
const context = args => {
  const identity = structuredClone(args.identityScope); const input = structuredClone(args.body);
  const connection = args.connection || semanticInstanceConnection; const request = args.request || requestSemanticInstance;
  const target = structuredClone(connection()); const pinned = hash(target);
  if (!safeSyntheticConnection(target) || target.tenantId !== identity.tenantId) throw new Error('Local instance required');
  const call = (path, options) => {
    if (hash(connection()) !== pinned) throw new Error('Target changed');
    return request(target, path, options);
  };
  const prepare = () => prepareSyntheticRelationships({ identityScope: identity, body: input, runId: args.runId, scenarioId: args.scenarioId,
    connection, request: (_target, path, options) => call(path, options) });
  return { identity, input, target, call, prepare, inputDigest: hash({ input, scenarioId: args.scenarioId }) };
};

export async function materializeSyntheticRelationships(args) {
  let token; let attempted = false; let runId;
  const finish = (status, receipt) => mutateSemanticGovernanceState(namespace, 'index', {}, index => {
    if (index[runId]?.token !== token || !['pending', 'dispatching'].includes(index[runId].status)) throw new Error('Ownership changed');
    index[runId].status = status; index[runId].updatedAt = new Date().toISOString(); delete index[runId].token;
    if (receipt) { index[runId].projectionFingerprint = receipt.projectionFingerprint; index[runId].relationshipCount = receipt.relationshipCount; }
    return { value: index };
  });
  try {
    if (args.confirmed !== true) return denied('SYNTHETIC_RELATION_CONFIRMATION_REQUIRED');
    const { identity, target, call, prepare, inputDigest } = context(args);
    const ready = await prepare();
    if (ready.status !== 'relationship_preparation_passed') return denied(ready.code);
    runId = ready.runId; token = randomUUID();
    const reserved = await mutateSemanticGovernanceState(namespace, 'index', {}, index => {
      if (index[runId]) return { commit: false, result: { existing: index[runId] } };
      if (Object.values(index).some(entry => pending.includes(entry.status))) return { commit: false, result: denied('SYNTHETIC_RELATION_RECONCILIATION_REQUIRED') };
      const entry = { token, status: 'pending', inputDigest, modelId: ready.modelId, tenantId: identity.tenantId, subjectId: identity.subjectId,
        deploymentId: target.deploymentId, version: ready.version, sourceFingerprint: ready.sourceFingerprint, graphFingerprint: ready.graphFingerprint,
        runProofFingerprint: ready.runProofFingerprint, runId, scenarioId: args.scenarioId, createdAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 60000).toISOString() };
      const next = { ...index, [runId]: entry };
      if (Object.keys(next).length > 100 || Buffer.byteLength(JSON.stringify(next)) > 262144) return { commit: false, result: denied('SYNTHETIC_RELATION_CAPACITY') };
      return { value: next, result: { reserved: true } };
    });
    if (!reserved.reserved) {
      token = null;
      if (reserved.existing?.status === 'completed' && same(reserved.existing, ready, target, identity, inputDigest)) {
        return { status: 'already_completed', modelId: ready.modelId, relationshipWriteAttempted: false, runtimeReadEnabled: false };
      }
      return denied(reserved.code || (same(reserved.existing, ready, target, identity, inputDigest) ? 'SYNTHETIC_RELATION_RECONCILIATION_REQUIRED' : 'SYNTHETIC_RELATION_IDENTITY_CONFLICT'));
    }
    const deadline = await mutateSemanticGovernanceState(namespace, 'index', {}, index => {
      if (index[runId]?.token !== token || index[runId].status !== 'pending') throw new Error('Ownership changed');
      index[runId].status = 'dispatching'; return { value: index, result: Date.parse(index[runId].leaseExpiresAt) };
    });
    const final = await prepare();
    if (final.status !== 'relationship_preparation_passed' || hash(final) !== hash(ready) || !Number.isFinite(deadline) || deadline <= Date.now()) {
      await finish('not_attempted'); return denied(final.code || 'SYNTHETIC_RELATION_CONTEXT_CHANGED');
    }
    attempted = true;
    const receipt = await call(`/models/${ready.modelId}/graph/relationships/materialize`, { modelId: ready.modelId, projectionScope: 'synthetic_relationships', method: 'POST',
      body: { runId, expectedFingerprint: ready.graphFingerprint, expectedRunProof: ready.runProofFingerprint, confirmed: true },
      beforeDispatch: async () => {
        const current = await prepare();
        if (current.status !== 'relationship_preparation_passed' || hash(current) !== hash(ready) || deadline <= Date.now()) throw new Error('Dispatch context changed');
      } });
    if (!verified(receipt, ready, target, identity)) throw new Error('Unverified receipt');
    const after = await prepare();
    if (after.status !== 'relationship_preparation_passed' || hash(after) !== hash(ready)) throw new Error('Context changed');
    await finish('completed', receipt);
    return { status: 'completed', modelId: ready.modelId, relationshipCount: receipt.relationshipCount, relationshipWriteAttempted: true, runtimeReadEnabled: false };
  } catch (error) {
    if (error?.requestAttempted === false) attempted = false;
    if (token) { try { await finish(attempted ? 'reconciliation_required' : 'not_attempted'); } catch { /* Preserve durable dispatching marker. */ } }
    return { status: attempted ? 'reconciliation_required' : 'rejected', code: attempted ? 'SYNTHETIC_RELATION_OUTCOME_UNKNOWN' : 'SYNTHETIC_RELATION_EXECUTION_FAILED', relationshipWriteAttempted: attempted };
  }
}

export async function reconcileSyntheticRelationships(args) {
  const reject = code => ({ status: 'reconciliation_required', code, relationshipWriteAttempted: false });
  try {
    const { identity, target, call, prepare, inputDigest } = context(args);
    const ready = await prepare();
    if (ready.status !== 'relationship_preparation_passed') return reject(ready.code);
    const entry = (await readSemanticGovernanceState(namespace, 'index', {}))[ready.runId];
    if (!same(entry, ready, target, identity, inputDigest) || ![...pending, 'completed'].includes(entry.status)) return reject('SYNTHETIC_RELATION_IDENTITY_CONFLICT');
    if (['pending', 'dispatching'].includes(entry.status) && (!Number.isFinite(Date.parse(entry.leaseExpiresAt)) || Date.parse(entry.leaseExpiresAt) > Date.now())) return reject('SYNTHETIC_RELATION_BUSY');
    const receipt = await call(`/models/${ready.modelId}/graph/relationships/runs/${ready.runId}`, { modelId: ready.modelId, projectionScope: 'synthetic_relationships' });
    if (!verified(receipt, ready, target, identity) || entry.projectionFingerprint && entry.projectionFingerprint !== receipt.projectionFingerprint
      || entry.relationshipCount !== undefined && entry.relationshipCount !== receipt.relationshipCount) return reject('SYNTHETIC_RELATION_PROOF_UNCONFIRMED');
    const final = await prepare();
    if (final.status !== 'relationship_preparation_passed' || hash(final) !== hash(ready)) return reject(final.code || 'SYNTHETIC_RELATION_CONTEXT_CHANGED');
    const completed = await mutateSemanticGovernanceState(namespace, 'index', {}, index => {
      if (hash(index[ready.runId]) !== hash(entry)) return { commit: false, result: false };
      index[ready.runId] = { ...entry, status: 'completed', projectionFingerprint: receipt.projectionFingerprint, relationshipCount: receipt.relationshipCount, reconciledAt: new Date().toISOString() };
      delete index[ready.runId].token; return { value: index, result: true };
    });
    return completed ? { status: 'reconciled', modelId: ready.modelId, relationshipCount: receipt.relationshipCount, relationshipWriteAttempted: false, runtimeReadEnabled: false }
      : reject('SYNTHETIC_RELATION_STATE_CONFLICT');
  } catch { return reject('SYNTHETIC_RELATION_RECONCILIATION_UNAVAILABLE'); }
}
