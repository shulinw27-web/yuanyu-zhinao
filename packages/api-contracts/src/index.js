export const API_ERROR_CODES = Object.freeze({
  PAGE_PERMISSION_DENIED: 'PAGE_PERMISSION_DENIED',
  BUTTON_PERMISSION_DENIED: 'BUTTON_PERMISSION_DENIED',
  BUSINESS_ROLE_DENIED: 'BUSINESS_ROLE_DENIED',
  AGENT_ORIGIN_ROLE_DENIED: 'AGENT_ORIGIN_ROLE_DENIED',
  AGENT_CONVERSATION_NOT_FOUND: 'AGENT_CONVERSATION_NOT_FOUND',
  EVIDENCE_TRACE_NOT_FOUND: 'EVIDENCE_TRACE_NOT_FOUND',
  IDENTITY_ROLE_REVOKED: 'IDENTITY_ROLE_REVOKED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_REQUEST_BODY: 'INVALID_REQUEST_BODY'
});

export const AUTHORIZATION_REJECTION_CODES = Object.freeze([
  API_ERROR_CODES.PAGE_PERMISSION_DENIED,
  API_ERROR_CODES.BUTTON_PERMISSION_DENIED,
  API_ERROR_CODES.BUSINESS_ROLE_DENIED,
  API_ERROR_CODES.AGENT_ORIGIN_ROLE_DENIED,
  API_ERROR_CODES.FORBIDDEN,
  API_ERROR_CODES.IDENTITY_ROLE_REVOKED
]);

export const AGENT_RESPONSE_REQUIRED_FIELDS = Object.freeze(['text', 'agent', 'evidence', 'plan', 'command']);

const invalidBody = (message) => ({
  ok: false,
  error: { message, code: API_ERROR_CODES.INVALID_REQUEST_BODY }
});

export function normalizeAgentMessageBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalidBody('请求体必须是 JSON 对象。');
  if (body.input !== undefined && (!body.input || typeof body.input !== 'object' || Array.isArray(body.input))) {
    return invalidBody('input 必须是对象。');
  }
  const input = body.input
    ? { ...body.input }
    : { text: body.text, attachments: body.attachments, conversationId: body.conversationId };
  if (input.attachments !== undefined && !Array.isArray(input.attachments)) return invalidBody('attachments 必须是数组。');
  if (input.text !== undefined && typeof input.text !== 'string') return invalidBody('text 必须是字符串。');
  if (input.conversationId !== undefined && typeof input.conversationId !== 'string') return invalidBody('conversationId 必须是字符串。');
  return { ok: true, input };
}
