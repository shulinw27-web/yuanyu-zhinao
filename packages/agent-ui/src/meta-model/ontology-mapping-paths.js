// Structural discovery only: no record reads, equivalence inference, grants or writes.
const allowed = new Set(['predicate', 'objectType', 'fromField', 'toField', 'statusField', 'versionField', 'validFromField', 'validToField', 'asOf', 'direction']);
const mappingFields = ['fromField', 'toField', 'statusField', 'versionField', 'validFromField', 'validToField'];
const vertex = (type, field) => JSON.stringify([type, field]);
const fail = code => ({ status: 'rejected', code, paths: [], execution: 'none' });
const utc = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'));

export function discoverMappingPaths(draft, selection) {
  if (!selection || Array.isArray(selection) || Object.keys(selection).some(key => !['fromType', 'fromField', 'toType', 'toField', 'maxDepth'].includes(key))
    || !Number.isInteger(selection.maxDepth) || selection.maxDepth < 1 || selection.maxDepth > 4) return fail('MAPPING_PATH_INPUT_INVALID');
  if (!Array.isArray(draft?.objectTypes) || draft.objectTypes.length > 500 || !Array.isArray(draft.relationshipTypes) || draft.relationshipTypes.length > 1000
    || !Array.isArray(draft.scenario?.readPlans) || draft.scenario.readPlans.length > 100) return fail('MAPPING_PATH_MODEL_LIMIT');
  const types = new Map();
  for (const type of draft.objectTypes) {
    if (typeof type?.id !== 'string' || !type.id || types.has(type.id) || !Array.isArray(type.fields) || type.fields.length > 200 || type.fields.some(field => typeof field !== 'string' || !field)) return fail('MAPPING_PATH_MODEL_INVALID');
    types.set(type.id, type);
  }
  for (const [type, field] of [[selection.fromType, selection.fromField], [selection.toType, selection.toField]]) {
    if (!types.get(type)?.fields.includes(field)) return fail('MAPPING_PATH_INPUT_INVALID');
  }
  const start = vertex(selection.fromType, selection.fromField); const finish = vertex(selection.toType, selection.toField);
  if (start === finish) return fail('MAPPING_PATH_IDENTICAL_ENDPOINTS');
  const edges = new Map(); let clauses = 0;
  const planIds = new Set();
  for (const plan of draft.scenario.readPlans) {
    if (typeof plan?.id !== 'string' || planIds.has(plan.id) || !Array.isArray(plan.datasets) || plan.datasets.length > 100 || plan.datasets.some(item => !item || typeof item.id !== 'string' || !item.id)
      || new Set(plan.datasets.map(item => item.id)).size !== plan.datasets.length) return fail('MAPPING_PATH_MODEL_INVALID');
    planIds.add(plan.id);
    for (const [index, dataset] of plan.datasets.entries()) {
      if (!Array.isArray(dataset.where || [])) return fail('MAPPING_PATH_MODEL_INVALID');
      for (const clause of dataset.where || []) {
        if (++clauses > 2000) return fail('MAPPING_PATH_SEARCH_LIMIT');
        if (!clause || typeof clause !== 'object' || Array.isArray(clause)) return fail('MAPPING_PATH_MODEL_INVALID');
        if (!Object.hasOwn(clause, 'mapping')) continue;
        const binding = clause.mapping;
        if (dataset.where.length !== 1 || clause.target !== undefined || Object.keys(clause).some(key => !['field', 'dataset', 'sourceField', 'mapping'].includes(key))
          || !binding || typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).some(key => !allowed.has(key))
          || binding.direction !== undefined && !['forward', 'reverse'].includes(binding.direction) || !utc(binding.asOf)) return fail('MAPPING_PATH_BINDING_INVALID');
        const source = plan.datasets.slice(0, index).find(item => item.id === clause.dataset);
        const sourceType = types.get(source?.objectType); const targetType = types.get(dataset.objectType);
        if (!sourceType?.fields.includes(clause.sourceField) || !targetType?.fields.includes(clause.field)) return fail('MAPPING_PATH_BINDING_INVALID');
        const reverse = binding.direction === 'reverse';
        const from = reverse ? targetType : sourceType; const to = reverse ? sourceType : targetType;
        const relations = draft.relationshipTypes.filter(item => item?.from === from.id && item?.to === to.id && item?.predicate === binding.predicate);
        if (relations.length !== 1) return fail('MAPPING_PATH_RELATION_AMBIGUOUS');
        const relation = relations[0]; const mapping = relation.keyMapping; const lookup = types.get(binding.objectType);
        const names = mappingFields.map(name => binding[name]);
        if (mapping?.basis !== 'master_data_lookup' || typeof mapping.version !== 'string' || !mapping.version || mapping.version.length > 24
          || typeof mapping.owner !== 'string' || !mapping.owner || mapping.owner.length > 48 || typeof relation.predicate !== 'string' || !relation.predicate || mapping.lookupSource !== lookup?.id
          || mapping.fromField !== (reverse ? clause.field : clause.sourceField) || mapping.toField !== (reverse ? clause.sourceField : clause.field)
          || !Array.isArray(lookup?.sourceSystems) || lookup.sourceSystems.length !== 1 || !Array.isArray(lookup.fieldDefinitions)
          || names.some(name => typeof name !== 'string' || !lookup.fields.includes(name)) || new Set(names).size !== names.length) return fail('MAPPING_PATH_BINDING_INVALID');
        for (const [name, endpoint, field] of [[binding.fromField, from, mapping.fromField], [binding.toField, to, mapping.toField]]) {
          if (!lookup.fieldDefinitions.some(def => def?.name === name && def.reference === endpoint.id && (def.referenceField || endpoint.key) === field)) return fail('MAPPING_PATH_REFERENCE_INVALID');
        }
        const edge = { fromType: sourceType.id, fromField: clause.sourceField, toType: targetType.id, toField: clause.field,
          predicate: relation.predicate, lookupObject: lookup.id, direction: reverse ? 'reverse' : 'forward', version: mapping.version, asOf: binding.asOf, binding: { ...binding } };
        // Equal fields do not imply equal filtered datasets or preconditions. Keep
        // differently constrained declarations distinct, without evaluating them.
        const constraints = { sourceFilter: source.filter, targetFilter: dataset.filter, preconditions: plan.preconditions,
          sourceExpansion: source.expand, targetExpansion: dataset.expand, coverage: plan.coverage };
        const constraintShape = JSON.stringify(constraints);
        if (constraintShape.length > 16000) return fail('MAPPING_PATH_MODEL_LIMIT');
        edge.requiresConstraintReview = Object.keys(JSON.parse(constraintShape)).length > 0;
        const signature = JSON.stringify([vertex(edge.fromType, edge.fromField), vertex(edge.toType, edge.toField), relation.predicate, lookup.id, mapping.version, mappingFields.map(name => binding[name]), edge.direction, new Date(edge.asOf).toISOString(), constraintShape]);
        if (!edges.has(signature)) edges.set(signature, { ...edge, declarations: [] });
        edges.get(signature).declarations.push({ planId: plan.id, datasetId: dataset.id });
      }
    }
  }
  const adjacency = new Map();
  for (const edge of edges.values()) {
    const key = vertex(edge.fromType, edge.fromField);
    if (!adjacency.has(key)) adjacency.set(key, []);
    adjacency.get(key).push(edge);
  }
  const queue = [{ at: start, steps: [], seen: new Set([start]), asOf: null }]; const paths = [];
  let expansions = 0; let cyclesSkipped = 0; let timeConflicts = 0; let depthCuts = 0;
  for (let index = 0; index < queue.length; index++) {
    const state = queue[index];
    if (state.steps.length >= selection.maxDepth) { if (adjacency.has(state.at)) depthCuts++; continue; }
    for (const edge of adjacency.get(state.at) || []) {
      if (++expansions > 2000) return fail('MAPPING_PATH_SEARCH_LIMIT');
      const at = vertex(edge.toType, edge.toField); const asOf = new Date(edge.asOf).toISOString();
      if (state.seen.has(at)) { cyclesSkipped++; continue; }
      if (state.asOf && state.asOf !== asOf) { timeConflicts++; continue; }
      const steps = [...state.steps, edge];
      if (at === finish) {
        paths.push({ steps, asOf });
        if (paths.length > 1) return { status: 'ambiguous', code: 'MAPPING_PATH_AMBIGUOUS', paths, execution: 'none', maxDepth: selection.maxDepth, expansions, cyclesSkipped, timeConflicts, depthCuts };
      } else queue.push({ at, steps, seen: new Set([...state.seen, at]), asOf });
    }
  }
  return { status: paths.length ? 'candidate' : 'not_found', code: paths.length ? 'MAPPING_PATH_CANDIDATE_NOT_EXECUTABLE' : 'MAPPING_PATH_NOT_FOUND',
    paths, execution: 'none', maxDepth: selection.maxDepth, expansions, cyclesSkipped, timeConflicts, depthCuts, uniqueWithinBoundOnly: paths.length === 1 };
}
