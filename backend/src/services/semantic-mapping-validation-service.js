import { createHash } from 'node:crypto';
import { getMockSystemRecords } from './mock-scenario-service.js';
import { admitSemanticRecord } from './semantic-record-contract-service.js';

const SAMPLE_LIMIT = 3;
const supportedMappingStatuses = new Set(['mapped', 'manual', 'derived', 'ignored', 'pending']);
const clone = (value) => JSON.parse(JSON.stringify(value));
const normalize = (value) => String(value ?? '').trim();

const valueAtPath = (value, path) => normalize(path).split('.').filter(Boolean).reduce((current, segment) =>
  !['__proto__', 'prototype', 'constructor'].includes(segment) && current && Object.hasOwn(current, segment) ? current[segment] : undefined, value);

const sourceSystemFor = (object) => normalize(object.sourceSystems?.[0] || object.source?.split('.')?.[0]).toUpperCase();

const typeMatches = (value, rawType, reference) => {
  if (value === undefined || value === null) return true;
  const type = normalize(rawType || 'string').toLowerCase();
  if (reference || type.startsWith('ref:')) return ['string', 'number', 'object'].includes(typeof value) && value !== null;
  if (type.startsWith('array:') || type === 'array') return Array.isArray(value);
  if (['number', 'float', 'double', 'decimal'].includes(type)) return typeof value === 'number' && Number.isFinite(value);
  if (['integer', 'int', 'long'].includes(type)) return Number.isInteger(value);
  if (['boolean', 'bool'].includes(type)) return typeof value === 'boolean';
  if (['object', 'json'].includes(type)) return typeof value === 'object' && value !== null && !Array.isArray(value);
  if (['date', 'date-time', 'datetime', 'timestamp'].includes(type)) return typeof value === 'string' && !Number.isNaN(Date.parse(value));
  if (type === 'string') return typeof value === 'string';
  return true;
};

const fieldDefinitionsFor = (object) => object.fieldDefinitions?.length
  ? object.fieldDefinitions
  : (object.fields || []).map((name) => ({
    name,
    type: 'string',
    required: name === object.key,
    primaryKey: name === object.key,
    sourceField: name,
    mappingStatus: 'mapped',
    reference: null
  }));

const issueCollector = () => {
  const values = new Map();
  return {
    add(issue) {
      const key = [issue.code, issue.objectId, issue.field || '', issue.message].join(':');
      const current = values.get(key);
      if (current) {
        current.occurrences += 1;
        if (issue.sampleId && current.sampleIds.length < 3 && !current.sampleIds.includes(issue.sampleId)) current.sampleIds.push(issue.sampleId);
        return;
      }
      values.set(key, { ...issue, occurrences: 1, sampleIds: issue.sampleId ? [issue.sampleId] : [] });
    },
    list() {
      return [...values.values()].map(({ sampleId: _sampleId, ...issue }) => issue);
    }
  };
};

export function buildSemanticMappingContract(draft) {
  const objects = (draft.objectTypes || []).map((object) => ({
    objectId: object.id,
    sourceSystem: sourceSystemFor(object),
    sourceObjectType: object.id,
    sourceRoot: 'payload',
    keyField: object.key,
    classification: object.classification,
    fields: fieldDefinitionsFor(object).map((field) => ({
      targetField: field.name,
      sourceField: field.sourceField || null,
      type: field.type || 'string',
      required: Boolean(field.required),
      primaryKey: Boolean(field.primaryKey || field.name === object.key),
      reference: field.reference || null,
      mappingStatus: supportedMappingStatuses.has(field.mappingStatus) ? field.mappingStatus : 'pending'
    }))
  }));
  const shape = { schemaVersion: 'semantic-mapping-contract.v1', objects };
  return {
    ...shape,
    contractId: `smc-${createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16)}`,
    sourceMode: 'stateful_mock_only'
  };
}

function validateSemanticMappingContractWithRecords(draft, options = {}, recordsBySystem = null) {
  const sampleLimit = Math.max(1, Math.min(Number(options.sampleLimit) || SAMPLE_LIMIT, 10));
  const contract = buildSemanticMappingContract(draft);
  if (options.governedSamples) contract.sourceMode = 'governed_sample_input';
  const issues = issueCollector();
  const objects = contract.objects.map((objectContract) => {
    const systemId = objectContract.sourceSystem.toLowerCase();
    const samples = objectContract.sourceSystem
      ? (recordsBySystem ? recordsBySystem.get(systemId) || [] : getMockSystemRecords(systemId)).filter((record) => record.objectType === objectContract.sourceObjectType).slice(0, sampleLimit)
      : [];
    const transformedSamples = [];
    const observedFields = new Set();
    const keyValues = new Set();
    let successfulSamples = 0;

    if (!objectContract.sourceSystem || objectContract.sourceSystem === 'UNASSIGNED') issues.add({ severity: 'error', code: 'SOURCE_SYSTEM_UNRESOLVED', objectId: objectContract.objectId, message: '来源系统未核实，不能通过映射验收。', suggestion: '指定实际来源并核实字段契约。' });
    for (const field of objectContract.fields.filter(item => item.mappingStatus === 'pending')) issues.add({ severity: 'error', code: 'MAPPING_PENDING', objectId: objectContract.objectId, field: field.targetField, message: `字段 ${field.targetField} 的映射尚未核实。`, suggestion: '在人工校对中补全来源、类型及映射后重新校验。' });

    if (!objectContract.sourceSystem) {
      issues.add({ severity: 'warning', code: 'SOURCE_SYSTEM_UNRESOLVED', objectId: objectContract.objectId, message: '对象未声明可用于样本演练的来源系统。', suggestion: '先在对象定义中选择受控来源系统。' });
    } else if (!samples.length) {
      issues.add({ severity: 'warning', code: options.governedSamples ? 'SCOPED_SAMPLE_UNAVAILABLE' : 'MOCK_SAMPLE_UNAVAILABLE', objectId: objectContract.objectId, message: `${objectContract.sourceSystem} 当前样本范围中没有 ${objectContract.sourceObjectType} 样本。`, suggestion: '补充脱敏样本或 Mock Fixture 后重新演练；当前对象不能视为已验证。' });
    }

    for (const sample of samples) {
      const canonicalFields = {};
      let sampleFailed = false;
      for (const field of objectContract.fields) {
        if (field.mappingStatus === 'ignored') {
          if (field.required || field.primaryKey) {
            sampleFailed = true;
            issues.add({ severity: 'error', code: 'REQUIRED_FIELD_IGNORED', objectId: objectContract.objectId, field: field.targetField, sampleId: sample.id, message: `必填字段 ${field.targetField} 不能被忽略。`, suggestion: '绑定稳定源字段，或取消必填约束。' });
          }
          continue;
        }
        if (field.mappingStatus === 'pending') {
          sampleFailed = true;
          issues.add({ severity: 'error', code: 'MAPPING_PENDING', objectId: objectContract.objectId, field: field.targetField, sampleId: sample.id, message: `字段 ${field.targetField} 的映射仍待确认。`, suggestion: '选择自动匹配、人工映射、派生或明确忽略。' });
          continue;
        }
        if (field.mappingStatus === 'derived') {
          if (options.governedSamples) sampleFailed = true;
          canonicalFields[field.targetField] = null;
          issues.add({ severity: 'warning', code: 'DERIVATION_NOT_EXECUTED', objectId: objectContract.objectId, field: field.targetField, sampleId: sample.id, message: `字段 ${field.targetField} 已声明为派生字段，但当前提案未定义可执行表达式。`, suggestion: '在生产接入前补充受控派生表达式和单元测试。' });
          continue;
        }
        // Supplied samples must obey the declared payload root. An envelope ID
        // must not silently substitute for a missing business primary key.
        const value = options.governedSamples ? valueAtPath(sample.payload, field.sourceField) : valueAtPath(sample.payload, field.sourceField) ?? valueAtPath(sample, field.sourceField);
        if (value === undefined || value === null || value === '') {
          if (field.required || field.primaryKey) {
            sampleFailed = true;
            issues.add({ severity: 'error', code: 'REQUIRED_SOURCE_VALUE_MISSING', objectId: objectContract.objectId, field: field.targetField, sampleId: sample.id, message: `必填字段 ${field.targetField} 在样本中未找到源值 ${field.sourceField}。`, suggestion: '修正源字段路径，或补充能证明该字段存在的脱敏样本。' });
          }
          canonicalFields[field.targetField] = null;
          continue;
        }
        observedFields.add(field.targetField);
        canonicalFields[field.targetField] = clone(value);
        if (!typeMatches(value, field.type, field.reference)) {
          sampleFailed = true;
          issues.add({ severity: 'error', code: 'SOURCE_TYPE_MISMATCH', objectId: objectContract.objectId, field: field.targetField, sampleId: sample.id, message: `字段 ${field.targetField} 的源值类型与 ${field.type} 不兼容。`, suggestion: '调整目标类型、源字段，或增加受控转换规则。' });
        }
      }
      const keyValue = canonicalFields[objectContract.keyField];
      if (keyValue !== undefined && keyValue !== null && keyValue !== '') {
        const signature = JSON.stringify(keyValue);
        if (keyValues.has(signature)) {
          sampleFailed = true;
          issues.add({ severity: 'error', code: 'DUPLICATE_PRIMARY_KEY', objectId: objectContract.objectId, field: objectContract.keyField, sampleId: sample.id, message: `主键 ${objectContract.keyField} 在样本中重复。`, suggestion: '确认业务主键或改用稳定复合键。' });
        }
        keyValues.add(signature);
      }
      if (!sampleFailed) successfulSamples += 1;
      transformedSamples.push({
        sourceRecordId: sample.id,
        sourceSystem: sample.system,
        canonicalFact: {
          id: keyValue === undefined || keyValue === null || keyValue === '' ? null : `${objectContract.objectId}:${String(keyValue)}`,
          type: objectContract.objectId,
          classification: objectContract.classification,
          fields: canonicalFields,
          source: { system: sample.system, recordId: sample.id, simulated: !options.governedSamples,
            ...(options.governedSamples ? { tenantId: sample.tenantId, organizationId: sample.organizationId, version: sample.version || sample.objectVersion || sample.etag, occurredAt: sample.occurredAt } : {}) }
        }
      });
    }

    const configuredFields = objectContract.fields.filter((field) => !['pending', 'ignored'].includes(field.mappingStatus)).length;
    const fieldCount = objectContract.fields.filter((field) => field.mappingStatus !== 'ignored').length;
    const status = !samples.length ? 'unverified' : successfulSamples === samples.length ? 'passed' : 'failed';
    return {
      objectId: objectContract.objectId,
      sourceSystem: objectContract.sourceSystem,
      sourceObjectType: objectContract.sourceObjectType,
      status,
      fieldCount,
      configuredFieldCount: configuredFields,
      observedFieldCount: observedFields.size,
      sampleCount: samples.length,
      successfulSampleCount: successfulSamples,
      transformedSamples
    };
  });

  const issueList = issues.list();
  const errorCount = issueList.filter((issue) => issue.severity === 'error').length;
  const warningCount = issueList.filter((issue) => issue.severity === 'warning').length;
  const totalFieldCount = objects.reduce((sum, object) => sum + object.fieldCount, 0);
  const observedFieldCount = objects.reduce((sum, object) => sum + object.observedFieldCount, 0);
  const sampleCount = objects.reduce((sum, object) => sum + object.sampleCount, 0);
  const successfulSampleCount = objects.reduce((sum, object) => sum + object.successfulSampleCount, 0);
  return {
    schemaVersion: 'semantic-mapping-validation.v1',
    contract,
    status: errorCount ? 'failed' : warningCount ? 'partially_verified' : 'passed',
    blocked: errorCount > 0 || Boolean(options.governedSamples && objects.some((object) => object.status !== 'passed')),
    checkedAt: new Date().toISOString(),
    summary: {
      objectCount: objects.length,
      verifiedObjectCount: objects.filter((object) => object.status === 'passed').length,
      sampleCount,
      successfulSampleCount,
      totalFieldCount,
      observedFieldCount,
      observedCoveragePercent: totalFieldCount ? Math.round((observedFieldCount / totalFieldCount) * 100) : 100,
      errorCount,
      warningCount
    },
    objects,
    issues: issueList,
    policy: options.governedSamples ? '仅验证调用方提供且通过身份、组织和版本准入的样本；不访问外部系统，不证明样本之外的全量数据或字段授权。生产适配器须先完成字段级脱敏。' : '仅使用服务端 WMS/ERP/MES/QMS 等状态化 Mock 记录进行只读转换演练；不读取真实企业数据，不把样本结果视为生产接入证明。'
  };
}

// Server-side adapter port. Never accept role/identity from an uploaded file.
// The caller supplies already field-redacted samples and authenticated scope.
export function validateGovernedSemanticSamples(draft, recordsBySystem, { roleId, identityScope, sampleLimit = 3 } = {}) {
  const reject = (code) => ({ schemaVersion: 'semantic-mapping-validation.v1', status: 'failed', blocked: true, code, objects: [], issues: [] });
  if (!identityScope?.tenantId || !identityScope?.subjectId || !roleId) return reject('MAPPING_IDENTITY_REQUIRED');
  if (!(recordsBySystem instanceof Map) || recordsBySystem.size > 16) return reject('MAPPING_SAMPLES_INVALID');
  const safeName = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
  const supportedType = (value) => /^(string|number|float|double|decimal|integer|int|long|boolean|bool|object|json|date|date-time|datetime|timestamp|array|array:(string|number|boolean)|ref:[A-Za-z][A-Za-z0-9_]*)$/i.test(value || 'string');
  if (!Array.isArray(draft?.objectTypes) || !draft.objectTypes.length || draft.objectTypes.length > 100) return reject('MAPPING_SCHEMA_INVALID');
  try {
    if (draft.objectTypes.some((object) => !safeName(object?.id) || !safeName(object.key)
      || !Array.isArray(object.fieldDefinitions) || !object.fieldDefinitions.length || object.fieldDefinitions.length > 200
      || object.fieldDefinitions.some((field) => !safeName(field?.name) || !supportedType(field.type)
        || (field.primaryKey && field.name !== object.key))
      || !object.fieldDefinitions.some((field) => field.name === object.key)
      || new Set(object.fieldDefinitions.map((field) => field.name)).size !== object.fieldDefinitions.length)
      || new Set(draft.objectTypes.map((object) => object.id)).size !== draft.objectTypes.length) return reject('MAPPING_SCHEMA_INVALID');
  } catch { return reject('MAPPING_SCHEMA_INVALID'); }
  const selected = new Map();
  let contract;
  try { contract = buildSemanticMappingContract(draft); } catch { return reject('MAPPING_SCHEMA_INVALID'); }
  const systems = new Set(contract.objects.map((item) => item.sourceSystem.toLowerCase()));
  for (const [system, records] of recordsBySystem) {
    if (!systems.has(system) || !Array.isArray(records) || records.length > 1000) return reject('MAPPING_SAMPLES_INVALID');
    // Reject the whole supplied batch instead of hiding a bad row and issuing
    // a passing mapping result for only its convenient subset.
    if (records.some((record) => typeof record?.system !== 'string' || record.system.toLowerCase() !== system || !admitSemanticRecord(record, roleId, identityScope, true))) return reject('MAPPING_SAMPLE_SCOPE_OR_VERSION_INVALID');
    selected.set(system, records);
  }
  const result = validateSemanticMappingContractWithRecords(draft, { sampleLimit, governedSamples: true }, selected);
  return { ...result, coverage: { scope: 'bounded_samples_only', providedRecords: [...selected.values()].reduce((count, rows) => count + rows.length, 0), testedRecords: result.summary.sampleCount, verifiesAllSourceData: false } };
}

export function validateSemanticMappingContract(draft, options = {}) {
  const systems = [...new Set(buildSemanticMappingContract(draft).objects.map((object) => object.sourceSystem.toLowerCase()).filter(Boolean))];
  const records = systems.map((systemId) => getMockSystemRecords(systemId));
  if (records.some((value) => value && typeof value.then === 'function')) {
    return Promise.all(records).then((resolved) => validateSemanticMappingContractWithRecords(
      draft,
      options,
      new Map(systems.map((systemId, index) => [systemId, resolved[index]]))
    ));
  }
  return validateSemanticMappingContractWithRecords(
    draft,
    options,
    new Map(systems.map((systemId, index) => [systemId, records[index]]))
  );
}
