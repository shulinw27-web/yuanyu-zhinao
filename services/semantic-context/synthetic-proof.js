import { createHash } from 'node:crypto';

// Typed canonicalization uses IEEE754 bytes for numbers, avoiding differences
// between Python/JavaScript decimal exponent rendering. No source data is output.
const canonical = value => {
  if (value === null) return ['null'];
  if (Array.isArray(value)) return ['array', value.map(canonical)];
  if (typeof value === 'object') return ['object', Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => {
    if (/[\uD800-\uDFFF]/u.test(key)) throw new Error('Invalid synthetic proof key');
    return [key, canonical(value[key])];
  })];
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid synthetic proof number');
    const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value === 0 ? 0 : value); return ['number', bytes.toString('hex')];
  }
  if (typeof value === 'string' && /[\uD800-\uDFFF]/u.test(value)) throw new Error('Invalid synthetic proof string');
  if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
  throw new Error('Invalid synthetic proof value');
};
export const syntheticRunFingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function syntheticWire(input, identity, ready, runId, scenarioId) {
  return { runId, scenarioId, businessKey: '', expectedFingerprint: ready.graphFingerprint,
    expectedSystems: [...new Set(input.records.map(record => record.sourceSystem))].sort(), facts: input.records.map(record => ({
      id: record.id, sourceRecordId: record.id, sourceSystem: record.sourceSystem, objectType: record.objectType,
      eventType: 'synthetic_observation', status: 'observed', classification: record.classification, occurredAt: record.occurredAt,
      organizationId: record.organizationId, sourceVersion: record.version, tenantId: identity.tenantId,
      modelId: input.modelId, modelVersion: ready.version, modelFingerprint: ready.graphFingerprint, runId, simulated: true, payload: record.payload
    })) };
}
export const wireFingerprint = (wire, modelId, version) => syntheticRunFingerprint({ modelId, modelVersion: version,
  modelFingerprint: wire.expectedFingerprint, runId: wire.runId, scenarioId: wire.scenarioId, businessKey: wire.businessKey,
  expectedSystems: [...wire.expectedSystems].sort(), facts: [...wire.facts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) });
