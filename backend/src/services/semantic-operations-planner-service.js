import { createHash } from 'node:crypto';
import { generateModelSummary, getLocalModelRuntime } from './local-model-gateway.js';
import { detectRequestedSemanticSystems } from './semantic-source-discovery-service.js';

const allowedIntents = new Set(['build_model', 'discover_sources', 'inspect_status', 'validate_model', 'simulate_model', 'publish_model']);
const allowedSystems = new Set(['OA', 'ERP', 'WMS', 'MES', 'LIMS', 'QMS', 'OMS', 'SRM', 'MDM', 'PLM', 'EAM', 'IOT']);
const normalize = (value, length = 800) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length);

const deterministicPlan = ({ request, authoritativeIntent }) => ({
  schemaVersion: 'semantic-operations-plan.v1',
  intent: authoritativeIntent,
  goal: normalize(request, 300),
  systems: detectRequestedSemanticSystems(request),
  rationale: '根据服务器受控意图规则和已登记系统词汇生成基础规划。',
  questions: []
});

const validateAdvice = (value) => {
  const keys = new Set(['schemaVersion', 'intent', 'goal', 'systems', 'rationale', 'questions']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.has(key))) return null;
  if (value.schemaVersion !== 'semantic-operations-plan.v1' || !allowedIntents.has(value.intent)) return null;
  if (typeof value.goal !== 'string' || typeof value.rationale !== 'string' || !Array.isArray(value.systems) || !Array.isArray(value.questions)) return null;
  return {
    schemaVersion: value.schemaVersion,
    intent: value.intent,
    goal: normalize(value.goal, 300),
    systems: [...new Set(value.systems.map((item) => String(item).toUpperCase()).filter((item) => allowedSystems.has(item)))].slice(0, 8),
    rationale: normalize(value.rationale, 500),
    questions: value.questions.map((item) => normalize(item, 180)).filter(Boolean).slice(0, 3)
  };
};

const parseAdvice = (text) => {
  try { return validateAdvice(JSON.parse(text)); } catch { return null; }
};

export function resolveSemanticOperationsPlanSystems({ authoritativeIntent, requestedSystems = [], discoveredSystems = [], suggestedSystems = [] }) {
  const sourceBoundIntent = ['build_model', 'discover_sources'].includes(authoritativeIntent);
  const permittedSystems = sourceBoundIntent && discoveredSystems.length ? discoveredSystems : requestedSystems;
  return {
    systems: permittedSystems,
    systemConflict: suggestedSystems.some((item) => !permittedSystems.includes(item))
  };
}

export async function planSemanticOperationsRequest({ request, authoritativeIntent, sourceDiscovery, identityScope }) {
  const fallback = deterministicPlan({ request, authoritativeIntent });
  const runtime = getLocalModelRuntime();
  if (runtime.mode === 'mock') return {
    mode: 'deterministic', provider: 'server_rules', model: runtime.model,
    authoritativeIntent, suggestedIntent: fallback.intent, intentConflict: false,
    goal: fallback.goal, systems: fallback.systems, rationale: fallback.rationale, questions: fallback.questions,
    policy: '模型规划只提供建议；最终命令、权限和是否需要确认始终由服务器确定。'
  };

  const sourceCodes = (sourceDiscovery?.sources || []).map((item) => `${item.code}:${item.status}`).join('、') || '无已选来源';
  const prompt = `请为语义层运营诉求生成结构化规划建议。服务器已识别意图为 ${authoritativeIntent}，可用来源状态为 ${sourceCodes}。\n运营诉求：${normalize(request, 4000)}\nanswer 是一个 JSON 字符串，严格使用以下结构：{"schemaVersion":"semantic-operations-plan.v1","intent":"build_model|discover_sources|inspect_status|validate_model|simulate_model|publish_model","goal":"目标","systems":["ERP"],"rationale":"依据","questions":["最多三个必要澄清问题"]}。`;
  const generated = await generateModelSummary({
    prompt,
    timeoutMs: 10_000,
    fallback: JSON.stringify(fallback),
    safetyIdentifier: `semantic-operations-${createHash('sha256').update(`${identityScope?.tenantId || 'demo'}:${identityScope?.subjectId || 'anonymous'}`).digest('hex').slice(0, 16)}`
  });
  const advice = ['local', 'openai', 'deepseek', 'compatible', 'ark'].includes(generated.source) ? parseAdvice(generated.text) : null;
  const selected = advice || fallback;
  const authoritativeSystems = (sourceDiscovery?.sources || []).map((item) => item.code).filter((item) => allowedSystems.has(item));
  const { systems: permittedSystems, systemConflict } = resolveSemanticOperationsPlanSystems({ authoritativeIntent, requestedSystems: fallback.systems, discoveredSystems: authoritativeSystems, suggestedSystems: selected.systems || [] });
  return {
    mode: advice ? generated.source === 'local' ? 'local_model_advisory' : 'external_model_advisory' : 'deterministic_fallback',
    provider: generated.source,
    model: runtime.model,
    authoritativeIntent,
    suggestedIntent: selected.intent,
    intentConflict: selected.intent !== authoritativeIntent,
    goal: selected.intent === authoritativeIntent ? selected.goal || fallback.goal : fallback.goal,
    systems: permittedSystems,
    systemConflict,
    rationale: selected.rationale || fallback.rationale,
    questions: selected.questions || [],
    warning: advice ? generated.warning || null : generated.warning || '模型未返回有效的 semantic-operations-plan.v1，已使用确定性规划。',
    policy: '模型规划只提供建议；最终命令、权限和是否需要确认始终由服务器确定。'
  };
}
