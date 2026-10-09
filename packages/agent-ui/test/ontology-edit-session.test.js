import test from 'node:test';
import assert from 'node:assert/strict';
import { createOntologyEditSession, layoutOntologyGraph } from '../src/meta-model/ontology-edit-session.js';
test('bounded local editing history clones, clears redo on a branch and resets at scope changes', () => {
  const session = createOntologyEditSession({ limit: 2 }); const draft = { label: '初始' }; session.reset(draft);
  draft.label = '一'; session.record(draft); draft.label = '二'; session.record(draft); draft.label = '三'; session.record(draft);
  assert.deepEqual(session.counts(), { undo: 2, redo: 0 });
  assert.equal(session.undo().label, '二'); assert.equal(session.redo().label, '三');
  session.undo(); session.record({ label: '分支' }); assert.equal(session.redo(), null);
  session.reset({ label: '新身份' }); assert.equal(session.undo(), null);
});
test('history budget discards old snapshots without changing the current draft', () => {
  const session = createOntologyEditSession({ maxBytes: 30 }); session.reset({ label: 'large initial' }); session.record({ label: 'latest' });
  assert.equal(session.undo(), null); assert.equal(session.record({ label: 'latest' }), false);
});
test('automatic layout respects directed topology, cycles, disconnected nodes and unsafe-looking ids without mutating semantics', () => {
  const graph = { nodes: ['A', 'B', 'C', 'D', '__proto__'].map(id => ({ id })), edges: [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'C', to: 'B' }, { from: 'C', to: 'D' }, { from: 'missing', to: 'D' }] };
  const before = JSON.stringify(graph); const positions = layoutOntologyGraph(graph);
  assert.equal(positions.B.x, positions.C.x); assert.ok(positions.A.x < positions.B.x); assert.ok(positions.C.x < positions.D.x);
  assert.ok(Object.hasOwn(positions, '__proto__')); assert.equal(JSON.stringify(graph), before);
  assert.deepEqual(layoutOntologyGraph(graph), positions); assert.equal(new Set(Object.values(positions).map(p => `${p.x}:${p.y}`)).size, 5);
});
