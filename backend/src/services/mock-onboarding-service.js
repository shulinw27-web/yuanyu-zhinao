import { createHash, randomUUID } from 'node:crypto';
import { mockOnboardingScenarios as scenarios, mockOnboardingMaterialKinds as kinds, mockOnboardingLimits as limits, mockOnboardingBoundary as boundary, mockOnboardingDocumentMimeTypes as documentMimeTypes, mockOnboardingDocumentBoundary as documentBoundary } from '../data/mock-onboarding-catalog.js';
import { inspectMultimodalInput, extractMultimodalEvidence } from './multimodal-input-service.js';
import { getEffectiveAccess, hasButtonPermission } from './access-control-service.js';
import { runWithSemanticTenant } from './semantic-tenant-context.js';
import { semanticOperationsPrincipalKey } from './semantic-operations-identity.js';
import { readSemanticGovernanceState, mutateSemanticGovernanceState, mutateSemanticGovernanceStates } from './semantic-governance-store.js';
import { discoverSchemasFromAttachments } from './semantic-schema-discovery-service.js';
import { getIAMVersion, runWithIAMStoreContext } from './iam-store.js';
import { readMockOnboardingSource } from './mock-onboarding-source-service.js';
import { evaluateMockAlignment, validateMockAlignment } from './mock-onboarding-alignment.js';
import { validateMockAlignmentEvidence, mockAlignmentEvidenceSources } from './mock-onboarding-evidence.js';
import { mockOnboardingBasis } from './mock-onboarding-basis.js';
import { createSemanticOperationsProposal } from './semantic-operations-agent-service.js';
import { prepareOnboardingSemanticTask, getSemanticOperationsTask } from './semantic-operations-task-service.js';
import { getOAMetaModelDraft } from './meta-model-service.js';
import { semanticFingerprint } from './semantic-model-fingerprint.js';
import { executeOntologyReadPlan, requireOntologyObjectAccess } from './ontology-read-plan-service.js';
import { createMockOnboardingOntologyAdapter } from './mock-onboarding-ontology-adapter.js';
import { extendSemanticMaterials, discoverWorkspaceSchemas } from './semantic-material-workspace-service.js';

const NAMESPACE = 'mock_onboarding_v1';
const PERMISSION = 'meta_model.draft.save';
const fail = (code, error, status = 400) => ({ error, code, status });
const missingProject = () => fail('MOCK_ONBOARDING_NOT_FOUND', '未找到当前身份和角色可见的模拟接入项目。', 404);
const hash = text => createHash('sha256').update(text).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validLabel = (value, max = 120) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(value);
const materialBytes = project => Object.values(project.materials).reduce((sum, item) => sum + item.bytes, 0);
const faultModes = new Set(['none', 'rate_limited', 'timeout', 'malformed', 'cross_tenant', 'incomplete', 'schema_drift']);
const sourceMessages = Object.freeze({
  MOCK_SOURCE_RATE_LIMITED: '本地模拟源返回限流，请稍后重试。', MOCK_SOURCE_TIMEOUT: '本地模拟源读取超时，未接受不完整结果。',
  MOCK_SOURCE_MALFORMED: '本地模拟源响应格式无效。', MOCK_SOURCE_TENANT_MISMATCH: '本地模拟源返回了其他租户记录，已拒绝并清除预览。',
  MOCK_SOURCE_INCOMPLETE: '本地模拟源分页或完整性证明缺失，未接受部分结果。', MOCK_SOURCE_SCHEMA_DRIFT: '本地模拟源记录与上传字典不一致，请核对对象、字段类型、主外键及来源系统。',
  MOCK_SOURCE_CONTRACT_INVALID: '本地模拟源不符合受支持的只读协议。', MOCK_SOURCE_TRANSPORT_FAILED: '本地模拟源传输失败，请重试。',
  MOCK_SOURCE_SANDBOX_ONLY: '本地模拟源仅在非生产环境开放。', MOCK_SOURCE_BUSY: '本地模拟源并发数量已达上限，请稍后重试。',
  MOCK_SOURCE_FAILED: '本地模拟连接未完成，请检查合成材料后重试。'
});
const sourceIssue = code => { const safeCode = Object.hasOwn(sourceMessages, code) ? code : 'MOCK_SOURCE_FAILED'; return { code: safeCode, message: sourceMessages[safeCode] }; };
const materialRevision = project => project.materialRevision ?? project.revision;
const activeConnection = project => project.connection?.materialRevision === materialRevision(project) ? project.connection : null;
const revisionConflict = () => fail('MOCK_ONBOARDING_REVISION_CONFLICT', '项目已被更新，请重新读取项目后提交。', 409);
const sourceCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 2000 ? value : 0;
const attachmentKinds = new Set(['requirements', 'api', 'rules']);
const documentMime = new Set(documentMimeTypes);

// 阶段 5a：文档类材料登记。走与对话面同一套安全闸门（签名/嵌入文本检查、
// 内容级扫描、DLP、提示注入隔离），登记的只有提取文本与解析取证——原文件
// 不持久化；提取不完整或超限时整份拒绝，不做静默截断。
async function extractDocumentMaterial(attachment, roleId) {
  const multimodal = inspectMultimodalInput({ attachments: [attachment] }, { id: roleId });
  if (multimodal.error) return fail('MOCK_ONBOARDING_ATTACHMENT_INVALID', multimodal.error);
  const extraction = await extractMultimodalEvidence(multimodal.attachments);
  const report = extraction.reports[0] || {};
  if (report.status !== 'content_scanned') return fail('MOCK_ONBOARDING_ATTACHMENT_EXTRACT_FAILED', report.reason || '文档未通过受控内容检查，整份拒绝登记。');
  if (report.parserTruncated) return fail('MOCK_ONBOARDING_ATTACHMENT_EXTRACT_INCOMPLETE', '文档超出受控解析范围（PDF 最多 20 页、工作表最多 2000 行），请拆分后分批登记；不做静默截断。');
  if (report.partial || report.missingPages?.length) return fail('MOCK_ONBOARDING_ATTACHMENT_EXTRACT_INCOMPLETE', `文档存在未识别页面（${report.missingPages.join('、')}），内容不完整时整份拒绝登记；可启用企业 OCR 后重试。`);
  const document = extraction.documents?.[0];
  if (!document?.text) return fail('MOCK_ONBOARDING_ATTACHMENT_EXTRACT_FAILED', '受控解析未产出可登记文本，整份拒绝。');
  const [inspected] = multimodal.attachments;
  return { text: document.text, source: { form: 'document', mimeType: inspected.mimeType, attachmentName: inspected.name, attachmentBytes: inspected.size,
    pageCount: report.pageCount || 1, totalPages: report.totalPages || report.pageCount || 1, securityScan: report.securityScan || null, dlpSignals: [...(report.dlpSignals || [])], extractedCharacters: report.extractedCharacters ?? document.text.length } };
}

// identityScope comes exclusively from the authenticated request. Body identity,
// role and project-state fields never participate in scope or permission checks.
async function scoped(options, write, work) {
  if (process.env.NODE_ENV === 'production') return fail('MOCK_ONBOARDING_SANDBOX_ONLY', '模拟接入仅在非生产环境开放。', 403);
  const { identityScope: identity, role } = options;
  if (!validLabel(identity?.tenantId) || !validLabel(identity?.subjectId) || identity.tenantId !== identity.tenantId.trim() || identity.subjectId !== identity.subjectId.trim()) return fail('MOCK_ONBOARDING_IDENTITY_REQUIRED', '需要已验证的租户和用户身份。', 403);
  const roleId = typeof role === 'string' ? role : role?.id;
  try {
    const access = getEffectiveAccess(roleId, identity);
    if (!access.principalResolved || !access.roleIds.includes(roleId)) return fail('MOCK_ONBOARDING_ROLE_DENIED', '当前身份未获授此角色。', 403);
    if (!access.pagePermissionIds.includes('page.world.view')) return fail('MOCK_ONBOARDING_PAGE_DENIED', '当前身份没有元域智语页面访问权限。', 403);
    if (write && (!hasButtonPermission(roleId, PERMISSION) || !access.buttonPermissionIds.includes(PERMISSION))) return fail('MOCK_ONBOARDING_PERMISSION_DENIED', `需要 ${PERMISSION} 权限。`, 403);
    return await runWithSemanticTenant(identity, () => work({ owner: semanticOperationsPrincipalKey(identity), roleId, key: JSON.stringify(['principal-role-v1', identity.tenantId, identity.subjectId, roleId]) }));
  } catch (error) {
    if (error.status === 403) return fail(error.code || 'MOCK_ONBOARDING_SCOPE_DENIED', '身份与当前租户工作区不一致。', 403);
    throw error;
  }
}

function parseJson(material, label) {
  try { return { value: JSON.parse(material.text), issues: [] }; }
  catch { return { value: null, issues: [`${label}不是有效 JSON；请检查括号、引号和逗号。`] }; }
}

function validateDictionary(material) {
  if (!material) return { issues: [], schemas: [] };
  const parsed = parseJson(material, '数据字典');
  if (parsed.issues.length) return { ...parsed, schemas: [] };
  const document = parsed.value;
  const issues = [];
  if (!record(document) || !Array.isArray(document.tables) || !document.tables.length || document.tables.length > limits.tables) return { schemas: [], issues: [`数据字典仅支持 {tables:[...]} JSON，需提供 1–${limits.tables} 个表。`] };
  const names = new Set();
  for (const [index, table] of document.tables.entries()) {
    const label = `表 ${index + 1}`;
    if (!record(table) || !identifier(table.name) || !validLabel(table.system, 40) || !Array.isArray(table.fields) || !table.fields.length || table.fields.length > limits.fieldsPerTable) {
      issues.push(`${label}需提供英文 name、来源 system 以及 1–${limits.fieldsPerTable} 个 fields；表名和字段名仅支持字母开头的字母、数字、下划线。`); continue;
    }
    if (names.has(table.name)) issues.push(`${table.name} 表名重复。`);
    names.add(table.name);
    if (!identifier(table.primaryKey) || !table.fields.some(field => field?.name === table.primaryKey)) issues.push(`${table.name} 必须显式声明 primaryKey，且主键必须存在于 fields。`);
    else if (!['string', 'number', 'integer'].includes(table.fields.find(field => field?.name === table.primaryKey).type)) issues.push(`${table.name} 主键类型仅支持 string/number/integer。`);
    const fieldNames = new Set();
    for (const field of table.fields) {
      if (!record(field) || !identifier(field.name) || !['string', 'number', 'integer', 'boolean'].includes(field.type)) { issues.push(`${table.name} 字段需包含有效 name 和 type（string/number/integer/boolean）。`); continue; }
      if (fieldNames.has(field.name)) issues.push(`${table.name}.${field.name} 字段重复。`);
      fieldNames.add(field.name);
      if (field.required !== undefined && typeof field.required !== 'boolean') issues.push(`${table.name}.${field.name} required 必须为布尔值。`);
      if (field.reference !== undefined && !identifier(field.reference)) issues.push(`${table.name}.${field.name} reference 必须为目标表名。`);
      if (field.referenceField !== undefined && !identifier(field.referenceField)) issues.push(`${table.name}.${field.name} referenceField 必须为目标字段名。`);
      if (field.referenceField && !field.reference) issues.push(`${table.name}.${field.name} 指定 referenceField 时必须同时声明 reference。`);
    }
  }
  if (issues.length) return { issues, schemas: [] };
  // This parser is deterministic. Material text is data, never executable
  // instructions. The stored digest ties the extraction back to exact text.
  const discovery = discoverSchemasFromAttachments({ attachments: [{ id: material.digest, name: material.name, mimeType: 'application/json' }], reports: [{ attachmentId: material.digest, status: 'content_scanned', structuredSchemaCandidate: true }], documents: [{ attachmentId: material.digest, text: material.text }] });
  issues.push(...discovery.warnings);
  if (discovery.schemas.length !== document.tables.length) issues.push('表名标准化后冲突或未完整提取，请使用彼此不同的英文表名。');
  for (const table of document.tables) for (const field of table.fields.filter(item => item.reference)) {
    const target = document.tables.find(item => item.name === field.reference);
    const targetField = target?.fields.find(item => item.name === (field.referenceField || target.primaryKey));
    if (!target) issues.push(`${table.name}.${field.name} 外键目标表 ${field.reference} 不存在。`);
    else if (!targetField) issues.push(`${table.name}.${field.name} 外键目标字段不存在。`);
    else if ((field.referenceField || target.primaryKey) !== target.primaryKey) issues.push(`${table.name}.${field.name} 当前仅支持引用目标表主键。`);
    else if (targetField.type !== field.type) issues.push(`${table.name}.${field.name} 外键与目标主键类型不一致。`);
  }
  return { issues: [...new Set(issues)], schemas: discovery.schemas, tables: document.tables };
}

function validateSamples(material, dictionary) {
  if (!material) return [];
  const { value, issues } = parseJson(material, '合成样本');
  if (issues.length) return issues;
  if (!record(value) || !Array.isArray(value.records) || !value.records.length || value.records.length > limits.sampleRecords) return [`合成样本仅支持 {records:[{objectType,payload}]}，需提供 1–${limits.sampleRecords} 条记录。`];
  if (!dictionary.tables || dictionary.issues.length) return ['请先补充有效数据字典，再核对样本主键、字段类型与外键。'];
  const seen = new Map();
  const schemaByName = new Map(dictionary.tables.map(table => [table.name, table]));
  for (const [index, sample] of value.records.entries()) {
    const schema = schemaByName.get(sample?.objectType);
    if (!record(sample) || !schema || !record(sample.payload) || !Object.keys(sample.payload).length) { issues.push(`样本 ${index + 1} 需提供字典中的 objectType 和非空 payload 对象。`); continue; }
    const row = sample.payload;
    const keyValue = row[schema.primaryKey];
    if (keyValue === undefined || keyValue === null || (typeof keyValue === 'string' && !keyValue.trim())) issues.push(`样本 ${index + 1} 缺少主键 ${schema.primaryKey}。`);
    const signature = JSON.stringify([schema.name, keyValue]);
    if (seen.has(signature)) issues.push(`样本 ${index + 1} 的 ${schema.name} 主键重复。`);
    seen.set(signature, true);
    for (const key of Object.keys(row)) if (!schema.fields.some(field => field.name === key)) issues.push(`样本 ${index + 1} 含字典未声明字段 ${key}。`);
    for (const field of schema.fields) {
      const actual = row[field.name];
      if (actual === undefined || actual === null) { if (field.required || field.name === schema.primaryKey) issues.push(`样本 ${index + 1} 缺少必填字段 ${field.name}。`); continue; }
      const matches = field.type === 'integer' ? Number.isSafeInteger(actual) : field.type === 'number' ? typeof actual === 'number' && Number.isFinite(actual) : typeof actual === field.type;
      if (!matches) issues.push(`样本 ${index + 1} 字段 ${field.name} 类型应为 ${field.type}。`);
    }
  }
  for (const [index, sample] of value.records.entries()) {
    const schema = schemaByName.get(sample?.objectType);
    if (!schema || !record(sample?.payload)) continue;
    for (const field of schema.fields.filter(item => item.reference)) {
      const actual = sample.payload[field.name];
      if (actual !== undefined && actual !== null && !seen.has(JSON.stringify([field.reference, actual]))) issues.push(`样本 ${index + 1} 的外键 ${field.name} 缺少对应 ${field.reference} 样本。`);
    }
  }
  for (const table of dictionary.tables) if (!value.records.some(sample => sample?.objectType === table.name)) issues.push(`请至少提供一条 ${table.name} 的合成样本。`);
  return [...new Set(issues)];
}

function publicProject(project) {
  const dictionary = validateDictionary(project.materials.dictionary);
  const materials = kinds.filter(item => project.materials[item.kind]).map(({ kind }) => {
    const item = project.materials[kind];
    const issues = kind === 'dictionary' ? dictionary.issues : kind === 'samples' ? validateSamples(item, dictionary)
      : item.text.replace(/\s/gu, '').length < 24 ? ['描述至少需要 24 个非空白字符，请补充业务细节；简单确认不能视为材料就绪。'] : [];
    return { kind, name: item.name, bytes: item.bytes, digest: item.digest, issues, ...(item.source ? { source: structuredClone(item.source) } : {}) };
  });
  const missing = kinds.filter(item => !project.materials[item.kind]).map(({ kind, label, description }) => ({ kind, label, reason: `尚未提供${label}。${description}` }));
  const issues = materials.flatMap(item => item.issues.map(issue => `${kinds.find(kind => kind.kind === item.kind).label}：${issue}`));
  const completed = materials.filter(item => !item.issues.length).length;
  const ready = completed === kinds.length;
  const connection = activeConnection(project);
  const nextAction = project.handoff?.basis === mockOnboardingBasis(project) ? '已有待审阅建模任务，请转到 Agent 工作台校对；尚未发布或通过业务问答验收。'
    : connection?.status === 'verified' ? '本地 Mock 只读验证完成，可核对映射及材料引用后显式交接建模；尚未发布模型。'
    : connection?.status === 'failed' ? `模拟连接未通过：${connection.issue.message} 可修正材料或更换故障模式后重新验证。` : '材料已通过本地格式检查；可测试本地 Mock 只读连接，并由人工审阅业务语义与证据。';
  const alignment = { configured: Boolean(project.alignment?.config), status: project.alignment?.report?.status || (project.alignment?.config ? 'pending' : 'not_configured'), issueCount: project.alignment?.report?.issues.length || 0, evidenceStatus: project.alignment?.report?.materialEvidence?.status || 'not_checked' };
  return { id: project.id, name: project.name, scenarioId: project.scenarioId, revision: project.revision, mode: 'synthetic', createdAt: project.createdAt, updatedAt: project.updatedAt, materials, connection: connection ? structuredClone(connection) : null, alignment,
    handoff: project.handoff ? { taskId: project.handoff.taskId, proposalId: project.handoff.proposalId, createdAt: project.handoff.createdAt, current: project.handoff.basis === mockOnboardingBasis(project) } : null,
    readiness: { status: ready ? 'ready_for_review' : 'collecting', completed, total: kinds.length, missing, issues, nextAction: issues.length ? `修正材料：${issues[0]}` : missing.length ? `补充${missing[0].label}：${missing[0].reason}` : nextAction },
    milestones: [
      { id: 'scenario', label: '选择业务场景', status: 'complete', detail: scenarios.find(item => item.id === project.scenarioId).label },
      { id: 'materials', label: '收集接入材料', status: ready ? 'complete' : 'pending', detail: `${completed}/${kinds.length} 类材料通过本地检查` },
      { id: 'review', label: '人工审阅', status: ready ? 'ready' : 'pending', detail: '仅表示材料可供审阅，尚未审阅通过。' },
      { id: 'connection', label: '模拟系统连接', status: connection?.status === 'verified' ? 'complete' : 'pending', detail: connection?.status === 'verified' ? '已按上传字典验证本地 Mock 只读数据；不代表真实连接器验收。' : connection?.status === 'failed' ? connection.issue.message : '尚未验证本地 Mock 只读数据。' },
      { id: 'alignment', label: '业务对齐', status: alignment.status === 'validated_scope' ? 'ready' : 'pending', detail: alignment.status === 'validated_scope' ? '仅人工配置范围通过合成数据检查，业务依据仍待复核。' : alignment.status === 'needs_review' ? `有 ${alignment.issueCount} 项映射缺口或冲突；接口连接通过不代表业务对齐通过。` : '请在业务对齐编辑器配置标识、单位或状态规则，保存后重新测试模拟连接。' },
      { id: 'model', label: '语义模型与业务问答', status: 'pending', detail: project.handoff ? '已生成候选审阅任务；模型发布和业务问答仍未验收。' : '当前阶段未执行。' }
    ], boundary };
}

const owned = (project, scope) => project?.owner === scope.owner && project.roleId === scope.roleId;

export async function listMockOnboarding(options) {
  return scoped(options, false, async scope => {
    const index = await readSemanticGovernanceState(NAMESPACE, scope.key) || {};
    return { mode: 'synthetic', scenarios: structuredClone(scenarios), materialKinds: structuredClone(kinds), limits: { ...limits }, boundary, documentMimeTypes: structuredClone(documentMimeTypes), documentBoundary, projects: Object.values(index).filter(project => owned(project, scope)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicProject) };
  });
}

export async function createMockOnboardingProject(options) {
  return scoped(options, true, scope => {
    const { body } = options;
    if (!scenarios.some(item => item.id === body?.scenarioId)) return fail('MOCK_ONBOARDING_SCENARIO_INVALID', '请选择订单履约或批次异常场景。');
    if (!validLabel(body?.name, 100)) return fail('MOCK_ONBOARDING_NAME_INVALID', '项目名称需为 1–100 个字符的单行文本。');
    return mutateSemanticGovernanceState(NAMESPACE, scope.key, {}, index => {
      if (Object.keys(index).length >= limits.projectsPerPrincipalRole) return { commit: false, result: fail('MOCK_ONBOARDING_PROJECT_LIMIT', `当前身份和角色最多可创建 ${limits.projectsPerPrincipalRole} 个模拟项目。`, 413) };
      const timestamp = new Date().toISOString();
      const project = { id: `mock-onboarding-${randomUUID()}`, owner: scope.owner, roleId: scope.roleId, name: body.name.trim(), scenarioId: body.scenarioId, revision: 1, materialRevision: 1, mode: 'synthetic', createdAt: timestamp, updatedAt: timestamp, materials: {}, connection: null };
      index[project.id] = project;
      return { value: index, result: { project: publicProject(project) } };
    });
  });
}

export async function getMockOnboardingProject(options) {
  return scoped(options, false, async scope => {
    const index = await readSemanticGovernanceState(NAMESPACE, scope.key) || {};
    const project = index[options.id];
    return owned(project, scope) ? { project: publicProject(project) } : missingProject();
  });
}

export async function saveMockOnboardingMaterial(options) {
  return scoped(options, true, async scope => {
    const { body } = options;
    if (!kinds.some(item => item.kind === body?.kind)) return fail('MOCK_ONBOARDING_KIND_INVALID', '不支持的材料类型；仅支持 requirements/api/dictionary/samples/rules。');
    if (!Number.isSafeInteger(body?.expectedRevision) || body.expectedRevision < 1) return fail('MOCK_ONBOARDING_REVISION_REQUIRED', '请提供项目当前 expectedRevision。');
    if (!validLabel(body?.name, 160)) return fail('MOCK_ONBOARDING_MATERIAL_INVALID', '材料需要有效名称和非空纯文本，不接受二进制控制字符。');
    const attachment = record(body?.attachment) ? body.attachment : null;
    const rawText = typeof body?.text === 'string' ? body.text : null;
    if ((rawText !== null) === Boolean(attachment)) return fail('MOCK_ONBOARDING_MATERIAL_INVALID', '材料需提供非空纯文本或单个文档附件之一，二者不可同时提供。');
    let text = rawText;
    let source = null;
    if (attachment) {
      if (!attachmentKinds.has(body.kind)) return fail('MOCK_ONBOARDING_MATERIAL_FORM_UNSUPPORTED', '数据字典与合成样本仅接受 JSON 文本；文档附件仅支持业务需求、接口说明与业务规则。');
      const mimeType = String(attachment.mimeType || '').toLowerCase();
      if (/^(?:image|audio|video)\//u.test(mimeType)) return fail('MOCK_ONBOARDING_MATERIAL_FORM_UNSUPPORTED', '图片、音频与视频材料需要视觉/语音模型通道（阶段 5b），当前一律整份拒绝登记。');
      if (!documentMime.has(mimeType)) return fail('MOCK_ONBOARDING_MATERIAL_FORM_UNSUPPORTED', '文档附件仅支持 PDF、DOCX 与 XLSX；结构化 JSON 请用纯文本登记。');
      const extracted = await extractDocumentMaterial(attachment, scope.roleId);
      if (extracted.error) return extracted;
      text = extracted.text;
      source = extracted.source;
    } else if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return fail('MOCK_ONBOARDING_MATERIAL_INVALID', '材料需要有效名称和非空纯文本，不接受二进制控制字符。');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > limits.materialBytes) return fail('MOCK_ONBOARDING_MATERIAL_LIMIT', source ? '文档提取文本超过 64 KiB，请拆分文档后分批登记；不做静默截断。' : '单份材料不能超过 64 KiB UTF-8 文本。', 413);
    return mutateSemanticGovernanceState(NAMESPACE, scope.key, {}, index => {
      const project = index[options.id];
      if (!owned(project, scope)) return { commit: false, result: missingProject() };
      if (body.expectedRevision !== project.revision) return { commit: false, result: fail('MOCK_ONBOARDING_REVISION_CONFLICT', '项目已被更新，请重新读取项目后提交。', 409) };
      const delta = bytes - (project.materials[body.kind]?.bytes || 0);
      if (materialBytes(project) + delta > limits.projectBytes || Object.values(index).reduce((sum, item) => sum + materialBytes(item), 0) + delta > limits.principalRoleBytes) return { commit: false, result: fail('MOCK_ONBOARDING_TOTAL_LIMIT', '超过单项目 256 KiB 或当前身份角色 1 MiB 材料上限。', 413) };
      project.materials[body.kind] = { name: body.name.trim(), bytes, digest: hash(text), text, ...(source ? { source } : {}) };
      project.revision++; project.updatedAt = new Date().toISOString();
      project.materialRevision = project.revision; project.connection = null; delete project.preview;
      if (project.alignment) project.alignment.report = null;
      return { value: index, result: { project: publicProject(project) } };
    });
  });
}

function validateSource(source, dictionary, tenantId) {
  if (!record(source) || source.sourceKind !== 'local_mock_http' || source.protocol !== 'mock-onboarding-query.v1' || !validLabel(source.snapshotId, 160)
    || !Array.isArray(source.systems) || !source.systems.length || source.systems.length > limits.tables || !source.systems.every(system => validLabel(system, 40))
    || new Set(source.systems).size !== source.systems.length || !Number.isSafeInteger(source.requests) || source.requests < 1 || source.requests > 2000
    || !Number.isSafeInteger(source.pageCount) || source.pageCount < 1 || source.pageCount > source.requests
    || !Array.isArray(source.records) || !source.records.length || source.records.length > limits.sampleRecords) return sourceIssue('MOCK_SOURCE_CONTRACT_INVALID');
  if (source.records.some(row => !record(row) || row.tenantId !== tenantId)) return sourceIssue('MOCK_SOURCE_TENANT_MISMATCH');
  if (source.records.some(row => !source.systems.includes(row.system) || !dictionary.tables.some(table => table.name === row.objectType && table.system === row.system))
    || source.systems.some(system => !source.records.some(row => row.system === system))) return sourceIssue('MOCK_SOURCE_SCHEMA_DRIFT');
  const text = JSON.stringify({ records: source.records });
  if (Buffer.byteLength(text, 'utf8') > limits.sourceBytes) return sourceIssue('MOCK_SOURCE_CONTRACT_INVALID');
  return validateSamples({ text }, dictionary).length ? sourceIssue('MOCK_SOURCE_SCHEMA_DRIFT') : null;
}

function buildPreview(source, dictionary, revision) {
  // Store only the bounded payload preview, never the complete source envelope.
  const objects = dictionary.tables.map(table => {
    const rows = source.records.filter(row => row.objectType === table.name).map(row => row.payload);
    return { objectType: table.name, system: table.system, totalRows: rows.length,
      fields: table.fields.map(field => ({ name: field.name, type: field.type, required: Boolean(field.required), primaryKey: field.name === table.primaryKey,
        ...(field.reference ? { reference: field.reference, referenceField: field.referenceField || dictionary.tables.find(target => target.name === field.reference).primaryKey } : {}) })),
      rows: structuredClone(rows.slice(0, limits.previewRows)) };
  });
  return { revision, snapshotId: source.snapshotId, objects };
}

function evaluateProjectAlignment(project, tables, records, tenantId) {
  const result = evaluateMockAlignment({ config: project.alignment.config, tables, records, tenantId });
  const invalid = validateMockAlignmentEvidence(project.alignment.config, project.materials);
  const evidenceIssues = validateMockAlignmentEvidence(project.alignment.config, project.materials, { requireAll: true });
  result.materialEvidence = { status: evidenceIssues.length ? 'needs_review' : 'quotes_verified', issues: evidenceIssues,
    boundary: '仅核对当前材料版本与摘录存在，不证明摘录支持该规则，也不代表人工签核。' };
  if (invalid.length) {
    result.status = 'needs_review'; result.issues.push(...invalid);
    for (const key of Object.keys(result.previews)) result.previews[key] = [];
  }
  return result;
}

export async function testMockOnboardingConnection(options, { readSource = readMockOnboardingSource } = {}) {
  return scoped(options, true, () => runWithIAMStoreContext(() => scoped(options, true, async scope => {
    const { body } = options;
    if (!record(body) || Object.keys(body).some(key => !['expectedRevision', 'faultMode'].includes(key)) || !faultModes.has(body.faultMode)) return fail('MOCK_ONBOARDING_CONNECTION_INPUT_INVALID', '仅支持 expectedRevision 和固定 faultMode，不接受 URL、连接凭据或自定义故障参数。');
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) return fail('MOCK_ONBOARDING_REVISION_REQUIRED', '请提供项目当前 expectedRevision。');
    const index = await readSemanticGovernanceState(NAMESPACE, scope.key) || {};
    const project = index[options.id];
    if (!owned(project, scope)) return missingProject();
    if (project.revision !== body.expectedRevision) return revisionConflict();
    if (publicProject(project).readiness.status !== 'ready_for_review') return fail('MOCK_ONBOARDING_MATERIALS_NOT_READY', '五类材料全部通过本地检查后，才能测试模拟连接。', 409);
    const dictionary = validateDictionary(project.materials.dictionary);
    const readResult = await runWithIAMStoreContext(() => scoped(options, true, async () => {
      // Do not keep the permission snapshot from before the awaited project read.
      const authorizationVersion = getIAMVersion();
      let source = null; let issue; let requests; let pageCount;
      try {
        source = await readSource({ scenarioId: project.scenarioId, tenantId: options.identityScope.tenantId, projectId: project.id, faultMode: body.faultMode });
        requests = sourceCount(source?.requests); pageCount = sourceCount(source?.pageCount);
        issue = validateSource(source, dictionary, options.identityScope.tenantId);
      } catch (error) { issue = sourceIssue(error?.code); requests = sourceCount(error?.requests); pageCount = sourceCount(error?.pageCount); }
      return { authorizationVersion, source, issue, requests, pageCount };
    }), options.identityScope.tenantId);
    if (readResult.error) return readResult;
    const { authorizationVersion, source, issue, requests, pageCount } = readResult;
    // Refresh a PostgreSQL request snapshot as well as local IAM state after IO.
    // A late response may never overwrite materials or another connection result.
    return runWithIAMStoreContext(() => scoped(options, true, finalScope => {
      if (getIAMVersion() !== authorizationVersion) return fail('MOCK_ONBOARDING_AUTHORIZATION_CHANGED', '验证期间权限版本发生变化，请重新登录并重试。', 409);
      return mutateSemanticGovernanceState(NAMESPACE, finalScope.key, {}, current => {
        const latest = current[options.id];
        if (!owned(latest, finalScope)) return { commit: false, result: missingProject() };
        if (latest.revision !== body.expectedRevision) return { commit: false, result: revisionConflict() };
        const checkedAt = new Date().toISOString();
        latest.materialRevision = materialRevision(latest);
        latest.revision++; latest.updatedAt = checkedAt;
        latest.connection = { status: issue ? 'failed' : 'verified', sourceKind: 'local_mock_http', faultMode: body.faultMode, checkedAt,
          materialRevision: latest.materialRevision, systems: issue ? [] : [...source.systems], recordCount: issue ? 0 : source.records.length,
          pageCount, requests, issue };
        if (latest.alignment) latest.alignment.report = issue ? null : {
          ...evaluateProjectAlignment(latest, dictionary.tables, source.records, options.identityScope.tenantId),
          checkedAt, materialRevision: latest.materialRevision, revision: latest.revision, snapshotId: source.snapshotId
        };
        if (issue) delete latest.preview;
        else latest.preview = buildPreview(source, dictionary, latest.revision);
        return { value: current, result: { project: publicProject(latest) } };
      });
    }), options.identityScope.tenantId);
  }), options.identityScope.tenantId));
}

export async function getMockOnboardingPreview(options) {
  return scoped(options, false, async scope => {
    const index = await readSemanticGovernanceState(NAMESPACE, scope.key) || {};
    const project = index[options.id];
    if (!owned(project, scope)) return missingProject();
    if (activeConnection(project)?.status !== 'verified' || project.preview?.revision !== project.revision) return fail('MOCK_ONBOARDING_PREVIEW_UNAVAILABLE', '请先对当前材料完成模拟连接验证；材料修改或验证失败后旧预览不可使用。', 409);
    const objectType = options.objectType || project.preview.objects[0]?.objectType;
    const selected = project.preview.objects.find(item => item.objectType === objectType);
    if (!selected) return fail('MOCK_ONBOARDING_PREVIEW_OBJECT_NOT_FOUND', '当前已验证字典未包含此对象。', 404);
    return { projectId: project.id, revision: project.revision, sourceKind: 'local_mock_http', objectType: selected.objectType, system: selected.system,
      objects: project.preview.objects.map(({ objectType, system, totalRows }) => ({ objectType, system, totalRows })),
      fields: structuredClone(selected.fields), rows: structuredClone(selected.rows), totalRows: selected.totalRows, truncated: selected.totalRows > selected.rows.length };
  });
}

export async function getMockOnboardingAlignment(options) {
  return scoped(options, false, async scope => {
    const index = await readSemanticGovernanceState(NAMESPACE, scope.key) || {};
    const project = index[options.id];
      if (!owned(project, scope)) return missingProject();
      const dictionary = validateDictionary(project.materials.dictionary);
      const tables = dictionary.issues.length ? [] : (dictionary.tables || []).map(table => ({
        name: table.name, system: table.system, primaryKey: table.primaryKey, granularity: table.granularity,
        fields: table.fields.map(field => Object.fromEntries(['name', 'type', 'unit', 'reference', 'referenceField']
          .filter(key => field[key] !== undefined).map(key => [key, field[key]])))
      }));
      return { projectId: project.id, revision: project.revision, config: structuredClone(project.alignment?.config || null),
        tables, evidenceSources: mockAlignmentEvidenceSources(project.materials), report: structuredClone(project.alignment?.report || null), boundary: '人工业务对齐，仅测试配置范围；不生成模型或执行业务动作。' };
  });
}

export async function saveMockOnboardingAlignment(options) {
  return scoped(options, true, scope => {
    const { body } = options;
    if (!record(body) || Object.keys(body).some(key => !['expectedRevision', 'config'].includes(key)) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) return fail('MOCK_ALIGNMENT_INPUT_INVALID', '仅接受当前 expectedRevision 和 config。');
    return mutateSemanticGovernanceState(NAMESPACE, scope.key, {}, index => {
      const project = index[options.id];
      if (!owned(project, scope)) return { commit: false, result: missingProject() };
      if (project.revision !== body.expectedRevision) return { commit: false, result: revisionConflict() };
      const dictionary = validateDictionary(project.materials.dictionary);
      if (!dictionary.tables || dictionary.issues.length) return { commit: false, result: fail('MOCK_ALIGNMENT_DICTIONARY_REQUIRED', '请先提交有效字典，再配置业务对齐。', 409) };
      const issues = validateMockAlignment(body.config, dictionary.tables);
      if (issues.length) return { commit: false, result: fail('MOCK_ALIGNMENT_CONFIG_INVALID', `${issues[0].path}：${issues[0].message}`) };
      const evidenceIssues = validateMockAlignmentEvidence(body.config, project.materials);
      if (evidenceIssues.length) return { commit: false, result: fail(evidenceIssues[0].code, `${evidenceIssues[0].path}：${evidenceIssues[0].message}`) };
      project.alignment = { config: structuredClone(body.config), report: null };
      project.revision++; project.updatedAt = new Date().toISOString();
      // Configuration changes are not new material. They invalidate acceptance
      // and force a fresh full-source read rather than checking ten-row previews.
      project.connection = null; delete project.preview;
      return { value: index, result: { project: publicProject(project) } };
    });
  });
}

export async function handoffMockOnboardingModel(options, { readSource = readMockOnboardingSource } = {}) {
  return scoped(options, true, () => runWithIAMStoreContext(() => scoped(options, true, async scope => {
    const body = options.body;
    if (!record(body) || Object.keys(body).some(key => key !== 'expectedRevision') || !Number.isSafeInteger(body.expectedRevision)) return fail('MOCK_HANDOFF_INPUT_INVALID', '仅接受当前 expectedRevision；不接受模型、任务、租户或授权覆盖参数。');
    const index = await readSemanticGovernanceState(NAMESPACE, scope.key) || {};
    const project = index[options.id];
    if (!owned(project, scope)) return missingProject();
    if (project.revision !== body.expectedRevision) return revisionConflict();
    const basis = mockOnboardingBasis(project);
    if (project.handoff?.basis === basis) return { project: publicProject(project), taskId: project.handoff.taskId, proposalId: project.handoff.proposalId, reused: true };
    if (publicProject(project).readiness.status !== 'ready_for_review' || activeConnection(project)?.status !== 'verified'
      || project.alignment?.report?.status !== 'validated_scope') return fail('MOCK_HANDOFF_NOT_READY', '需先完成材料、连接及已配置业务对齐验证。', 409);
    const evidenceIssues = validateMockAlignmentEvidence(project.alignment.config, project.materials, { requireAll: true });
    if (evidenceIssues.length) return fail('MOCK_HANDOFF_EVIDENCE_REQUIRED', `${evidenceIssues[0].path}：${evidenceIssues[0].message}`, 409);
    const authorizationVersion = getIAMVersion();
    const dictionary = validateDictionary(project.materials.dictionary);
    let source;
    try { source = await readSource({ scenarioId: project.scenarioId, tenantId: options.identityScope.tenantId, projectId: project.id, faultMode: 'none' }); }
    catch (error) { return fail('MOCK_HANDOFF_SOURCE_FAILED', sourceIssue(error.code).message, 409); }
    const sourceError = validateSource(source, dictionary, options.identityScope.tenantId);
    if (sourceError) return fail(sourceError.code, sourceError.message, 409);
    const alignmentReport = evaluateProjectAlignment(project, dictionary.tables, source.records, options.identityScope.tenantId);
    if (alignmentReport.status !== 'validated_scope') return fail('MOCK_HANDOFF_ALIGNMENT_CHANGED', '新读取的完整快照未通过映射规则，请重新验证。', 409);
    const documents = Object.entries(project.materials).filter(([kind]) => kind !== 'samples').map(([kind, material]) => ({
      name: material.name, mimeType: material.source?.mimeType || (kind === 'dictionary' ? 'application/json' : 'text/plain'), text: material.text, kind
    }));
    documents.push({ name: 'handoff-synthetic-snapshot.json', kind: 'handoff_samples', mimeType: 'application/json', text: JSON.stringify({ records: source.records }) });
    const workspace = await extendSemanticMaterials({ content: { documents }, identityScope: options.identityScope, roleId: scope.roleId });
    if (workspace.error) return workspace;
    const discovery = discoverWorkspaceSchemas(workspace.documents, '根据模拟接入材料建立候选模型');
    const sampleRefs = workspace.documents.filter(document => document.kind === 'handoff_samples').map(document => document.attachmentId);
    const prepared = await createSemanticOperationsProposal({ input: `根据模拟接入项目“${project.name}”生成候选模型，待人工校对，不发布。`,
      schemaDiscovery: discovery, identityScope: options.identityScope, roleId: scope.roleId,
      requirements: documents.filter(document => ['requirements', 'rules'].includes(document.kind)).map(document => document.text).join('\n'),
      sampleRefs, prepareOnly: true });
    if (prepared.error) return prepared;
    const onboardingSource = { projectId: project.id, materialRevision: project.materialRevision, basisRevision: project.revision,
      snapshotId: source.snapshotId, sourceKind: 'local_mock_http', alignmentReport,
      boundary: '结构化材料生成候选；映射附件未编译为可执行业务规则，尚未采纳、发布或通过智脑问答验收。' };
    prepared.proposal.onboardingBasis = { key: scope.key, projectId: project.id, fingerprint: basis };
    const preparedTask = await prepareOnboardingSemanticTask({ id: `semantic-task-${randomUUID()}`, proposal: prepared.publicProposal,
      identityScope: options.identityScope, roleId: scope.roleId, onboardingSource });
    preparedTask.task.materialRefs = workspace.refs; preparedTask.task.materialIncomplete = false;
    return runWithIAMStoreContext(() => scoped(options, true, finalScope => {
      if (getIAMVersion() !== authorizationVersion) return fail('MOCK_ONBOARDING_AUTHORIZATION_CHANGED', '交接期间权限发生变化，请重新登录后重试。', 409);
      return mutateSemanticGovernanceStates([{ name: 'projects', namespace: NAMESPACE, key: finalScope.key, initialValue: {} }, prepared.entry, preparedTask.entry], values => {
        const latest = values.projects[project.id];
        if (!owned(latest, finalScope)) return { commit: false, result: missingProject() };
        if (latest.revision !== body.expectedRevision || mockOnboardingBasis(latest) !== basis) return { commit: false, result: revisionConflict() };
        if (values.proposal || values.tasks[preparedTask.task.id]) return { commit: false, result: revisionConflict() };
        latest.handoff = { basis, taskId: preparedTask.task.id, proposalId: prepared.proposal.id, createdAt: new Date().toISOString() };
        latest.revision++; latest.updatedAt = latest.handoff.createdAt;
        if (latest.preview) latest.preview.revision = latest.revision;
        if (latest.alignment.report) latest.alignment.report.revision = latest.revision;
        values.tasks[preparedTask.task.id] = preparedTask.task;
        return { values: { ...values, proposal: prepared.proposal }, result: { project: publicProject(latest), taskId: preparedTask.task.id, proposalId: prepared.proposal.id, reused: false } };
      });
    }), options.identityScope.tenantId);
  }), options.identityScope.tenantId));
}

async function readProjectCalculationContext(project, options) {
  const draft = await getOAMetaModelDraft();
  const task = project.handoff?.taskId ? await getSemanticOperationsTask({ taskId: project.handoff.taskId, identityScope: options.identityScope }) : null;
  const tableNames = new Set(validateDictionary(project.materials.dictionary).tables?.map(table => table.name) || []);
  const plans = (draft.scenario?.readPlans || []).filter(plan => Array.isArray(plan.datasets) && plan.datasets.length
    && plan.datasets.every(dataset => tableNames.has(dataset.objectType) && (!dataset.expand || tableNames.has(dataset.expand.edgeObjectType))));
  const blockers = [];
  if (!project.handoff || project.handoff.basis !== mockOnboardingBasis(project)) blockers.push('材料或连接已变化，请重新交接当前项目。');
  if (task?.status !== 'completed' || task?.command !== 'apply_proposal') blockers.push('请先在 Agent 中明确确认候选模型并采纳到草稿。');
  if (!plans.length) blockers.push('当前保存草稿没有覆盖此项目对象的读取方案，请到模型校对中配置并保存。');
  return { draft, plans, blockers, candidateFingerprint: semanticFingerprint(draft) };
}

export async function getMockOnboardingCalculations(options) {
  return scoped(options, true, async scope => {
    const project = (await readSemanticGovernanceState(NAMESPACE, scope.key) || {})[options.id];
    if (!owned(project, scope)) return missingProject();
    const context = await readProjectCalculationContext(project, options);
    return { projectId: project.id, revision: project.revision, candidateFingerprint: context.candidateFingerprint, blockers: context.blockers,
      plans: context.plans.map(plan => ({ id: plan.id, label: plan.label, rootObjectType: plan.datasets[0].objectType,
        outputs: plan.outputs.map(output => ({ id: output.id, label: output.label, unit: output.unit })) })),
      boundary: '只读草稿试算；没有发布、没有查询真实企业、没有执行业务动作，不能替代发布所需正反例回放。' };
  });
}

export async function previewMockOnboardingCalculation(options, { readSource = readMockOnboardingSource } = {}) {
  return scoped(options, true, () => runWithIAMStoreContext(() => scoped(options, true, async scope => {
    const body = options.body;
    if (!record(body) || Object.keys(body).some(key => !['expectedRevision', 'candidateFingerprint', 'planId', 'target'].includes(key))
      || !Number.isSafeInteger(body.expectedRevision) || !validLabel(body.target, 100) || !identifier(body.planId)
      || typeof body.candidateFingerprint !== 'string') return fail('MOCK_CALCULATION_INPUT_INVALID', '需要当前项目修订、草稿指纹、方案编号和明确业务编号，不接受权限或模型覆盖参数。');
    const project = (await readSemanticGovernanceState(NAMESPACE, scope.key) || {})[options.id];
    if (!owned(project, scope)) return missingProject();
    if (project.revision !== body.expectedRevision) return revisionConflict();
    const context = await readProjectCalculationContext(project, options);
    if (context.candidateFingerprint !== body.candidateFingerprint) return fail('MOCK_CALCULATION_DRAFT_STALE', '草稿已变化，请刷新方案后重新试算。', 409);
    if (context.blockers.length) return fail('MOCK_CALCULATION_NOT_READY', context.blockers.join(' '), 409);
    const plan = context.plans.find(item => item.id === body.planId);
    if (!plan) return fail('MOCK_CALCULATION_PLAN_UNKNOWN', '方案不属于当前项目的保存草稿。', 409);
    const authorizationVersion = getIAMVersion();
    try {
      for (const type of new Set(plan.datasets.flatMap(dataset => [dataset.objectType, ...(dataset.expand ? [dataset.expand.edgeObjectType] : [])]))) requireOntologyObjectAccess(context.draft, type, scope.roleId, options.identityScope);
    } catch { return fail('MOCK_CALCULATION_PERMISSION_DENIED', '方案所需对象尚未获得运行时授权或模型访问策略许可；上传材料不会授予权限。', 403); }
    const grantFingerprint = hash(process.env.ONTOLOGY_RUNTIME_GRANTS_JSON || '');
    let source;
    try { source = await readSource({ scenarioId: project.scenarioId, tenantId: options.identityScope.tenantId, projectId: project.id, faultMode: 'none' }); }
    catch (error) { return fail('MOCK_CALCULATION_SOURCE_FAILED', sourceIssue(error.code).message, 409); }
    const dictionary = validateDictionary(project.materials.dictionary);
    const issue = validateSource(source, dictionary, options.identityScope.tenantId);
    if (issue) return fail(issue.code, issue.message, 409);
    if (evaluateProjectAlignment(project, dictionary.tables, source.records, options.identityScope.tenantId).status !== 'validated_scope') return fail('MOCK_CALCULATION_ALIGNMENT_CHANGED', '当前完整快照不再满足已确认映射，请重新校对。', 409);
    let calculation;
    try {
      const adapter = createMockOnboardingOntologyAdapter({ source, draft: context.draft, scope: options.identityScope, roleId: scope.roleId });
      calculation = await executeOntologyReadPlan({ draft: context.draft, plan, target: body.target, roleId: scope.roleId, scope: options.identityScope, retrieve: adapter.retrieve });
    } catch { return fail('MOCK_CALCULATION_REJECTED', '试算未通过数据完整性、权限或方案前置条件检查；未生成业务结论。', 409); }
    return runWithIAMStoreContext(() => scoped(options, true, async finalScope => {
      if (getIAMVersion() !== authorizationVersion || grantFingerprint !== hash(process.env.ONTOLOGY_RUNTIME_GRANTS_JSON || '')) return fail('MOCK_ONBOARDING_AUTHORIZATION_CHANGED', '试算期间权限发生变化，结果已丢弃。', 409);
      const latest = (await readSemanticGovernanceState(NAMESPACE, finalScope.key) || {})[project.id];
      if (!owned(latest, finalScope)) return missingProject();
      if (latest.revision !== project.revision || mockOnboardingBasis(latest) !== mockOnboardingBasis(project)) return revisionConflict();
      if (semanticFingerprint(await getOAMetaModelDraft()) !== context.candidateFingerprint) return fail('MOCK_CALCULATION_DRAFT_STALE', '试算期间草稿已变更，结果已丢弃。', 409);
      return { projectId: project.id, revision: project.revision, candidateFingerprint: context.candidateFingerprint, planId: plan.id, target: body.target,
        status: 'calculated', mode: 'synthetic_draft_preview', snapshotId: source.snapshotId, calculatedAt: new Date().toISOString(),
        results: calculation.results, queries: calculation.queries, coverage: calculation.coverage, executionAuthorized: false, published: false,
        boundary: '本次为保存草稿与新读取合成快照的确定性试算，不是智脑问答、正式发布或业务执行，也不证明业务口径已获认可。' };
    }), options.identityScope.tenantId);
  }), options.identityScope.tenantId));
}
