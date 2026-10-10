// Small typed read algebra. No SQL, eval, scripts, URLs or permission grants
// can originate from a model. All joins and arithmetic are checked server-side.
import { createHash } from 'node:crypto';
import { admitSemanticRecord } from './semantic-record-contract-service.js';
import { ontologyMappingBinding, resolveOntologyMappingRows, ontologyMappingEvidence } from './ontology-mapping-execution.js';

const fail = code => { throw new Error(code); };
const identifier = v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v);
const object = (draft, id) => draft.objectTypes.find(o => o.id === id);
const fingerprint = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const ontologyQueryFingerprint = fingerprint;
const scalar = v => v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v);
const binary = new Set(['add', 'sub', 'mul', 'max', 'eq', 'ne', 'and', 'or', 'gt']);

export function validateOntologyReadPlans(draft) {
  let location = { kind: 'section', section: 'readPlans', index: -1, field: 'definition' };
  try {
    const requiresMapping = (from, fromField, to, toField) => (draft.relationshipTypes || []).some(relation => {
      const mapping = relation.keyMapping; if (!mapping) return false;
      const fieldsMatch = (a, b) => (!mapping.fromField || mapping.fromField === a) && (!mapping.toField || mapping.toField === b);
      return relation.from === from && relation.to === to && fieldsMatch(fromField, toField)
        || relation.from === to && relation.to === from && fieldsMatch(toField, fromField);
    });
    const plans = draft.scenario?.readPlans || [];
    if (!Array.isArray(plans) || plans.length > 3 || new Set(plans.map(p => p?.id)).size !== plans.length) fail('READ_PLAN_FORMAT');
    if (plans.length && (draft.scenario?.decisionBindings?.length || draft.scenario.requireCaseReplay !== true)) fail('READ_PLAN_REPLAY_REQUIRED');
    for (const plan of plans) {
      location = { kind: 'section', section: 'readPlans', index: plans.indexOf(plan), field: 'definition' };
      if (!identifier(plan.id) || !Array.isArray(plan.datasets) || !plan.datasets.length || plan.datasets.length > 24
        || !Array.isArray(plan.outputs) || !plan.outputs.length || plan.outputs.length > 24 || typeof plan.label !== 'string') fail('READ_PLAN_FORMAT');
      const aliases = new Map();
      for (const [index, ds] of plan.datasets.entries()) {
        location = { kind: 'section', section: 'readPlans', index: plans.indexOf(plan), datasetId: ds.id, field: 'datasets' };
        const type = object(draft, ds.objectType);
        if (!identifier(ds.id) || aliases.has(ds.id) || !type || type.sourceSystems.length !== 1 || !Array.isArray(ds.where) || ds.where.length !== 1) fail('READ_DATASET_FORMAT');
        const f = ds.where[0];
        location.field = 'where';
        if (!type.fields.includes(f.field)) fail('READ_FIELD_UNKNOWN');
        if (index === 0) {
          if (f.target !== true || f.field !== type.key || f.mapping) fail('READ_ROOT_KEY_REQUIRED');
        } else {
          const from = aliases.get(f.dataset); const fromType = from && object(draft, from.objectType);
          if (!fromType?.fields.includes(f.sourceField) || f.target) fail('READ_JOIN_UNKNOWN');
          const forward = type.fieldDefinitions?.some(x => x.name === f.field && x.reference === fromType.id && (x.referenceField || fromType.key) === f.sourceField);
          const backward = fromType.fieldDefinitions?.some(x => x.name === f.sourceField && x.reference === type.id && (x.referenceField || type.key) === f.field);
          if (f.mapping) ontologyMappingBinding(draft, fromType, type, f);
          else {
            if (!forward && !backward) fail('READ_JOIN_NOT_DECLARED');
            if (requiresMapping(fromType.id, f.sourceField, type.id, f.field)) fail('READ_MAPPING_EXECUTION_REQUIRED');
          }
        }
        aliases.set(ds.id, ds);
        location.field = 'filter';
        if (ds.filter && (!type.fields.includes(ds.filter.field) || !Array.isArray(ds.filter.values) || !ds.filter.values.length || ds.filter.values.length > 16 || ds.filter.values.some(v => !scalar(v)))) fail('READ_DATASET_FILTER_INVALID');
        if (ds.expand) {
          location.field = 'expand';
          const x = ds.expand; const edge = object(draft, x.edgeObjectType);
          if (!edge || edge.sourceSystems.length !== 1 || !Number.isInteger(x.maxDepth) || x.maxDepth < 1 || x.maxDepth > 8
            || !edge.fields.includes(x.stateField) || !Array.isArray(x.activeStates) || !x.activeStates.length || !Array.isArray(x.inactiveStates)
            || x.activeStates.length + x.inactiveStates.length > 32 || [...x.activeStates, ...x.inactiveStates].some(v => typeof v !== 'string' || v.length > 80)
            || x.activeStates.some(v => x.inactiveStates.includes(v))
            || ![x.fromField, x.toField].every(name => edge.fieldDefinitions?.some(f => f.name === name && f.reference === type.id && (f.referenceField || type.key) === type.key))) fail('READ_EXPANSION_INVALID');
          if ([x.fromField, x.toField].some(name => requiresMapping(edge.id, name, type.id, type.key))) fail('READ_MAPPING_EXECUTION_REQUIRED');
        }
      }
      location = { kind: 'section', section: 'readPlans', index: plans.indexOf(plan), field: 'coverage' };
      if (plan.coverage && (plan.coverage.mode !== 'bounded_declared_graph' || !Array.isArray(plan.coverage.requiredExpansions)
        || !plan.coverage.requiredExpansions.length || plan.coverage.requiredExpansions.some(id => !aliases.get(id)?.expand))) fail('READ_COVERAGE_INVALID');
      location.field = 'analysis';
      if (plan.analysis && (typeof plan.analysis !== 'object' || typeof plan.analysis.enabled !== 'boolean')) fail('READ_ANALYSIS_INVALID');
      const outputs = new Set(); let nodes = 0;
      const check = (e, row = new Set(), depth = 0) => {
        if (!e || depth > 14 || ++nodes > 800) fail('READ_EXPRESSION_LIMIT');
        if (e.op === 'literal') { if (!scalar(e.value) || typeof e.value === 'string' && e.value.length > 200) fail('READ_LITERAL_INVALID'); }
        else if (e.op === 'output') { if (!outputs.has(e.id)) fail('READ_OUTPUT_UNKNOWN'); }
        else if (e.op === 'field' || e.op === 'one') {
          const type = object(draft, aliases.get(e.dataset)?.objectType);
          if (!type?.fields.includes(e.field) || e.op === 'field' && !row.has(e.dataset)) fail('READ_FIELD_SCOPE');
        } else if (e.op === 'lookup') {
          const type = object(draft, aliases.get(e.dataset)?.objectType);
          if (!type?.fields.includes(e.field) || !type.fields.includes(e.resultField)) fail('READ_LOOKUP_FIELD');
          check(e.value, row, depth + 1);
        } else if (e.op === 'sum' || e.op === 'all') {
          if (!aliases.has(e.dataset)) fail('READ_DATASET_UNKNOWN');
          const nested = new Set([...row, e.dataset]);
          check(e.value, nested, depth + 1); if (e.where) check(e.where, nested, depth + 1);
        } else if (binary.has(e.op)) {
          if (!Array.isArray(e.args) || e.args.length !== 2) fail('READ_OPERATOR_ARITY');
          e.args.forEach(a => check(a, row, depth + 1));
        } else if (e.op === 'if') {
          check(e.condition, row, depth + 1); check(e.then, row, depth + 1); check(e.else, row, depth + 1);
        } else fail('READ_OPERATOR_UNKNOWN');
      };
      location.field = 'preconditions';
      if (plan.preconditions && (!Array.isArray(plan.preconditions) || plan.preconditions.length > 24)) fail('READ_PRECONDITION_FORMAT');
      for (const condition of plan.preconditions || []) check(condition);
      for (const output of plan.outputs) {
        location.field = 'outputs'; location.outputId = output.id;
        if (!identifier(output.id) || outputs.has(output.id) || typeof output.label !== 'string' || output.label.length > 100 || typeof output.unit !== 'string') fail('READ_OUTPUT_FORMAT');
        check(output.expression); outputs.add(output.id);
      }
    }
    return { status: 'passed', count: plans.length };
  } catch (error) { return { status: 'failed', code: error.message, ...(location ? { targets: [location] } : {}) }; }
}

export function getOntologyRuntimeGrant(scope, roleId, env = process.env) {
  if (!scope?.tenantId || !scope.subjectId) return null;
  try { return JSON.parse(env.ONTOLOGY_RUNTIME_GRANTS_JSON || '{}')[scope.tenantId]?.[roleId] || null; } catch { return null; }
}
export function requireOntologyObjectAccess(draft, typeId, roleId, scope) {
  const type = object(draft, typeId); const grant = getOntologyRuntimeGrant(scope, roleId)?.objects?.[typeId];
  const policies = (draft.accessPolicies || []).filter(p => p.objectType === typeId && (!p.roles?.length || p.roles.includes(roleId)));
  if (!type || !grant || type.sourceSystems.length !== 1 || grant.system !== type.sourceSystems[0]
    || !Array.isArray(grant.fields) || !type.fields.every(f => grant.fields.includes(f)) || !Array.isArray(grant.classifications)
    || policies.some(p => p.effect === 'deny') || !policies.some(p => p.effect === 'allow' && p.condition === 'iam_scope')
    || policies.some(p => p.effect !== 'allow' || p.condition !== 'iam_scope' || p.maskedFields?.length)) fail('READ_OBJECT_FORBIDDEN');
  return { type, grant };
}
export function ontologyDatasetQuery(draft, ds, datasets, target) {
  const type = object(draft, ds.objectType); const clause = ds.where[0];
  const values = clause.target ? [target] : [...new Set((datasets[clause.dataset] || []).map(r => r.payload[clause.sourceField]))];
  if (values.some(v => !scalar(v) || v === null) || values.length > 100) fail('READ_JOIN_VALUES_INVALID');
  return { schemaVersion: 'ontology-query.v1', objectType: type.id, fields: type.fields, filter: { field: clause.field, values }, limit: 100 };
}
export function admitOntologyDataset({ draft, ds, query, records, roleId, scope }) {
  const { type, grant } = requireOntologyObjectAccess(draft, ds.objectType, roleId, scope);
  if (!Array.isArray(records) || records.length > 100) fail('READ_RECORD_LIMIT');
  const seen = new Map();
  for (const record of records) {
    if (!admitSemanticRecord(record, roleId, scope, true) || record.objectType !== type.id || record.system !== grant.system
      || !grant.classifications.includes(record.classification) || !record.payload || record.payload[type.key] !== record.id
      || !query.filter.values.includes(record.payload[query.filter.field])) fail('READ_RECORD_SCOPE');
    const fields = {};
    for (const name of type.fields) {
      const value = record.payload[name]; const def = type.fieldDefinitions?.find(f => f.name === name);
      if ((value === undefined || value === null) && def?.required) fail('READ_REQUIRED_FIELD');
      if (value !== undefined && (!scalar(value) || typeof value === 'string' && value.length > 2000)) fail('READ_FIELD_VALUE');
      if (value !== undefined && value !== null && ['string', 'number', 'boolean'].includes(def?.type) && typeof value !== def.type) fail('READ_FIELD_TYPE');
      fields[name] = value ?? null;
    }
    const key = JSON.stringify([record.tenantId, record.system, type.id, record.id]);
    const existing = seen.get(key);
    const projected = { id: record.id, system: record.system, objectType: type.id, tenantId: record.tenantId, organizationId: record.organizationId, version: record.version,
      occurredAt: record.occurredAt, classification: record.classification, payload: fields };
    if (existing && fingerprint(existing) !== fingerprint(projected)) fail('READ_RECORD_CONFLICT');
    seen.set(key, projected);
  }
  return [...seen.values()];
}

export function calculateOntologyReadPlan(plan, datasets) {
  const outputs = {}; let operations = 0;
  const number = v => typeof v === 'number' && Number.isFinite(v) ? v : fail('READ_NOT_NUMERIC');
  const boolean = v => typeof v === 'boolean' ? v : fail('READ_NOT_BOOLEAN');
  function run(e, rows = {}) {
    if (++operations > 100000) fail('READ_COMPUTATION_LIMIT');
    if (e.op === 'literal') return e.value;
    if (e.op === 'output') return outputs[e.id];
    if (e.op === 'field') return rows[e.dataset]?.payload[e.field];
    if (e.op === 'one') { if (datasets[e.dataset]?.length !== 1) fail('READ_EXPECTED_SINGLE_RECORD'); return datasets[e.dataset][0].payload[e.field]; }
    if (e.op === 'lookup') {
      const value = run(e.value, rows); const matches = datasets[e.dataset].filter(r => r.payload[e.field] === value);
      if (matches.length !== 1) fail('READ_LOOKUP_NOT_UNIQUE'); return matches[0].payload[e.resultField];
    }
    if (e.op === 'sum') return datasets[e.dataset].reduce((sum, r) => {
      const next = { ...rows, [e.dataset]: r };
      return sum + (e.where && !boolean(run(e.where, next)) ? 0 : number(run(e.value, next)));
    }, 0);
    if (e.op === 'all') return datasets[e.dataset].every(r => boolean(run(e.value, { ...rows, [e.dataset]: r })));
    if (e.op === 'if') return run(boolean(run(e.condition, rows)) ? e.then : e.else, rows);
    const a = run(e.args[0], rows);
    if (e.op === 'and') return boolean(a) && boolean(run(e.args[1], rows));
    if (e.op === 'or') return boolean(a) || boolean(run(e.args[1], rows));
    const b = run(e.args[1], rows);
    if (e.op === 'eq') return a === b;
    if (e.op === 'ne') return a !== b;
    if (e.op === 'gt') return number(a) > number(b);
    if (e.op === 'add') return number(a) + number(b);
    if (e.op === 'sub') return number(a) - number(b);
    if (e.op === 'mul') return number(a) * number(b);
    if (e.op === 'max') return Math.max(number(a), number(b));
    fail('READ_OPERATOR_UNKNOWN');
  }
  for (const condition of plan.preconditions || []) if (!boolean(run(condition))) fail('READ_PRECONDITION_FAILED');
  for (const output of plan.outputs) {
    const value = run(output.expression);
    if (!scalar(value)) fail('READ_OUTPUT_INVALID'); outputs[output.id] = value;
  }
  return plan.outputs.map(o => ({ id: o.id, label: o.label, unit: o.unit, value: outputs[o.id] }));
}

export async function executeOntologyReadPlan({ draft, plan, target, roleId, scope, retrieve }) {
  if (validateOntologyReadPlans(draft).status !== 'passed' || !plan || !identifier(plan.id) || !draft.scenario.readPlans.some(p => fingerprint(p) === fingerprint(plan)) || typeof target !== 'string' || !target || target.length > 100) fail('READ_PLAN_INVALID');
  // Preflight every object before the first source request. Recheck each hop.
  const requiredTypes = [...new Set(plan.datasets.flatMap(ds => [ds.objectType, ...(ds.expand ? [ds.expand.edgeObjectType] : []), ...(ds.where[0].mapping ? [ds.where[0].mapping.objectType] : [])]))];
  requiredTypes.forEach(type => requireOntologyObjectAccess(draft, type, roleId, scope));
  const datasets = {}; const queries = []; const started = Date.now(); const extraRecords = new Map(); let processed = 0;
  const fetchRows = async (ds, query) => {
    if (Date.now() - started > 60000 || queries.length >= 64) fail('READ_DEADLINE_OR_QUERY_LIMIT');
    requireOntologyObjectAccess(draft, ds.objectType, roleId, scope);
    const raw = query.filter.values.length ? await retrieve(object(draft, ds.objectType), query) : [];
    if (!Array.isArray(raw) || (processed += raw.length) > 500) fail('READ_TOTAL_RECORD_LIMIT');
    const admitted = admitOntologyDataset({ draft, ds, query, records: raw, roleId, scope });
    queries.push({ dataset: ds.id, objectType: ds.objectType, sourceSystem: object(draft, ds.objectType).sourceSystems[0], filterField: query.filter.field, valueCount: query.filter.values.length, recordCount: admitted.length });
    return admitted;
  };
  const expansions = []; const mappingRuns = [];
  for (const ds of plan.datasets) {
    if (Date.now() - started > 60000) fail('READ_DEADLINE');
    let query = ontologyDatasetQuery(draft, ds, datasets, target); let mapped = null;
    const clause = ds.where[0];
    if (clause.mapping) {
      const source = datasets[clause.dataset];
      const contract = ontologyMappingBinding(draft, object(draft, plan.datasets.find(item => item.id === clause.dataset).objectType), object(draft, ds.objectType), clause);
      const rows = await fetchRows({ id: `${ds.id}:mapping`, objectType: contract.type.id }, { schemaVersion: 'ontology-query.v1', objectType: contract.type.id, fields: contract.type.fields, filter: { field: contract.readFromField, values: query.filter.values }, limit: 100 });
      for (const row of rows) {
        const key = `${row.system}:${row.objectType}:${row.id}`; const old = extraRecords.get(key);
        if (old && fingerprint(old) !== fingerprint(row)) fail('READ_RECORD_CONFLICT');
        extraRecords.set(key, row);
      }
      mapped = { contract, pairs: resolveOntologyMappingRows(contract, source, rows), source };
      query = { ...query, filter: { field: clause.field, values: [...new Set(mapped.pairs.map(pair => pair.target))] } };
    }
    datasets[ds.id] = (await fetchRows(ds, query)).filter(r => !ds.filter || ds.filter.values.includes(r.payload[ds.filter.field]));
    if (mapped) {
      for (const pair of mapped.pairs) {
        const targets = datasets[ds.id].filter(record => record.payload[clause.field] === pair.target);
        if (!targets.length) fail('READ_MAPPING_TARGET_MISSING');
        for (const from of mapped.source.filter(record => record.payload[clause.sourceField] === pair.source)) for (const to of targets) {
          const declaredFrom = mapped.contract.reverse ? to : from; const declaredTo = mapped.contract.reverse ? from : to;
          mappingRuns.push({ from: JSON.stringify(['instance', declaredFrom.system, declaredFrom.objectType, declaredFrom.id]), to: JSON.stringify(['instance', declaredTo.system, declaredTo.objectType, declaredTo.id]), predicate: mapped.contract.relation.predicate, fromType: declaredFrom.objectType, toType: declaredTo.objectType, mappingVersion: mapped.contract.relation.keyMapping.version, asOf: clause.mapping.asOf });
          if (mappingRuns.length > 2000) fail('READ_MAPPING_PAIR_LIMIT');
        }
      }
    }
    if (ds === plan.datasets[0] && datasets[ds.id].length !== 1) fail('READ_ROOT_NOT_FOUND');
    if (ds.expand) {
      const x = ds.expand; const type = object(draft, ds.objectType); const edgeType = object(draft, x.edgeObjectType);
      const seen = new Map(datasets[ds.id].map(r => [r.id, r])); let frontier = [...seen.keys()]; const edges = new Map(); let depth = 0;
      const makeQuery = (t, field, values) => ({ schemaVersion: 'ontology-query.v1', objectType: t.id, fields: t.fields, filter: { field, values }, limit: 100 });
      while (frontier.length) {
        if (frontier.length > 100) fail('READ_JOIN_VALUES_INVALID');
        const found = await fetchRows({ id: `${ds.id}:edges`, objectType: edgeType.id }, makeQuery(edgeType, x.fromField, frontier));
        const next = new Set();
        for (const edge of found) {
          const key = `${edge.system}:${edge.objectType}:${edge.id}`; const old = extraRecords.get(key);
          if (old && fingerprint(old) !== fingerprint(edge)) fail('READ_RECORD_CONFLICT');
          extraRecords.set(key, edge);
          const state = edge.payload[x.stateField];
          if (x.inactiveStates.includes(state)) continue;
          if (!x.activeStates.includes(state)) fail('READ_EDGE_STATE_UNKNOWN');
          const parent = edge.payload[x.fromField]; const child = edge.payload[x.toField];
          if (typeof child !== 'string' || !child) fail('READ_DANGLING_EDGE');
          if (!edges.has(parent)) edges.set(parent, new Set()); edges.get(parent).add(child);
          if (!seen.has(child)) next.add(child);
        }
        // A converging DAG is valid; an ancestor cycle is not silently "complete".
        const visiting = new Set(); const visited = new Set();
        const visit = id => { if (visiting.has(id)) fail('READ_GRAPH_CYCLE'); if (visited.has(id)) return; visiting.add(id); for (const child of edges.get(id) || []) visit(child); visiting.delete(id); visited.add(id); };
        for (const id of edges.keys()) visit(id);
        if (!next.size) break;
        if (depth++ >= x.maxDepth) fail('READ_EXPANSION_DEPTH_LIMIT');
        const children = await fetchRows({ id: `${ds.id}:children`, objectType: type.id }, makeQuery(type, type.key, [...next]));
        if (children.length !== next.size) fail('READ_DANGLING_EDGE');
        children.forEach(r => seen.set(r.id, r)); frontier = [...next];
      }
      datasets[ds.id] = [...seen.values()]; expansions.push({ dataset: ds.id, status: 'complete', nodes: seen.size, depth, maxDepth: x.maxDepth, remainingFrontier: 0, termination: 'no_new_descendants', direction: 'forward_only' });
    }
  }
  requiredTypes.forEach(type => requireOntologyObjectAccess(draft, type, roleId, scope));
  const unique = new Map();
  for (const r of [...Object.values(datasets).flat(), ...extraRecords.values()]) {
    const key = `${r.system}:${r.objectType}:${r.id}`;
    if (unique.has(key) && fingerprint(unique.get(key)) !== fingerprint(r)) fail('READ_RECORD_CONFLICT');
    unique.set(key, r);
  }
  const records = [...unique.values()];
  if (Date.now() - started > 60000) fail('READ_DEADLINE');
  if (records.some(r => !admitSemanticRecord(r, roleId, scope, true))) fail('READ_RECORD_SCOPE');
  const results = calculateOntologyReadPlan(plan, datasets);
  return { results, queries, datasets, records, mappingEvidence: ontologyMappingEvidence.create(draft, records, mappingRuns), coverage: { status: plan.coverage ? 'complete_for_declared_graph' : 'declared_plan_only', expansions, mappings: mappingRuns.length, globalEnterpriseCoverage: false }, sourceMode: 'scoped_source_snapshot_not_realtime_promise', executionAuthorized: false };
}
