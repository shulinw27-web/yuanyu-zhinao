import { createHash, randomUUID } from 'node:crypto';
import { prepareSyntheticFactTransfer } from './synthetic-fact-preparation.js';
import { semanticInstanceConnection, requestSemanticInstance } from '../../backend/src/services/semantic-instance-transport.js';
import { mutateSemanticGovernanceState } from '../../backend/src/services/semantic-governance-store.js';
import { syntheticWire, wireFingerprint } from './synthetic-proof.js';

const namespace = 'semantic_synthetic_transfers';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const denied = code => ({ status: 'rejected', code, factWriteAttempted: false });
export const safeSyntheticConnection = connection => {
  try {
    const url = new URL(connection.endpoint);
    return connection.guarded === true && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
};

// Internal synthetic-only execution. Dependencies are server composition/test
// hooks, never HTTP fields. No background retry or real-enterprise ingestion.
export async function transferSyntheticFacts({ identityScope, body, runId, scenarioId, confirmed,
  connection = semanticInstanceConnection, request = requestSemanticInstance }) {
  let attempted = false; let token; let capturedRun;
  try {
    if (confirmed !== true || !validId(runId) || !validId(scenarioId)) return denied('SYNTHETIC_TRANSFER_CONFIRMATION_REQUIRED');
    const identity = structuredClone(identityScope); const input = structuredClone(body); capturedRun = runId;
    const target = structuredClone(connection());
    if (!safeSyntheticConnection(target) || target.tenantId !== identity.tenantId) return denied('SYNTHETIC_TRANSFER_LOCAL_INSTANCE_REQUIRED');
    const inspect = () => {
      // Pin the exact configured target, including credential generation.
      if (digest(connection()) !== digest(target)) throw new Error('Target changed');
      return request(target, `/models/${input.modelId}/definition`, { modelId: input.modelId });
    };
    const prepare = () => prepareSyntheticFactTransfer({ identityScope: identity, body: input, inspect });
    const ready = await prepare();
    if (ready.status !== 'preparation_passed') return denied(ready.code);
    const wire = syntheticWire(input, identity, ready, runId, scenarioId);
    const proofFingerprint = wireFingerprint(wire, input.modelId, ready.version);
    const inputDigest = digest({ input, scenarioId }); token = randomUUID();
    const reserved = await mutateSemanticGovernanceState(namespace, 'index', {}, index => {
      const existing = index[runId];
      if (existing) return { commit: false, result: { existing: { status: existing.status, inputDigest: existing.inputDigest,
        graphFingerprint: existing.graphFingerprint, deploymentId: existing.deploymentId, version: existing.version } } };
      if (Object.values(index).some(item => ['pending', 'dispatching', 'reconciliation_required'].includes(item.status))) return { commit: false, result: denied('SYNTHETIC_TRANSFER_RECONCILIATION_REQUIRED') };
      if (Object.keys(index).length >= 100) return { commit: false, result: denied('SYNTHETIC_TRANSFER_CAPACITY') };
      const entry = { token, status: 'pending', inputDigest, modelId: input.modelId, tenantId: identity.tenantId,
        subjectId: identity.subjectId, deploymentId: target.deploymentId, version: ready.version,
        sourceFingerprint: ready.sourceFingerprint, graphFingerprint: ready.graphFingerprint, scenarioId,
        proofFingerprint, leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
        createdAt: new Date().toISOString(), provenance: input.records.map(record => ({ id: record.id, organizationId: record.organizationId,
          sourceVersion: record.version, sourceSystem: record.sourceSystem, occurredAt: record.occurredAt })) };
      const next = { ...index, [runId]: entry };
      if (Buffer.byteLength(JSON.stringify(next)) > 2097152) return { commit: false, result: denied('SYNTHETIC_TRANSFER_CAPACITY') };
      return { value: next, result: { reserved: true } };
    });
    if (!reserved.reserved) {
      token = null;
      if (reserved.existing?.inputDigest === inputDigest && reserved.existing.status === 'completed') {
        if (reserved.existing.graphFingerprint !== ready.graphFingerprint || reserved.existing.deploymentId !== target.deploymentId
          || reserved.existing.version !== ready.version) return denied('SYNTHETIC_TRANSFER_CONTEXT_CHANGED');
        return { status: 'already_completed', modelId: input.modelId, factWriteAttempted: false };
      }
      return denied(reserved.code || (reserved.existing?.inputDigest !== inputDigest ? 'SYNTHETIC_TRANSFER_IDENTITY_CONFLICT' : 'SYNTHETIC_TRANSFER_RECONCILIATION_REQUIRED'));
    }
    // Persist an uncertain marker before entering the transport. A process crash
    // cannot later be interpreted as permission to automatically resend.
    await mutateSemanticGovernanceState(namespace, 'index', {}, index => {
      if (index[runId]?.token !== token || index[runId].status !== 'pending') throw new Error('Transfer ownership changed');
      index[runId].status = 'dispatching'; return { value: index };
    });
    const dispatchDeadline = await mutateSemanticGovernanceState(namespace, 'index', {}, index => ({ commit: false,
      result: index[runId]?.token === token && index[runId]?.status === 'dispatching' ? Date.parse(index[runId]?.leaseExpiresAt) : 0 }));
    if (!Number.isFinite(dispatchDeadline) || dispatchDeadline <= Date.now()) throw new Error('Transfer dispatch lease lost');
    const final = await prepare();
    if (final.status !== 'preparation_passed' || final.graphFingerprint !== ready.graphFingerprint || digest(connection()) !== digest(target)) {
      await finish('not_attempted'); return denied(final.code || 'SYNTHETIC_TRANSFER_CONTEXT_CHANGED');
    }
    if (dispatchDeadline <= Date.now()) throw new Error('Transfer dispatch lease lost');
    attempted = true;
    const receipt = await request(target, `/models/${input.modelId}/graph/ingest`, { method: 'POST', body: wire, modelId: input.modelId, projectionScope: 'synthetic_graph' });
    if (receipt?.status !== 'ingested' || receipt.modelId !== input.modelId || receipt.projectionScope !== 'synthetic_graph'
      || receipt.runtimeReadEnabled !== false || receipt.graphProtocol !== 1 || receipt.instance?.identityVerified !== true
      || receipt.instance.tenantId !== identity.tenantId || receipt.instance.deploymentId !== target.deploymentId
      || receipt.instance.modelId !== input.modelId || receipt.instance.graphProtocol !== 1 || receipt.instance.protocol !== 1
      || receipt.instance.modelProtocol !== 1 || receipt.instance.projectionScope !== 'synthetic_graph' || receipt.instance.runtimeReadEnabled !== false
      || receipt.modelVersion !== ready.version || receipt.modelFingerprint !== ready.graphFingerprint || receipt.run?.runId !== runId
      || receipt.run.proofFingerprint !== proofFingerprint
      || !Number.isSafeInteger(receipt.ingestedFacts)
      || receipt.ingestedFacts < 0 || receipt.ingestedFacts > input.records.length) throw new Error('Unverified graph receipt');
    const after = await prepare();
    if (after.status !== 'preparation_passed' || after.graphFingerprint !== ready.graphFingerprint) throw new Error('Post-send context changed');
    await finish('completed');
    return { status: 'completed', modelId: input.modelId, recordCount: input.records.length, ingestedFacts: receipt.ingestedFacts,
      factWriteAttempted: true, runtimeReadEnabled: false, projectionScope: 'synthetic_graph' };
  } catch {
    if (token) { try { await finish(attempted ? 'reconciliation_required' : 'not_attempted'); } catch { /* Keep the durable dispatching marker. */ } }
    return { status: attempted ? 'reconciliation_required' : 'rejected', code: attempted ? 'SYNTHETIC_TRANSFER_OUTCOME_UNKNOWN' : 'SYNTHETIC_TRANSFER_FAILED', factWriteAttempted: attempted };
  }

  async function finish(status) {
    return mutateSemanticGovernanceState(namespace, 'index', {}, index => {
      if (index[capturedRun]?.token !== token || !['pending', 'dispatching'].includes(index[capturedRun].status)) throw new Error('Transfer ownership changed');
      index[capturedRun].status = status; index[capturedRun].updatedAt = new Date().toISOString(); delete index[capturedRun].token;
      return { value: index };
    });
  }
}
