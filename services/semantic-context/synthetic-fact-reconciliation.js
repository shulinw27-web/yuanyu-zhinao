import { createHash } from 'node:crypto';
import { prepareSyntheticFactTransfer } from './synthetic-fact-preparation.js';
import { safeSyntheticConnection } from './synthetic-fact-transfer.js';
import { semanticInstanceConnection, requestSemanticInstance } from '../../backend/src/services/semantic-instance-transport.js';
import { readSemanticGovernanceState, mutateSemanticGovernanceState } from '../../backend/src/services/semantic-governance-store.js';
import { syntheticWire, wireFingerprint } from './synthetic-proof.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reject = code => ({ status: 'reconciliation_required', code, factWriteAttempted: false });

// Reconcile only a positive exact proof. Missing runs or mismatches cannot prove
// that a prior write never happened, so they never unlock or resend the batch.
export async function reconcileSyntheticTransfer({ identityScope, body, runId, scenarioId,
  connection = semanticInstanceConnection, request = requestSemanticInstance }) {
  try {
    if (![runId, scenarioId].every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u.test(id))) return reject('SYNTHETIC_TRANSFER_INPUT_INVALID');
    const identity = structuredClone(identityScope); const input = structuredClone(body); const target = structuredClone(connection());
    if (!safeSyntheticConnection(target) || target.tenantId !== identity.tenantId) return reject('SYNTHETIC_TRANSFER_LOCAL_INSTANCE_REQUIRED');
    const inspect = () => {
      if (hash(connection()) !== hash(target)) throw new Error('Target changed');
      return request(target, `/models/${input.modelId}/definition`, { modelId: input.modelId });
    };
    const prepare = () => prepareSyntheticFactTransfer({ identityScope: identity, body: input, inspect });
    const ready = await prepare();
    if (ready.status !== 'preparation_passed') return reject(ready.code);
    const saved = await readSemanticGovernanceState('semantic_synthetic_transfers', 'index', {});
    const entry = saved[runId];
    if (!entry || entry.tenantId !== identity.tenantId || entry.modelId !== input.modelId || entry.subjectId !== identity.subjectId
      || entry.scenarioId !== scenarioId || entry.inputDigest !== hash({ input, scenarioId })) return reject('SYNTHETIC_TRANSFER_IDENTITY_CONFLICT');
    if (!['pending', 'dispatching', 'reconciliation_required', 'completed'].includes(entry.status)) return reject('SYNTHETIC_TRANSFER_STATE_CONFLICT');
    if (['pending', 'dispatching'].includes(entry.status) && (!Number.isFinite(Date.parse(entry.leaseExpiresAt)) || Date.parse(entry.leaseExpiresAt) > Date.now())) return reject('SYNTHETIC_TRANSFER_BUSY');
    const proof = wireFingerprint(syntheticWire(input, identity, ready, runId, scenarioId), input.modelId, ready.version);
    if (entry.deploymentId !== target.deploymentId || entry.version !== ready.version || entry.graphFingerprint !== ready.graphFingerprint
      || entry.sourceFingerprint !== ready.sourceFingerprint || entry.proofFingerprint !== proof) return reject('SYNTHETIC_TRANSFER_CONTEXT_CHANGED');
    if (hash(connection()) !== hash(target)) return reject('SYNTHETIC_TRANSFER_CONTEXT_CHANGED');
    const receipt = await request(target, `/models/${input.modelId}/graph/runs/${runId}`, { modelId: input.modelId, projectionScope: 'synthetic_graph' });
    const instance = receipt?.instance;
    if (receipt?.status !== 'ready' || receipt.modelId !== input.modelId || receipt.modelVersion !== ready.version
      || receipt.modelFingerprint !== ready.graphFingerprint || receipt.graphProtocol !== 1 || receipt.projectionScope !== 'synthetic_graph'
      || receipt.runtimeReadEnabled !== false || receipt.run?.runId !== runId || receipt.run.proofFingerprint !== proof
      || receipt.run.facts !== input.records.length || instance?.identityVerified !== true || instance.tenantId !== identity.tenantId
      || instance.deploymentId !== target.deploymentId || instance.modelId !== input.modelId || instance.protocol !== 1
      || instance.modelProtocol !== 1 || instance.graphProtocol !== 1 || instance.projectionScope !== 'synthetic_graph'
      || instance.runtimeReadEnabled !== false) return reject('SYNTHETIC_TRANSFER_PROOF_UNCONFIRMED');
    const after = await prepare();
    if (after.status !== 'preparation_passed' || after.graphFingerprint !== ready.graphFingerprint || hash(connection()) !== hash(target)) return reject(after.code || 'SYNTHETIC_TRANSFER_CONTEXT_CHANGED');
    const completed = await mutateSemanticGovernanceState('semantic_synthetic_transfers', 'index', {}, index => {
      if (hash(index[runId]) !== hash(entry)) return { commit: false, result: false };
      index[runId].status = 'completed'; index[runId].reconciledAt = new Date().toISOString(); delete index[runId].token;
      return { value: index, result: true };
    });
    return completed ? { status: 'reconciled', modelId: input.modelId, recordCount: input.records.length, factWriteAttempted: false, runtimeReadEnabled: false }
      : reject('SYNTHETIC_TRANSFER_STATE_CONFLICT');
  } catch { return reject('SYNTHETIC_TRANSFER_RECONCILIATION_UNAVAILABLE'); }
}
