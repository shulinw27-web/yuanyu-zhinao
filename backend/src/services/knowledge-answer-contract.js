import { assessPromptContent } from './prompt-security-service.js';

export const KNOWLEDGE_ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['claims', 'unknowns'],
  properties: {
    claims: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['text', 'sources'], properties: {
      text: { type: 'string', minLength: 1, maxLength: 1200 },
      sources: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['index', 'segment'], properties: {
        index: { type: 'integer', minimum: 1, maximum: 5 }, segment: { type: 'integer', minimum: 1, maximum: 128 }
      } } }
    } } },
    unknowns: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 1000 } }
  }
};

// Never return arbitrary model text, exception messages or provider bodies as diagnostics.
export function parseKnowledgeAnswer(text, catalog) {
  if (typeof text !== 'string' || text.length > 12000) return { stage: 'answer_size' };
  if (!assessPromptContent(text, { source: 'knowledge_answer', maxCharacters: 12000 }).safe) return { stage: 'content_safety', retryable: false };
  let answer;
  try { answer = JSON.parse(text); } catch { return { stage: 'answer_json' }; }
  if (!answer || Array.isArray(answer) || Object.keys(answer).some(key => !['claims', 'unknowns'].includes(key))
    || !Array.isArray(answer.claims) || answer.claims.length > 8 || !Array.isArray(answer.unknowns) || answer.unknowns.length > 8
    || answer.unknowns.some(item => typeof item !== 'string' || !item.trim() || item.length > 1000)
    || (!answer.claims.length && !answer.unknowns.length)) return { stage: 'answer_shape' };
  for (const claim of answer.claims) {
    if (!claim || Object.keys(claim).some(key => !['text', 'sources'].includes(key)) || typeof claim.text !== 'string' || !claim.text.trim() || claim.text.length > 1200
      || !Array.isArray(claim.sources) || !claim.sources.length || claim.sources.length > 5) return { stage: 'claim_shape' };
    for (const ref of claim.sources) {
      if (!ref || Object.keys(ref).some(key => !['index', 'segment'].includes(key)) || !Number.isInteger(ref.index) || ref.index < 1
        || !Number.isInteger(ref.segment) || ref.segment < 1 || !catalog[ref.index - 1]?.[ref.segment - 1]) return { stage: 'citation', retryable: false };
    }
  }
  return { answer };
}

export function knowledgeModelFailure(generated) {
  const stage = generated?.failureStage;
  if (['timeout', 'transport', 'upstream', 'response_json'].includes(stage)) return { stage, retryable: ['timeout', 'transport'].includes(stage) || stage === 'upstream' && [408, 429, 500, 502, 503, 504].includes(generated?.modelTiming?.httpStatus) };
  if (stage === 'configuration') return { stage, retryable: false };
  if (generated?.source === 'output_safety') {
    const signal = generated.safety?.signals?.length === 1 ? generated.safety.signals[0] : '';
    const recognized = ['invalid_structured_output', 'answer_contract_type_mismatch', 'structured_output_policy_violation', 'insufficient_business_answer', 'critical_fact_conflict', 'unauthorized_execution_claim', 'output_too_long', 'output_token_limit', 'secret_material', 'system_prompt_canary_leak', 'privilege_or_policy_bypass', 'unauthorized_tool_execution'].includes(signal);
    return { stage: recognized ? signal : 'output_safety', retryable: ['invalid_structured_output', 'answer_contract_type_mismatch'].includes(signal) };
  }
  return { stage: ['prompt_safety', 'model_governance', 'circuit_breaker'].includes(generated?.source) ? generated.source : 'provider_result', retryable: false };
}
