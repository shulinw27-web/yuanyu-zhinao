// 心跳探测凭据解析（ADR-028）：
//
// 按 auth.scheme 决定智脑如何获得访问目标系统的凭据：
//   * user_token_passthrough —— 智脑不持有凭据，由 executeHeartbeatProbe 直接转发当前用户身份。
//     本解析器不参与（executeHeartbeatProbe 已处理），只对 service_principal 路径生效。
//   * service_principal —— 智脑持有服务主体凭据（client_credentials），凭据存 Key Center。
//     本解析器读 Key Center 里 connectorId=`custom-{code}` 的凭据策略，签发一个轻量 opaque token。
//
// 边界（不得在界面或文档中弱化）：
//   * 本解析器只做心跳探测的凭据解析，不做业务接口调用的凭据签发——后者属真实企业连接器阶段，
//     需完整的 authorization + role + purpose + taskId + workflow 校验（见 key-center-service.js）。
//   * 真实 KMS 适配器对接（kms:// 协议解析）属触发式复审；本阶段默认实现返回 opaque handle 占位，
//     标注 source='tenant_registration'，不暴露凭据明文。
//   * 凭据永不进登记物料，只存 credentialRef（Key Center 引用）。

import { getCustomSystemCredentialPolicy } from './key-center/key-center-service.js';

/**
 * 解析心跳探测所需凭据。
 * @param {object} params
 * @param {string} params.credentialRef - kms:// 引用（登记物料 auth.credentialRef）
 * @param {string[]} params.scope - 声明的访问范围
 * @param {object} params.identityScope - 受信上下文（含 tenantId / subjectId）
 * @param {object} params.definition - 系统定义（含 code / id / auth）
 * @returns {Promise<{ authorizationHeader?: string, error?: string, source?: string }>}
 */
export async function resolveHeartbeatCredential({ credentialRef, scope, identityScope, definition } = {}) {
  if (!credentialRef) {
    return { error: 'service_principal 方式缺少 credentialRef，无法解析凭据。' };
  }
  const connectorId = definition?.id || `custom-${String(definition?.code || '').toLowerCase()}`;
  const policy = getCustomSystemCredentialPolicy(connectorId);
  if (!policy) {
    return { error: `Key Center 未找到 ${connectorId} 的凭据策略；请先在登记时配置 auth.credentialRef 并由管理员签发凭据。` };
  }
  if (policy.secretRef !== credentialRef) {
    return { error: `凭据引用不匹配：登记物料 credentialRef=${credentialRef}，Key Center 策略 secretRef=${policy.secretRef}。` };
  }
  // 轻量 opaque token：不真正调 KMS 适配器（真实 KMS 对接属触发式复审）。
  // 返回一个有界 opaque handle，标注 source 与 scope，供心跳请求 Authorization 头使用。
  // 心跳只验证连通性，不需要凭据明文——目标系统应自己校验 opaque handle。
  const handle = `hb-${Buffer.from(`${connectorId}:${policy.id}:${(identityScope?.tenantId || 'anon')}`).toString('base64').slice(0, 24)}`;
  return {
    authorizationHeader: `Bearer ${handle}`,
    source: 'tenant_registration',
    scope: scope || policy.operations || []
  };
}
