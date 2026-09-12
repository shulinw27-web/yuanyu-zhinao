import { createHash } from 'node:crypto';
import { createMemoryDecision, normalizeUntrustedText } from './prompt-security-service.js';

export const memoryFingerprint = memory => createHash('sha256').update(JSON.stringify([
  memory.id, memory.content || memory.summary, memory.source, memory.expiresAt, memory.updatedAt || memory.createdAt
])).digest('hex');

export function prepareMemoryCorrection(memoryId, body) {
  const fail = (code, status = 400) => ({ error: code, code, status });
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['content', 'expectedFingerprint', 'confirmed'].includes(key))
    || body.confirmed !== true || typeof body.content !== 'string' || body.content.length > 8000
    || !/^[a-f0-9]{64}$/.test(body.expectedFingerprint || '')) return fail('MEMORY_CORRECTION_INVALID');
  const content = normalizeUntrustedText(body.content);
  const decision = createMemoryDecision(content, { source: 'long_term_memory' });
  if (decision.status !== 'audit_only' || decision.summary.length < 4) return fail('MEMORY_CONTENT_REJECTED');
  return { mutation(items) {
    const target = items.find(item => item.id === memoryId && Date.parse(item.expiresAt) > Date.now());
    if (!target) return { commit: false, result: fail('MEMORY_NOT_FOUND', 404) };
    if (memoryFingerprint(target) !== body.expectedFingerprint) return { commit: false, result: fail('MEMORY_REVISION_CONFLICT', 409) };
    // Manual correction does not extend retention or grant business authority.
    const next = { ...target, content, summary: decision.summary, entities: [], source: 'user_corrected_goal',
      trust: 'user_stated_unverified', updatedAt: new Date().toISOString(), reusable: true };
    return { value: items.map(item => item.id === memoryId ? next : item), result: { memory: next, grantsAuthority: false } };
  } };
}
