const conversationOnly = (response) => response?.authorization?.decision === 'CONVERSATION_ONLY';
const denied = (response) => response?.authorization?.decision === 'DENY_BY_DEFAULT'
  || response?.promptSecurity?.status === 'rejected'
  || response?.lifecycle?.state === 'rejected';
const pendingHumanAction = (response) => Boolean(response?.command?.requiresConfirmation)
  || ['awaiting_confirmation', 'draft_created_pending_approval', 'needs_input', 'needs_memory_selection'].includes(response?.lifecycle?.state);

export function assessAgentAnswer(response = {}) {
  const evidence = Array.isArray(response.evidence) ? response.evidence : [];
  const isConversation = conversationOnly(response);
  const isDenied = denied(response);
  const hasBusinessRoute = Array.isArray(response.route) && response.route.some((item) => item?.id && item.id !== 'conversation');
  const incomplete = response?.lifecycle?.state === 'analysis_incomplete';
  const citationStatus = evidence.length ? 'grounded' : (isConversation || isDenied ? 'not_applicable' : 'missing');
  const confidenceBand = isDenied ? 'not_applicable'
    : incomplete ? 'low' : evidence.length >= 1 ? 'medium'
        : isConversation ? 'not_applicable' : 'low';
  const humanReviewRequired = incomplete || pendingHumanAction(response) || (hasBusinessRoute && evidence.length === 0);
  return Object.freeze({
    policyVersion: 'answer-governance.v2',
    assessmentScope: 'evidence_presence_not_answer_truth',
    citationStatus,
    evidenceCount: evidence.length,
    confidenceBand,
    uncertainty: confidenceBand === 'low' ? '缺少足够的受控业务证据，不应据此执行写操作。' : confidenceBand === 'medium' ? '证据引用数量不代表答案正确率；模型结论仍需核对来源、时间和业务目标。' : null,
    refusal: isDenied ? { active: true, reason: response?.authorization?.auditReason || '请求被安全或权限策略拒绝。' } : { active: false },
    humanReviewRequired,
    correctionPolicy: {
      channel: 'same_task_user_feedback',
      rule: '用户纠错只形成新版本反馈，不覆盖原始回答、证据或审计记录。'
    }
  });
}
