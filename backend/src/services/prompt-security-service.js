import { createHash } from 'node:crypto';

const MAX_PROMPT_CHARACTERS = 12_000;
const MAX_MODEL_OUTPUT_CHARACTERS = 8_000;
const ZERO_WIDTH_PATTERN = /[\u200B-\u200F\u2060\uFEFF]/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const SYSTEM_PROMPT_CANARY = 'ZHINAO_POLICY_CANARY_V1';

const threatRules = [
  {
    id: 'instruction_override',
    score: 100,
    reason: '尝试覆盖或忽略系统指令。',
    patterns: [
      /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|system|developer)\s+(?:instructions?|rules?|prompts?|messages?)\b/i,
      /\b(?:treat|consider|regard)\b.{0,24}\b(?:earlier|previous|prior)\b.{0,20}\b(?:instructions?|directions?|rules?|requirements?)\b.{0,20}\b(?:invalid|void|irrelevant)\b/i,
      /忽略(?:之前|前面|上述|所有|原有|系统|开发者).{0,16}(?:指令|规则|要求|提示词|消息)/i,
      /(?:无视|忽略|作废|不理会).{0,24}(?:前文|此前|之前|收到的|全部|所有).{0,16}(?:要求|规范|规则|指示|指令|方向)/i,
      /(?:覆盖|替换|重置).{0,12}(?:系统|开发者).{0,8}(?:指令|提示词|规则)/i
    ],
    compactPatterns: [
      /(?:ignore|disregard|forget)(?:all)?(?:previous|prior|above|system|developer)(?:instructions|rules|prompts|messages)/i,
      /忽略(?:之前|前面|上述|所有|原有|系统|开发者)?(?:的)?(?:指令|规则|要求|提示词|消息)/i,
      /(?:覆盖|替换|重置)(?:系统|开发者)(?:指令|提示词|规则)/i
    ]
  },
  {
    id: 'secret_or_prompt_exfiltration',
    score: 100,
    reason: '尝试获取系统提示词、开发者指令或敏感凭据。',
    patterns: [
      /\b(?:show|print|reveal|return|expose|leak|tell\s+me(?!\s+(?:what|how|why)))\b.{0,30}\b(?:system\s*prompt|developer\s*message|api\s*key|secret|access\s*token|credentials?)\b/i,
      /\b(?:dump|reproduce|recite|provide)\b.{0,24}\b(?:hidden|internal|system|developer)\b.{0,16}\b(?:policy|prompt|rules?|instructions?)\b/i,
      /(?:泄露|显示|输出|返回|给我|提取|告诉我(?!什么是|如何防止|为什么)).{0,24}(?:系统提示词|开发者指令|系统指令|密钥|令牌|凭据)/i,
      /(?:把|将)?(?:内部|隐藏|系统|开发者).{0,12}(?:规则|策略|规范|提示词|prompt|指令).{0,18}(?:逐字|原样|全文|全部)?(?:发给我|给我|展示|输出|打印|透露|泄露)/i
    ],
    compactPatterns: [
      /(?:show|print|reveal|return|expose|leak|tellme(?!what|how|why))(?:systemprompt|developermessage|apikey|secret|accesstoken|credentials)/i,
      /(?:泄露|显示|输出|返回|给我|提取|告诉我(?!什么是|如何防止|为什么))(?:系统提示词|开发者指令|系统指令|密钥|令牌|凭据)/i
    ]
  },
  {
    id: 'privilege_or_policy_bypass',
    score: 95,
    reason: '尝试绕过权限、审批或安全策略。',
    patterns: [
      /\b(?:please|try\s+to|must|now|silently)\b.{0,24}\b(?:bypass|disable|override|evade)\b.{0,24}\b(?:approval|authorization|permission|policy|guardrail|security)\b/i,
      /(?:(?:请|帮我)(?!检查|检测|审计|分析|说明|评估|防止|识别)|尝试|立即|直接|必须|设法|悄悄|我要|我想|如何(?!防止|检测|识别)).{0,18}(?:绕过|禁用|关闭|规避|跳过).{0,18}(?:权限|审批|安全|策略|护栏|审核)/i,
      /(?:无需|不要|不经过).{0,12}(?:权限|审批|审核).{0,16}(?:执行|创建|提交|写入|下单)/i
    ],
    compactPatterns: [/(?:(?:请|帮我)(?!检查|检测|审计|分析|说明|评估|防止|识别)|尝试|立即|直接|必须|设法|悄悄|我要|我想|如何(?!防止|检测|识别))(?:绕过|禁用|关闭|规避|跳过)(?:权限|审批|安全|策略|护栏|审核)/i]
  },
  {
    id: 'role_impersonation',
    score: 85,
    reason: '尝试通过提示词伪造高权限身份。',
    patterns: [
      /\b(?:act|pretend|behave)\s+as\b.{0,20}\b(?:admin|administrator|root|system|developer|superuser)\b/i,
      /(?:假装|冒充|切换为|充当|现在你是).{0,16}(?:管理员|超级用户|系统账号|开发者|root)/i
    ]
  },
  {
    id: 'unauthorized_tool_execution',
    score: 90,
    reason: '尝试诱导模型直接调用工具或执行未授权动作。',
    patterns: [
      /\b(?:call|invoke|execute|run)\b.{0,20}\b(?:tool|function|api|command)\b.{0,30}\b(?:without|bypass|ignore|secretly)\b/i,
      /(?<!不能)(?<!禁止)(?<!防止)(?<!避免)(?<!不得)(?:直接|立即|偷偷).{0,12}(?:调用工具|调用接口|执行命令|写入系统|删除数据).{0,16}(?:无需|不要|绕过|不经过)?/i
    ]
  },
  {
    id: 'persistent_instruction_pollution',
    score: 90,
    reason: '尝试把外部指令写入长期记忆或后续会话。',
    patterns: [
      /\b(?:remember|store|save|persist)\b.{0,24}\b(?:instruction|rule|prompt|command)\b.{0,30}\b(?:future|later|all\s+sessions?|permanent)\b/i,
      /(?:记住|保存|写入记忆|永久记录).{0,26}(?:以后|后续|所有会话|每次对话).{0,20}(?:指令|规则|要求|命令)/i
    ]
  },
  {
    id: 'sensitive_credential_material',
    score: 100,
    reason: '输入中包含疑似密钥、令牌或私钥材料。',
    patterns: [
      /\bsk-[A-Za-z0-9_-]{16,}\b/,
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/i,
      /\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret)\b["']?\s*[:=]\s*["']?[A-Za-z0-9._~-]{12,}\b/i
    ]
  }
];

const fuzzyTargets = ['ignore', 'previous', 'system', 'prompt', 'instructions', 'bypass', 'reveal', 'developer'];

const fingerprint = (value) => createHash('sha256').update(String(value || '')).digest('hex').slice(0, 20);

export function normalizeUntrustedText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(ZERO_WIDTH_PATTERN, '')
    .replace(CONTROL_CHARACTER_PATTERN, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

const compactText = (value) => value.toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '');
const tokenSignature = (token) => token.length < 4 ? token : `${token[0]}:${[...token.slice(1, -1)].sort().join('')}:${token.at(-1)}`;

const fuzzyThreatTokens = (value) => {
  const targets = new Map(fuzzyTargets.map((target) => [tokenSignature(target), target]));
  const matches = [];
  for (const token of value.toLowerCase().match(/[a-z]{5,}/g) || []) {
    const expected = targets.get(tokenSignature(token));
    if (expected && token !== expected) matches.push({ token, expected });
  }
  return matches;
};

const printableRatio = (value) => {
  if (!value) return 0;
  const printable = [...value].filter((character) => character === '\n' || character === '\t' || character >= ' ').length;
  return printable / [...value].length;
};

const decodeCodePoint = (value, radix) => {
  const codePoint = Number.parseInt(value, radix);
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : '';
};

const decodedPayloads = (value) => {
  const payloads = [];
  const base64Candidates = [...value.matchAll(/(?:^|[^A-Za-z0-9+/])([A-Za-z0-9+/]{24,}={0,2})(?=$|[^A-Za-z0-9+/=])/g)];
  for (const candidate of base64Candidates.slice(0, 4)) {
    const encoded = candidate[1];
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      if (!decoded.includes('\uFFFD') && printableRatio(decoded) > 0.85) payloads.push({ encoding: 'base64', value: decoded });
    } catch { /* Invalid encoded content is handled as ordinary text. */ }
  }
  const hexCandidates = value.match(/\b(?:[0-9a-fA-F]{2}){12,}\b/g) || [];
  for (const encoded of hexCandidates.slice(0, 4)) {
    try {
      const decoded = Buffer.from(encoded, 'hex').toString('utf8');
      if (!decoded.includes('\uFFFD') && printableRatio(decoded) > 0.85) payloads.push({ encoding: 'hex', value: decoded });
    } catch { /* Invalid encoded content is handled as ordinary text. */ }
  }
  if ((value.match(/%[0-9a-fA-F]{2}/g) || []).length >= 2) {
    const decoded = value.replace(/(?:%[0-9a-fA-F]{2})+/g, (segment) => {
      try { return decodeURIComponent(segment); } catch { return segment; }
    });
    payloads.push({ encoding: 'url', value: decoded });
  }
  if (/&#(?:x[0-9a-fA-F]+|\d+);/.test(value)) {
    const decoded = value
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => decodeCodePoint(hex, 16))
      .replace(/&#(\d+);/g, (_, decimal) => decodeCodePoint(decimal, 10));
    payloads.push({ encoding: 'html_entity', value: decoded });
  }
  if (/\\u[0-9a-fA-F]{4}/.test(value)) {
    const decoded = value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
    payloads.push({ encoding: 'unicode_escape', value: decoded });
  }
  if (/\\x[0-9a-fA-F]{2}/.test(value)) {
    const decoded = value.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
    payloads.push({ encoding: 'hex_escape', value: decoded });
  }
  return payloads;
};

const matchThreatRules = (value) => {
  const compact = compactText(value);
  return threatRules.filter((rule) =>
    rule.patterns.some((pattern) => pattern.test(value)) ||
    (rule.compactPatterns || []).some((pattern) => pattern.test(compact))
  );
};

const publicAssessment = ({ action, riskLevel, score, reason, signals, source, value }) => ({
  safe: action === 'allow',
  action,
  riskLevel,
  score,
  reason,
  signals: [...new Set(signals)],
  source,
  fingerprint: fingerprint(value)
});

export function assessPromptContent(value, { source = 'user_input', maxCharacters = MAX_PROMPT_CHARACTERS } = {}) {
  const raw = String(value || '');
  const normalized = normalizeUntrustedText(raw);
  const signals = [];
  let score = 0;
  let reason = '';

  if (raw.length > maxCharacters) {
    score = Math.max(score, 70);
    signals.push('input_too_long');
    reason ||= `内容超过 ${maxCharacters} 字符的安全处理上限。`;
  }
  if (ZERO_WIDTH_PATTERN.test(raw)) {
    ZERO_WIDTH_PATTERN.lastIndex = 0;
    score = Math.max(score, 35);
    signals.push('invisible_unicode');
  }
  ZERO_WIDTH_PATTERN.lastIndex = 0;
  if (CONTROL_CHARACTER_PATTERN.test(raw)) {
    CONTROL_CHARACTER_PATTERN.lastIndex = 0;
    score = Math.max(score, 35);
    signals.push('control_characters');
  }
  CONTROL_CHARACTER_PATTERN.lastIndex = 0;

  const matchedRules = matchThreatRules(normalized);
  for (const rule of matchedRules) {
    score = Math.max(score, rule.score);
    signals.push(rule.id);
    reason ||= rule.reason;
  }

  const fuzzyMatches = fuzzyThreatTokens(normalized);
  if (fuzzyMatches.length >= 2) {
    score = Math.max(score, 85);
    signals.push('fuzzy_obfuscation');
    reason ||= '检测到通过错拼词隐藏的高风险指令。';
  } else if (fuzzyMatches.length === 1) {
    score = Math.max(score, 30);
    signals.push('fuzzy_token');
  }

  const decodedQueue = decodedPayloads(normalized).map((payload) => ({ ...payload, depth: 1 }));
  const decodedFingerprints = new Set();
  while (decodedQueue.length) {
    const payload = decodedQueue.shift();
    const payloadFingerprint = fingerprint(payload.value);
    if (decodedFingerprints.has(payloadFingerprint)) continue;
    decodedFingerprints.add(payloadFingerprint);
    const decodedRules = matchThreatRules(normalizeUntrustedText(payload.value));
    if (decodedRules.length) {
      score = Math.max(score, 100);
      signals.push(`encoded_${payload.encoding}`, ...decodedRules.map((rule) => rule.id));
      reason ||= '检测到编码内容中隐藏的提示词注入指令。';
    } else {
      score = Math.max(score, 20);
      signals.push(`encoded_${payload.encoding}_content`);
      if (payload.depth < 3) {
        decodedQueue.push(...decodedPayloads(normalizeUntrustedText(payload.value)).map((nested) => ({
          ...nested,
          encoding: `${payload.encoding}_${nested.encoding}`,
          depth: payload.depth + 1
        })));
      }
    }
  }

  const action = score >= 70 ? 'deny' : score >= 40 ? 'review' : 'allow';
  const riskLevel = score >= 70 ? 'high' : score >= 40 ? 'medium' : score > 0 ? 'low' : 'none';
  return publicAssessment({
    action,
    riskLevel,
    score,
    reason: reason || (action === 'allow' ? '未发现提示词注入信号。' : '内容需要人工安全复核。'),
    signals,
    source,
    value: normalized
  });
}

export function partitionUntrustedContent(items = [], { source = 'retrieved_context', getText = (item) => item?.text || '', getId = (item, index) => item?.id || `${source}-${index}` } = {}) {
  const allowed = [];
  const quarantined = [];
  items.forEach((item, index) => {
    const assessment = assessPromptContent(getText(item), { source });
    if (assessment.safe) allowed.push(item);
    else quarantined.push({ id: getId(item, index), source, assessment });
  });
  return { allowed, quarantined, compromised: quarantined.length > 0 };
}

const sanitizeDisplayText = (value) => normalizeUntrustedText(value)
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '[已移除脚本内容]')
  .replace(/<[^>]{1,1000}>/g, '[已移除HTML]')
  .replace(/javascript\s*:/gi, '[已阻止的协议]:')
  .slice(0, MAX_MODEL_OUTPUT_CHARACTERS);

const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/i,
  /\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret)\b["']?\s*[:=]\s*["']?[A-Za-z0-9._~-]{12,}\b/i
];

const unauthorizedExecutionPatterns = [
  /(?:已经|已成功|现已).{0,16}(?:绕过|删除|停用|禁用).{0,16}(?:审批|权限|MES|ERP|OA|QMS|数据)/i,
  /(?:采购订单|正式订单|生产指令|放行指令).{0,12}(?:已创建|已提交|已下发|已执行)/i,
  /(?:ERP|MES|QMS|OA|OMS|LIMS)?.{0,8}(?:采购申请|采购订单|CAPA|质量调查|工作项|正式订单|生产指令|放行指令|客户记录|业务数据).{0,20}(?:已经|已|现已)(?:成功)?(?:生成|创建|提交|下发|执行|删除|清除|修改|写入|停用|禁用)/i,
  /(?:已经|已|现已)(?:成功|完成)?(?:执行|生成|创建|提交|下发|删除|清除|修改|写入|停用|禁用).{0,24}(?:ERP|MES|QMS|OA|OMS|LIMS|采购申请|采购订单|CAPA|质量调查|工作项|客户记录|业务数据|所有客户记录)/i,
  /\b(?:created|generated|submitted|executed|deleted|disabled|written)\b.{0,24}\b(?:purchase\s+(?:request|order)|capa|quality\s+investigation|customer\s+records?|business\s+data)\b/i,
  /\b(?:bypassed|deleted|disabled|executed)\b.{0,24}\b(?:approval|authorization|MES|ERP|QMS|production)\b/i
];

export function validateModelOutputSafety(value, { fallback = '模型输出未通过安全校验，已返回受控业务结果。' } = {}) {
  const raw = String(value || '');
  const sanitized = sanitizeDisplayText(raw);
  const assessment = assessPromptContent(sanitized, { source: 'model_output', maxCharacters: MAX_MODEL_OUTPUT_CHARACTERS });
  const signals = [...assessment.signals];
  if (raw.includes(SYSTEM_PROMPT_CANARY)) signals.push('system_prompt_canary_leak');
  if (secretPatterns.some((pattern) => pattern.test(raw))) signals.push('secret_material');
  const claimsExecution = unauthorizedExecutionPatterns.some((pattern) => pattern.test(sanitized));
  if (claimsExecution) signals.push('unauthorized_execution_claim');
  if (raw.length > MAX_MODEL_OUTPUT_CHARACTERS) signals.push('output_too_long');

  const blocked = !assessment.safe || signals.some((signal) => ['system_prompt_canary_leak', 'secret_material', 'unauthorized_execution_claim', 'output_too_long'].includes(signal));
  const answer = blocked ? sanitizeDisplayText(fallback) : sanitized;
  return {
    safe: !blocked,
    text: answer,
    reason: blocked ? '模型输出包含指令覆盖、敏感信息、越权执行声明或超长内容。' : '模型输出已通过安全校验。',
    signals: [...new Set(signals)],
    envelope: {
      schemaVersion: 'agent-summary.v1',
      answer,
      proposedAction: null,
      claimsExecution: false,
      executionReceipt: null,
      rejectedClaimsExecution: claimsExecution,
      validationStatus: blocked ? 'replaced_with_fallback' : 'validated'
    }
  };
}

export function createMemoryDecision(input, { source = 'user_input' } = {}) {
  const assessment = assessPromptContent(input, { source });
  return assessment.safe
    ? { status: 'audit_only', reusable: false, assessment, summary: normalizeUntrustedText(input).slice(0, 120) }
    : { status: 'quarantined', reusable: false, assessment, summary: `[高风险输入已隔离 · ${assessment.fingerprint}]` };
}

export { SYSTEM_PROMPT_CANARY };
