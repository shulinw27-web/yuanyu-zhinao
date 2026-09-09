import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAgentGoalMemory } from '../src/services/agent-memory-selection-service.js';
import { rememberAgentLongTermGoal } from '../src/services/agent-runtime-store.js';
import { runPrivateAgent } from '../src/services/private-agent-service.js';
import { getRole } from '../src/services/authorization-service.js';

const memories = Array.from({ length: 6 }, (_, index) => ({ id: `memory-${index}`, domain: 'production', summary: `处理生产报警 CASE-${index + 100}` }));

test('memory retrieval searches beyond the latest three and matches complete business identifiers', () => {
  assert.equal(selectAgentGoalMemory('继续 CASE-105', memories).selected[0].id, 'memory-5');
  assert.deepEqual(selectAgentGoalMemory('继续 CASE-10', memories).selected, []);
  assert.deepEqual(selectAgentGoalMemory('继续 CASE-999', memories).selected, []);
  assert.deepEqual(selectAgentGoalMemory('继续 CASE-100 CASE-101', memories).selected, []);
});

test('multiple goals in the same domain need selection; explicit memory id disambiguates', () => {
  assert.equal(selectAgentGoalMemory('给我方案', memories).ambiguous, true);
  assert.equal(selectAgentGoalMemory('继续 memory-4', memories).selected[0].id, 'memory-4');
  assert.deepEqual(selectAgentGoalMemory('继续 memory-40', memories).selected, []);
  assert.equal(selectAgentGoalMemory('继续', memories.slice(0, 1)).selected.length, 1);
  assert.equal(selectAgentGoalMemory('继续', []).ambiguous, false);
});

test('Agent asks for a same-domain goal choice without reading business data', async () => {
  const role = getRole('production_manager');
  const identity = { tenantId: 'memory-loop-test', subjectId: 'same-domain-user', sessionId: 's1', deviceId: 'd1' };
  for (const item of memories) rememberAgentLongTermGoal({ roleId: role.id, identityScope: identity, goal: item.summary, domain: item.domain });
  const ambiguous = await runPrivateAgent({ text: '给我一个处理方案' }, role, identity);
  assert.equal(ambiguous.memory.source, 'long_term_ambiguous');
  assert.deepEqual(ambiguous.evidence, []);
  assert.equal(ambiguous.command, null);
  assert.equal(ambiguous.memory.entries.length, 6);
  assert.match(ambiguous.text, /CASE-100/);
  const continued = await runPrivateAgent({ text: '继续 CASE-100，给我处理方案' }, role, identity);
  assert.equal(continued.memory.source, 'long_term');
  assert.equal(continued.memory.entries.length, 1);
  assert.equal(continued.command, null);
});
