import { extractQueryBusinessIds } from './agent-query-service.js';

const text = (value, max = 300) => String(value || '').slice(0, max);
const upsert = (items, added, key, limit) => {
  const map = new Map(items.map((item) => [key(item), item]));
  for (const item of added) { map.delete(key(item)); map.set(key(item), item); }
  return [...map.values()].slice(-limit);
};

// This is an index of past observations, not a cache of authorized business
// facts. Every reference must be read again under current access before use.
export function updateStructuredConversationMemory(previous, { goal, response = {}, quarantined = false, nowAt = Date.now() }) {
  const current = previous?.schemaVersion === 'agent-memory.v1' ? previous : {};
  const createdAt = new Date(nowAt).toISOString();
  const evidence = quarantined ? [] : (response.evidence || []).filter((item) => item.id && item.source).slice(0, 24).map((item) => ({
    id: text(item.id, 180), source: text(item.source, 120), version: text(item.provenance?.objectVersion || item.version, 120) || null,
    businessIds: extractQueryBusinessIds({ id: item.id, title: item.title }).slice(0, 10),
    trust: 'reference_only_requires_revalidation', observedAt: createdAt, expiresAt: new Date(nowAt + 86_400_000).toISOString()
  }));
  const runId = response.runId || response.run?.id;
  const state = response.lifecycle?.state;
  const decisions = !quarantined && runId && state ? [{ runId: text(runId, 180), state: text(state, 80), commandId: text(response.command?.id, 100) || null, createdAt, grantsAuthority: false }] : [];
  const receipt = response.run?.execution;
  const artifacts = !quarantined && receipt && ['executed', 'succeeded'].includes(response.run?.status) ? [{
    runId: text(runId, 180), recordId: text(receipt.businessRecordId || receipt.requisitionId || receipt.artifact?.relativePath, 300),
    status: text(receipt.status, 80), createdAt, trust: 'receipt_reference_only'
  }].filter((item) => item.recordId) : [];
  return {
    schemaVersion: 'agent-memory.v1',
    goal: { text: text(goal, 8000), businessIds: extractQueryBusinessIds(goal).slice(0, 10), trust: 'user_stated_unverified' },
    facts: upsert((current.facts || []).filter((item) => Date.parse(item.expiresAt) > nowAt), evidence, (item) => JSON.stringify([item.source, item.id, item.version]), 24),
    decisions: upsert(current.decisions || [], decisions, (item) => item.runId, 24),
    artifacts: upsert(current.artifacts || [], artifacts, (item) => JSON.stringify([item.runId, item.recordId]), 12),
    updatedAt: createdAt
  };
}

export function structuredMemoryPrompt(memory, nowAt = Date.now()) {
  if (!memory) return '';
  const current = { ...memory, facts: (memory.facts || []).filter((item) => Date.parse(item.expiresAt) > nowAt) };
  return `结构化任务索引（事实仅是来源引用，必须重新查询；决策不是授权，产物不是新的执行许可）：\n${JSON.stringify(current)}`;
}
