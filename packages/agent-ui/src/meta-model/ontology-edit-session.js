// Local editing history only: never grants access, writes or restores a published model.
export function createOntologyEditSession({ limit = 50, maxBytes = 4000000 } = {}) {
  let current = ''; let past = []; let future = [];
  const encode = value => JSON.stringify(value);
  const decode = value => value ? JSON.parse(value) : null;
  const trim = () => {
    while (past.length > limit || past.length && [...past, current, ...future].reduce((sum, value) => sum + value.length * 2, 0) > maxBytes) past.shift();
  };
  return {
    reset(value) { current = encode(value); past = []; future = []; },
    record(value) { const next = encode(value); if (next === current) return false; if (current) past.push(current); current = next; future = []; trim(); return true; },
    undo() { if (!past.length) return null; future.unshift(current); current = past.pop(); return decode(current); },
    redo() { if (!future.length) return null; past.push(current); current = future.shift(); trim(); return decode(current); },
    counts() { return { undo: past.length, redo: future.length }; }
  };
}

// Stable SCC condensation layout. Cycles remain in one column; no semantic edges added.
export function layoutOntologyGraph(graph) {
  const ids = graph.nodes.map(node => node.id); const known = new Set(ids);
  const next = new Map(ids.map(id => [id, []]));
  for (const edge of graph.edges) if (known.has(edge.from) && known.has(edge.to)) next.get(edge.from).push(edge.to);
  const index = new Map(); const low = new Map(); const stack = []; const active = new Set(); const groups = [];
  function visit(id) {
    index.set(id, index.size); low.set(id, index.get(id)); stack.push(id); active.add(id);
    for (const target of next.get(id)) {
      if (!index.has(target)) { visit(target); low.set(id, Math.min(low.get(id), low.get(target))); }
      else if (active.has(target)) low.set(id, Math.min(low.get(id), index.get(target)));
    }
    if (low.get(id) === index.get(id)) {
      const group = []; let member;
      do { member = stack.pop(); active.delete(member); group.push(member); } while (member !== id);
      groups.push(group);
    }
  }
  for (const id of ids) if (!index.has(id)) visit(id);
  const groupOf = new Map(groups.flatMap((members, ordinal) => members.map(id => [id, ordinal])));
  const outgoing = groups.map(() => new Set()); const incoming = groups.map(() => 0); const rank = groups.map(() => 0);
  for (const edge of graph.edges) {
    const from = groupOf.get(edge.from); const to = groupOf.get(edge.to);
    if (from !== undefined && to !== undefined && from !== to && !outgoing[from].has(to)) { outgoing[from].add(to); incoming[to]++; }
  }
  const queue = incoming.flatMap((count, id) => count === 0 ? [id] : []);
  for (let i = 0; i < queue.length; i++) for (const to of outgoing[queue[i]]) {
    rank[to] = Math.max(rank[to], rank[queue[i]] + 1); if (--incoming[to] === 0) queue.push(to);
  }
  const rows = new Map(); const positions = Object.create(null);
  for (const id of ids) { const column = rank[groupOf.get(id)]; const row = rows.get(column) || 0; rows.set(column, row + 1); positions[id] = { x: 140 + column * 300, y: 95 + row * 155 }; }
  return positions;
}
