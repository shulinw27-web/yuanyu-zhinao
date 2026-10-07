// 系统物料服务（2026-10-07）：已登记系统的**物料补充 + 大模型理解**。
//
// 需求背景：系统接入成功之后也可以继续补充系统物料；补充的物料要交给大模型理解。
// 两项契约：
//   * supplementSystemMaterials —— 登记后（registered/authorized/connected/degraded）
//     追加文档物料与文字说明：文档走 8-5 同一受控解析管线（安全闸门 + 提取文本 + 取证），
//     提取文本追加进系统记录（schema 发现候选同步可见）；原文件不落地，边界与 5a 一致。
//   * getSystemUnderstanding —— 把登记物料 + 文档提取文本 + 补充说明 + 探测状态交给
//     大模型生成「系统理解」（概要 / 对象与职责 / 数据边界 / 接入目的 / 文档要点 / 风险缺口 /
//     建议下一步）。模型经 local-model-gateway（Mock 模式返回受控确定性摘要，不编造；
//     真实模型模式返回真实理解）。结果缓存按租户 + 系统码隔离，GET 读缓存、POST 重算。
//
// 大模型理解同时是「系统接入交给 agent 来做」的落地基础：理解结果 + 建议下一步
// 构成 agent 引导接入的事实面；登记提交与接通签字仍保持人工（ADR-023 纪律，
// 智脑不替人工做签字决策）。
import { randomUUID } from 'node:crypto';
import { readState, mutateState } from '../repositories/runtime-state-repository.js';
import { semanticTenantStateKey } from './semantic-tenant-context.js';
import { getTenantSystemDefinition, getTenantSystemConnection } from './system-registry-service.js';
import { getSystemDocumentTexts, appendSystemDocumentTexts, getSystemProbeResults } from './system-access-service.js';
import { generateModelSummary, getLocalModelRuntime } from './local-model-gateway.js';

const NAMESPACE = 'system_material_runtime';
const SUPPLEMENTS_KEY = 'supplements';
const UNDERSTANDING_KEY = 'understanding';
const MAX_SUPPLEMENTS_PER_CALL = 8;
const MAX_NOTE_LENGTH = 400;
const MAX_UNDERSTANDING_PROMPT_DOC_CHARS = 16_000;
const MAX_STORED_UNDERSTANDING_CHARS = 8_000;
// 允许补充物料的生命周期：登记后即可补充（含已接入与降级）；draft（未登记/已退回）不行。
const SUPPLEMENTABLE_STATES = new Set(['registered', 'authorized', 'connected', 'degraded']);

export const SYSTEM_MATERIALS_BOUNDARY = '系统物料：登记后可继续补充文档物料与文字说明（文档走与登记同一受控解析管线，只持久化提取文本与取证、原文件不落地）；大模型理解基于登记物料与提取文本生成，Mock 模式为受控确定性摘要（不编造），真实模型模式为真实理解；理解结果是 agent 引导接入的事实面，登记提交与接通签字仍需人工。';

const now = () => new Date().toISOString();
const readSupplements = () => readState(NAMESPACE, semanticTenantStateKey(SUPPLEMENTS_KEY), {});
const readUnderstanding = () => readState(NAMESPACE, semanticTenantStateKey(UNDERSTANDING_KEY), {});

/**
 * 补充系统物料（需求 2）：追加文档 + 文字说明。
 * 文档契约与登记物料一致（{ mimeType, dataUrl }，data:...;base64,...），每次最多 8 份。
 * 生命周期门禁：登记后（registered/authorized/connected/degraded）才可补充；
 * draft（未登记/已退回）拒绝。解析失败不阻塞补充（记录 warning 供披露，与登记一致）。
 */
export async function supplementSystemMaterials({ code, body, identityScope } = {}) {
  const actor = String(identityScope?.subjectId || identityScope?.tenantId || '').trim();
  if (!actor) return { error: '缺少操作主体，拒绝补充系统物料。', code: 'SYSTEM_ACTOR_REQUIRED', status: 400 };
  const normalized = String(code || '').toUpperCase();
  const definition = getTenantSystemDefinition(normalized);
  if (!definition) {
    return { error: `未登记的系统码：${code}`, code: 'SYSTEM_NOT_REGISTERED', status: 404 };
  }
  const connection = getTenantSystemConnection(normalized)?.lifecycleState || 'draft';
  if (!SUPPLEMENTABLE_STATES.has(connection)) {
    return {
      error: `系统 ${normalized} 当前处于「${connection}」状态，不能补充系统物料；请先完成登记（或重新登记）。`,
      code: 'SYSTEM_MATERIALS_SUPPLEMENT_STATE_REJECTED',
      status: 409
    };
  }
  if (!body || typeof body !== 'object') {
    return { error: '补充物料请求体必须是对象：{ attachmentDocuments?, note? }。', code: 'SYSTEM_MATERIALS_SUPPLEMENT_INPUT_INVALID', status: 400 };
  }

  const note = String(body.note ?? '').trim();
  if (note.length > MAX_NOTE_LENGTH) {
    return { error: `补充说明不能超过 ${MAX_NOTE_LENGTH} 字。`, code: 'SYSTEM_MATERIALS_SUPPLEMENT_INPUT_INVALID', status: 400 };
  }

  // 文档结构校验（与登记物料同契约）：{ mimeType, dataUrl }，data:...;base64,...
  const rawDocuments = body.attachmentDocuments === undefined || body.attachmentDocuments === null
    ? []
    : (Array.isArray(body.attachmentDocuments) ? body.attachmentDocuments : [body.attachmentDocuments]);
  const documents = [];
  const issues = [];
  for (const doc of rawDocuments) {
    if (!doc || typeof doc !== 'object') { issues.push('附加文档每份必须是 { mimeType, dataUrl } 对象。'); continue; }
    const mimeType = String(doc.mimeType ?? '').trim();
    const dataUrl = String(doc.dataUrl ?? '').trim();
    if (!mimeType || !dataUrl) { issues.push('附加文档每份必须含 mimeType 与 dataUrl。'); continue; }
    if (!dataUrl.startsWith('data:') || !dataUrl.includes(';base64,')) { issues.push('附加文档 dataUrl 必须是 data:...;base64,... 形式。'); continue; }
    documents.push({ mimeType, dataUrl });
  }
  if (documents.length > MAX_SUPPLEMENTS_PER_CALL) {
    issues.push(`每次补充最多 ${MAX_SUPPLEMENTS_PER_CALL} 份文档。`);
  }
  if (issues.length) {
    return { error: `补充物料校验未通过（${issues.length} 处）：${issues.join(' ')}`, code: 'SYSTEM_MATERIALS_SUPPLEMENT_INPUT_INVALID', issues, status: 400 };
  }
  if (!documents.length && !note) {
    return { error: '请至少提供一份文档或一段补充说明。', code: 'SYSTEM_MATERIALS_SUPPLEMENT_EMPTY', status: 400 };
  }

  // 8-5 同一受控解析管线：安全闸门 + 提取文本 + 取证；原文件不落地。
  const warnings = [];
  const extractedDocuments = [];
  for (const doc of documents) {
    try {
      const { inspectMultimodalInput, extractMultimodalEvidence } = await import('./multimodal-input-service.js');
      const attachment = { id: `sysdoc-supplement-${normalized}-${randomUUID()}`, mimeType: doc.mimeType, dataUrl: doc.dataUrl, name: `system-${normalized}-supplement` };
      const multimodal = inspectMultimodalInput({ attachments: [attachment] }, { id: 'system_material_supplement' });
      if (multimodal.error) { warnings.push(`文档安全闸门拒绝：${multimodal.error}`); continue; }
      const extraction = await extractMultimodalEvidence(multimodal.attachments);
      const report = extraction.reports?.[0] || {};
      if (report.status !== 'content_scanned') { warnings.push(`文档未通过受控内容检查：${report.reason || '未知原因'}`); continue; }
      const document = extraction.documents?.[0];
      if (!document?.text) { warnings.push('受控解析未产出可登记文本。'); continue; }
      extractedDocuments.push({ attachmentId: attachment.id, name: attachment.name, mimeType: doc.mimeType, text: document.text, extractedCharacters: document.text.length, securityScan: report.securityScan || null, dlpSignals: [...(report.dlpSignals || [])] });
    } catch (error) {
      warnings.push(`文档解析异常：${error.message}`);
    }
  }

  // 提取文本追加进系统记录（schema 发现候选同步可见）；补充说明与取证写入补充日志。
  let documentOutcome = null;
  if (extractedDocuments.length || warnings.length) {
    documentOutcome = appendSystemDocumentTexts(normalized, extractedDocuments, warnings);
  }
  const supplement = { id: `sys-supplement-${randomUUID()}`, code: normalized, at: now(), by: actor, note: note || null, documentCount: extractedDocuments.length, warnings: [...warnings] };
  mutateState(NAMESPACE, semanticTenantStateKey(SUPPLEMENTS_KEY), {}, (state) => {
    const list = state[normalized] || [];
    state[normalized] = [supplement, ...list].slice(0, 100);
    return { value: state };
  });
  // 新物料进入受控事实面后，旧的模型理解不再可信。这里必须按同一租户+系统码
  // 失效缓存；否则界面 GET 虽然可读，却会把补充前的摘要伪装成最新理解。
  mutateState(NAMESPACE, semanticTenantStateKey(UNDERSTANDING_KEY), {}, (state) => {
    delete state[normalized];
    return { value: state };
  });

  return {
    code: normalized,
    boundary: SYSTEM_MATERIALS_BOUNDARY,
    supplement,
    documentTexts: documentOutcome
      ? { total: documentOutcome.totalDocuments, added: documentOutcome.added }
      : { total: getSystemDocumentTexts(normalized).documents.length, added: 0 },
    understandingInvalidated: true,
    warnings: warnings.length ? warnings : undefined
  };
}

/**
 * 系统理解（需求 2）：把登记物料 + 文档提取文本 + 补充说明 + 探测状态交给大模型。
 * POST（regenerate）重算并缓存；GET 读缓存。
 */
export async function getSystemUnderstanding({ code, regenerate = false, identityScope } = {}) {
  const normalized = String(code || '').toUpperCase();
  const definition = getTenantSystemDefinition(normalized);
  if (!definition) {
    return { error: `未登记的系统码：${code}`, code: 'SYSTEM_NOT_REGISTERED', status: 404 };
  }
  const cached = readUnderstanding()[normalized] || null;
  if (!regenerate) {
    if (cached) return { code: normalized, boundary: SYSTEM_MATERIALS_BOUNDARY, understanding: cached, cached: true };
    return {
      code: normalized,
      boundary: SYSTEM_MATERIALS_BOUNDARY,
      understanding: null,
      cached: false,
      howToGenerate: '尚未生成系统理解；以 POST 同路径（可带 { regenerate: true }）触发大模型理解。'
    };
  }
  return regenerateSystemUnderstanding({ code: normalized, definition, identityScope });
}

async function regenerateSystemUnderstanding({ code, definition, identityScope }) {
  const materials = definition.custom || {};
  const documents = getSystemDocumentTexts(code);
  const supplements = (readSupplements()[code] || []).slice(0, 5);
  const probe = getSystemProbeResults().probes[code] || null;
  const runtime = getLocalModelRuntime();

  // 提示词：受控事实面（登记物料 + 文档提取文本截断 + 补充说明），文档文本只取提取文本。
  const docTexts = (documents.documents || []).map((doc, index) => `【文档 ${index + 1}｜${doc.mimeType}】${String(doc.text || '').slice(0, Math.floor(MAX_UNDERSTANDING_PROMPT_DOC_CHARS / Math.max(1, documents.documents.length)))}`).join('\n');
  const supplementNotes = supplements.filter((item) => item.note).map((item) => `- ${item.at}：${item.note}`).join('\n');
  const prompt = [
    '你是企业语义运营平台的系统接入分析助手。请基于以下受控事实，生成这份已接入系统的「系统理解」。只使用给出的事实，不要编造任何未给出的信息；事实不足的点请明确写「材料未覆盖」。',
    '',
    `## 系统登记物料（系统码 ${code}）`,
    `- 名称：${definition.name}`,
    `- 业务域：${materials.domain || '未登记'}`,
    `- 定位说明：${materials.description || '未登记'}`,
    `- 核心业务对象：${(materials.keyEntities || []).join('、') || '未登记'}`,
    `- 覆盖数据域：${(materials.dataDomains || []).join('、') || '未登记'}`,
    `- 接入目的：${materials.accessIntention || '未登记'}`,
    `- 业务责任人：${materials.businessOwner || '未登记'}`,
    `- 心跳接口：${materials.heartbeat?.endpoint || '未配置'}`,
    `- 授权方式：${materials.auth?.scheme || '未登记'}`,
    '',
    `## 最近探测状态`,
    probe ? `- 最近一次探测：${probe.status}（${probe.checkedAt}${probe.probeKind ? `，${probe.probeKind}` : ''}）` : '- 尚无探测记录',
    '',
    docTexts ? `## 已登记文档提取文本\n${docTexts}` : '## 已登记文档提取文本\n（无）',
    '',
    supplementNotes ? `## 补充说明\n${supplementNotes}` : '## 补充说明\n（无）',
    '',
    '## 输出要求',
    '请输出结构化 Markdown，包含以下小节：',
    '### 系统概要',
    '### 核心对象与职责',
    '### 数据边界与授权',
    '### 接入目的确认',
    '### 文档要点',
    '### 风险与缺口',
    '### 建议下一步'
  ].join('\n');

  const fallback = [
    `【受控摘要（Mock 模式，基于登记事实拼接，不编造）】`,
    `### 系统概要`,
    `${definition.name}（${code}）——${materials.description || '定位说明未登记'}。`,
    `### 核心对象与职责`,
    (materials.keyEntities || []).length ? `核心业务对象：${materials.keyEntities.join('、')}。` : '材料未覆盖。',
    `### 数据边界与授权`,
    `覆盖数据域：${(materials.dataDomains || []).join('、') || '未登记'}；授权方式：${materials.auth?.scheme || '未登记'}。`,
    `### 接入目的确认`,
    materials.accessIntention || '材料未覆盖。',
    `### 文档要点`,
    (documents.documents || []).length ? `已登记 ${documents.documents.length} 份文档提取文本，合计约 ${(documents.documents || []).reduce((total, doc) => total + (doc.extractedCharacters || 0), 0)} 字；详细要点需真实模型模式生成。` : '尚无已登记文档。',
    `### 风险与缺口`,
    documents.warnings?.length ? `文档解析存在 ${documents.warnings.length} 条告警，请查看文档提取取证。` : '材料未覆盖（Mock 模式不做推断）。',
    `### 建议下一步`,
    probe?.status === 'verified' ? '探测正常；可继续补充字典/样例物料并推进建模。' : '尚无 verified 探测；请先执行连通性测试。'
  ].join('\n');

  const result = await generateModelSummary({
    prompt,
    fallback,
    safetyIdentifier: 'system-understanding',
    timeoutMs: 45000
  });

  const sourceFacts = {
    materialsFields: ['name', 'domain', 'description', 'keyEntities', 'dataDomains', 'accessIntention', 'businessOwner', 'heartbeat', 'auth'].filter((key) => materials[key] !== undefined),
    documentCount: (documents.documents || []).length,
    documentCharacters: (documents.documents || []).reduce((total, doc) => total + (doc.extractedCharacters || 0), 0),
    supplementCount: supplements.length,
    lastProbeStatus: probe?.status || null
  };
  const understanding = {
    code,
    generatedAt: now(),
    generatedBy: String(identityScope?.subjectId || identityScope?.tenantId || '').trim() || 'unknown',
    modelMode: result.source || 'mock',
    modelRuntime: { mode: runtime?.mode || 'mock', model: runtime?.model || null },
    answer: String(result.text || result.answer || '').slice(0, MAX_STORED_UNDERSTANDING_CHARS),
    promptCharacters: prompt.length,
    sourceFacts
  };
  mutateState(NAMESPACE, semanticTenantStateKey(UNDERSTANDING_KEY), {}, (state) => {
    state[code] = understanding;
    return { value: state };
  });
  return { code, boundary: SYSTEM_MATERIALS_BOUNDARY, understanding, cached: false };
}
