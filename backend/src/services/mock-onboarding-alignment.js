// Deterministic, bounded review of HUMAN mappings. No model calls, expressions,
// external URLs, inferred identity merges, publication or business execution.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value);
const scalar = value => label(value) || (typeof value === 'number' && Number.isFinite(value));
const key = value => JSON.stringify(value);
const numeric = field => ['number', 'integer'].includes(field?.type);
const keysOnly = (value, allowed) => object(value) && Object.keys(value).every(name => allowed.includes(name));
const unitPairs = new Map([['kg:g', 1000], ['g:kg', 0.001], ['kg:kg', 1], ['g:g', 1], ['piece:piece', 1], ['case:case', 1], ['CNY:CNY', 1]]);
const boundary = '仅验证人工配置范围内的合成数据；依据说明未被自动认证，不代表完整业务模型、真实系统接入、审批或执行回执。';
const problem = (code, path, message) => ({ code, path, message });

export function validateMockAlignment(config, tables) {
  const issues = [];
  const add = (path, message) => issues.push(problem('MAPPING_INVALID', path, message));
  if (!keysOnly(config, ['version', 'identities', 'units', 'states']) || config.version !== 'mock-alignment.v1'
    || !['identities', 'units', 'states'].every(name => Array.isArray(config[name]) && config[name].length <= 40)) return [problem('MAPPING_INVALID', 'config', '需提供 mock-alignment.v1 和 identities/units/states 数组，每类最多 40 条规则。')];
  if (!config.identities.length && !config.units.length && !config.states.length) add('config', '至少需要一条人工映射规则。');
  if (Buffer.byteLength(JSON.stringify(config)) > 65536) return [problem('MAPPING_INVALID', 'config', '映射配置不得超过 64 KiB。')];
  const schemas = new Map(tables.map(table => [table.name, table]));
  const used = new Set(); const canonical = new Map();
  for (const category of ['identities', 'units', 'states']) for (const [index, rule] of config[category].entries()) {
    const path = `${category}[${index}]`;
    const allowed = category === 'identities' ? ['objectType', 'canonicalType', 'granularity', 'aliases', 'evidence', 'materialEvidence']
      : category === 'units' ? ['objectType', 'field', 'sourceUnit', 'targetUnit', 'unitField', 'lookup', 'evidence', 'materialEvidence'] : ['objectType', 'field', 'values', 'evidence', 'materialEvidence'];
    if (!keysOnly(rule, allowed) || !label(rule.evidence)) { add(path, '规则包含未知属性或缺少 1–160 字符的人工依据说明。'); continue; }
    const table = schemas.get(rule.objectType);
    if (!table) { add(path, '对象不在当前字典中。'); continue; }
    const signature = key([category, rule.objectType, rule.field, category === 'units' ? rule.sourceUnit : null]);
    if (used.has(signature)) add(path, '同一范围的映射规则重复。'); used.add(signature);
    if (category === 'identities') {
      if (!label(rule.canonicalType) || !label(rule.granularity) || (table.granularity && table.granularity !== rule.granularity)) add(path, '统一类型和粒度必须明确，粒度不得与字典冲突。');
      if (canonical.has(rule.canonicalType) && canonical.get(rule.canonicalType) !== rule.granularity) add(path, '不同粒度不能合并到同一统一类型。');
      canonical.set(rule.canonicalType, rule.granularity);
      if (!Array.isArray(rule.aliases) || rule.aliases.length > 500) { add(path, 'aliases 需为最多 500 对显式标识映射；空数组代表明确沿用源主键。'); continue; }
      const sources = new Set(); const targets = new Set();
      const primary = table.fields.find(field => field.name === table.primaryKey);
      for (const alias of rule.aliases) {
        if (!keysOnly(alias, ['source', 'target']) || !scalar(alias.source) || !scalar(alias.target)
          || (numeric(primary) ? typeof alias.source !== 'number' || (primary.type === 'integer' && !Number.isSafeInteger(alias.source)) : typeof alias.source !== 'string')) { add(path, '标识映射必须提供有效 source/target，source 类型匹配源主键。'); continue; }
        if (sources.has(key(alias.source)) || targets.has(key(alias.target))) add(path, '同一对象的标识映射必须一一对应，不得隐式合并记录。');
        sources.add(key(alias.source)); targets.add(key(alias.target));
      }
    } else if (category === 'units') {
      const field = table.fields.find(field => field.name === rule.field);
      if (!numeric(field)) add(path, '换算字段必须为字典中的数值字段。');
      if (rule.unitField !== undefined && table.fields.find(field => field.name === rule.unitField)?.type !== 'string') add(path, '单位字段必须为字典中的字符串字段。');
      if (!rule.unitField && field?.unit !== rule.sourceUnit) add(path, '没有逐行单位字段时，源单位必须由字典字段的 unit 明确声明。');
      const packaging = rule.sourceUnit === 'case' && rule.targetUnit === 'piece';
      if (!unitPairs.has(`${rule.sourceUnit}:${rule.targetUnit}`) && !packaging) add(path, '不支持该单位换算；重量与件数、不同货币不能直接互换。');
      if (packaging) {
        const lookup = rule.lookup; const target = schemas.get(lookup?.objectType); const via = table.fields.find(field => field.name === lookup?.viaField);
        if (!keysOnly(lookup, ['objectType', 'viaField', 'valueField']) || !target || via?.reference !== target.name
          || (via.referenceField && via.referenceField !== target.primaryKey) || !numeric(target.fields.find(field => field.name === lookup.valueField))) add(path, '箱转件必须通过字典声明外键查询数值包装系数，不支持全局固定系数或猜测。');
      } else if (rule.lookup !== undefined) add(path, '标准单位换算不接受自定义系数或查询。');
      const peers = config.units.filter(other => other?.objectType === rule.objectType && other?.field === rule.field);
      if (peers.some(other => other.targetUnit !== rule.targetUnit || other.unitField !== rule.unitField)) add(path, '同一字段的所有源单位必须使用相同单位字段与目标单位。');
    } else {
      if (table.fields.find(field => field.name === rule.field)?.type !== 'string') add(path, '状态字段必须为字典中的字符串字段。');
      if (!Array.isArray(rule.values) || !rule.values.length || rule.values.length > 100) { add(path, '需提供 1–100 对明确状态值。'); continue; }
      const values = new Set();
      for (const pair of rule.values) {
        if (!keysOnly(pair, ['source', 'target']) || !label(pair.source) || !label(pair.target)) { add(path, '状态映射必须提供非空 source/target。'); continue; }
        if (values.has(pair.source)) add(path, '同一源状态不能映射到多个目标。'); values.add(pair.source);
        if (pair.source === 'approved' && ['executed', 'completed', '已执行', '已完成'].includes(pair.target)) add(path, '审批通过不能映射为已执行或已完成；必须单独核对执行回执。');
      }
    }
  }
  return issues.slice(0, 100);
}

export function evaluateMockAlignment({ config, tables, records, tenantId }) {
  const issues = validateMockAlignment(config, tables);
  const result = { status: 'needs_review', scope: 'configured_rules_only', boundary, issues, counts: { identities: 0, links: 0, units: 0, states: 0 }, previews: { identities: [], links: [], units: [], states: [] }, previewLimit: 10 };
  if (issues.length) return result;
  if (!Array.isArray(records) || !records.length || records.length > 500 || records.some(row => !object(row) || row.tenantId !== tenantId || !object(row.payload))) {
    issues.push(problem('SOURCE_SCOPE_INVALID', 'records', '记录范围无效或包含其他租户；未进行业务映射。')); return result;
  }
  const schemas = new Map(tables.map(table => [table.name, table]));
  const rowsByType = new Map(tables.map(table => [table.name, records.filter(row => row.objectType === table.name)]));
  const identities = new Map();
  const add = (code, path, message) => { if (issues.length < 100) issues.push(problem(code, path, message)); };
  const preview = (kind, entry) => { result.counts[kind]++; if (result.previews[kind].length < 10) result.previews[kind].push(entry); };
  for (const rule of config.identities) {
    const table = schemas.get(rule.objectType); const rows = rowsByType.get(rule.objectType);
    const aliases = new Map(rule.aliases.map(pair => [key(pair.source), pair.target])); const targets = new Set();
    if (!rows.length) add('NO_SOURCE_ROWS', rule.objectType, '配置对象没有来源记录。');
    for (const row of rows) {
      const source = row.payload[table.primaryKey]; const target = aliases.size ? aliases.get(key(source)) : source;
      if (!scalar(source) || !scalar(target)) { add('IDENTITY_UNMAPPED', rule.objectType, '存在未明确映射的源主键。'); continue; }
      if (targets.has(key(target))) { add('IDENTITY_COLLISION', rule.objectType, '多条源记录被映射到同一统一标识。'); continue; }
      targets.add(key(target));
      const canonicalId = key([tenantId, rule.canonicalType, target]);
      identities.set(key([rule.objectType, source]), canonicalId);
      preview('identities', { objectType: rule.objectType, sourceSystem: table.system, sourceId: source, canonicalType: rule.canonicalType, canonicalId, granularity: rule.granularity });
    }
    if (rule.aliases.some(alias => !rows.some(row => key(row.payload[table.primaryKey]) === key(alias.source)))) add('UNOBSERVED_ALIAS', rule.objectType, '标识映射中存在本快照未观察到的源主键，需复核。');
  }
  for (const rule of config.identities) {
    const table = schemas.get(rule.objectType);
    for (const field of table.fields.filter(field => field.reference && config.identities.some(rule => rule.objectType === field.reference))) for (const row of rowsByType.get(table.name)) {
      if (row.payload[field.name] === undefined || row.payload[field.name] === null) continue;
      const from = identities.get(key([table.name, row.payload[table.primaryKey]])); const to = identities.get(key([field.reference, row.payload[field.name]]));
      if (!from || !to) { add('LINK_UNRESOLVED', `${table.name}.${field.name}`, '已声明外键缺少可确定的统一标识，不能建立链接。'); continue; }
      preview('links', { objectType: table.name, field: field.name, targetObject: field.reference, from, to, origin: 'declared_foreign_key' });
    }
  }
  const unitGroups = new Map();
  for (const rule of config.units) { const k = key([rule.objectType, rule.field]); if (!unitGroups.has(k)) unitGroups.set(k, []); unitGroups.get(k).push(rule); }
  for (const rules of unitGroups.values()) {
    const base = rules[0]; const table = schemas.get(base.objectType); const rows = rowsByType.get(base.objectType);
    if (!rows.length) add('NO_SOURCE_ROWS', base.objectType, '配置对象没有来源记录。');
    for (const row of rows) {
      const unit = base.unitField ? row.payload[base.unitField] : table.fields.find(field => field.name === base.field).unit;
      const rule = rules.find(rule => rule.sourceUnit === unit); const raw = row.payload[base.field];
      if (!rule || typeof raw !== 'number' || !Number.isFinite(raw)) { add('UNIT_UNMAPPED', `${base.objectType}.${base.field}`, '源单位或数值缺失映射；不能按零或默认单位计算。'); continue; }
      let factor = unitPairs.get(`${rule.sourceUnit}:${rule.targetUnit}`);
      if (rule.lookup) {
        const target = schemas.get(rule.lookup.objectType);
        const matches = rowsByType.get(target.name).filter(other => key(other.payload[target.primaryKey]) === key(row.payload[rule.lookup.viaField]));
        factor = matches.length === 1 ? matches[0].payload[rule.lookup.valueField] : null;
        if (!Number.isSafeInteger(factor) || factor < 1) { add('UNIT_FACTOR_UNRESOLVED', `${base.objectType}.${base.field}`, '包装系数缺失、冲突或不是正整数，不能进行箱件换算。'); continue; }
      }
      const value = raw * factor;
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) { add('UNIT_OVERFLOW', `${base.objectType}.${base.field}`, '换算超出安全数值范围。'); continue; }
      preview('units', { objectType: base.objectType, sourceId: row.payload[table.primaryKey], field: base.field, sourceValue: raw, sourceUnit: unit, targetUnit: rule.targetUnit, factor, value });
    }
  }
  for (const rule of config.states) {
    const table = schemas.get(rule.objectType); const values = new Map(rule.values.map(pair => [pair.source, pair.target])); const rows = rowsByType.get(rule.objectType);
    if (!rows.length) add('NO_SOURCE_ROWS', rule.objectType, '配置对象没有来源记录。');
    for (const row of rows) {
      const source = row.payload[rule.field];
      if (!values.has(source)) { add('STATE_UNMAPPED', `${rule.objectType}.${rule.field}`, '存在未配置或空状态；不猜测为正常、可用或已完成。'); continue; }
      preview('states', { objectType: rule.objectType, sourceId: row.payload[table.primaryKey], field: rule.field, source, target: values.get(source), evidenceKind: 'human_mapping_not_execution_receipt' });
    }
  }
  if (!issues.length) result.status = 'validated_scope';
  else result.previews = { identities: [], links: [], units: [], states: [] }; // No partial output represented as accepted.
  result.configuredObjects = [...new Set([...config.identities, ...config.units, ...config.states].map(rule => rule.objectType))];
  result.unconfiguredObjects = tables.filter(table => !result.configuredObjects.includes(table.name)).map(table => table.name);
  return result;
}
