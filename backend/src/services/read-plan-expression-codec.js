// A bounded data decoder, not an evaluator. The resulting canonical algebra
// must still pass field/scope/join validation and independent case replay.
const binary = new Set(['add', 'sub', 'mul', 'max', 'eq', 'ne', 'and', 'or', 'gt']);
export function decodeReadPlanExpressions(value) {
  let nodes = 0;
  const fail = () => { throw new Error('READ_EXPRESSION_ENCODING'); };
  const prefix = (tokens, depth) => {
    let cursor = 0;
    const word = () => { const value = tokens[cursor++]; if (typeof value !== 'string') return fail(); return value; };
    const read = level => {
      if (++nodes > 800 || level > 14) return fail();
      const op = word();
      if (op === 'literal') {
        const value = tokens[cursor++];
        if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) return fail();
        return { op, value };
      }
      if (['one', 'field'].includes(op)) return { op, dataset: word(), field: word() };
      if (op === 'output') return { op, id: word() };
      if (op === 'lookup') return { op, dataset: word(), field: word(), value: read(level + 1), resultField: word() };
      if (['sum', 'all', 'sum_where'].includes(op)) {
        const result = { op: op === 'sum_where' ? 'sum' : op, dataset: word(), value: read(level + 1) };
        if (op === 'sum_where') result.where = read(level + 1);
        return result;
      }
      if (op === 'if') return { op, condition: read(level + 1), then: read(level + 1), else: read(level + 1) };
      if (binary.has(op)) return { op, args: [read(level + 1), read(level + 1)] };
      return fail();
    };
    const result = read(depth);
    if (cursor !== tokens.length) return fail();
    return result;
  };
  const decode = (e, depth = 0) => {
    if (Array.isArray(e) && e.every(item => item === null || typeof item !== 'object')) return prefix(e, depth);
    if (++nodes > 800 || depth > 14 || !e || typeof e !== 'object') return fail();
    const next = item => decode(item, depth + 1);
    if (!Array.isArray(e)) {
      const result = { ...e };
      if (e.op === 'literal') return result;
      for (const key of ['value', 'where', 'condition', 'then', 'else']) if (e[key] !== undefined) result[key] = next(e[key]);
      if (e.args !== undefined) { if (!Array.isArray(e.args)) return fail(); result.args = e.args.map(next); }
      return result;
    }
    const [op, a, b, c, d] = e;
    const strings = (...items) => items.every(item => typeof item === 'string');
    if (op === 'literal' && e.length === 2 && (a === null || ['string', 'boolean', 'number'].includes(typeof a))) return { op, value: a };
    if (['one', 'field'].includes(op) && e.length === 3 && strings(a, b)) return { op, dataset: a, field: b };
    if (op === 'output' && e.length === 2 && strings(a)) return { op, id: a };
    if (op === 'lookup' && e.length === 5 && strings(a, b, d)) return { op, dataset: a, field: b, value: next(c), resultField: d };
    if (['sum', 'all'].includes(op) && e.length === 3 && strings(a)) return { op, dataset: a, value: next(b) };
    if (op === 'sum' && e.length === 4 && strings(a)) return { op, dataset: a, value: next(b), where: next(c) };
    if (op === 'if' && e.length === 4) return { op, condition: next(a), then: next(b), else: next(c) };
    if (binary.has(op) && e.length === 3) return { op, args: [next(a), next(b)] };
    return fail();
  };
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.outputs) || !Array.isArray(value.preconditions)
    || value.outputs.length > 24 || value.preconditions.length > 24) return fail();
  return { ...value, preconditions: value.preconditions.map(e => decode(e)), outputs: value.outputs.map(o => ({ ...o, expression: decode(o?.expression) })) };
}
