export function semanticConnectionMessage(error) {
  if (error?.status >= 500 || error?.name === 'TypeError' || ['NETWORK_ERROR', 'TIMEOUT'].includes(error?.code)) return '后端服务暂不可用，请稍后重试。本地开发请确认 API 服务已启动，并检查 VITE_DEV_API_TARGET 指向的地址。';
  return error?.message || '身份恢复失败，请重新登录。';
}
// Authentication is authoritative; role display names must never gate a session.
export async function restoreSemanticSession({ client, finishAuthentication }) {
  try {
    const session = client.identitySessionId ? await client.identitySession() : await client.enterpriseSession();
    await finishAuthentication(session);
  } catch (error) {
    return { authenticated: false, roles: [], message: [401, 403].includes(error?.status) ? '' : semanticConnectionMessage(error) };
  }
  let roles = [];
  try { const result = await client.roles(); if (Array.isArray(result)) roles = result; } catch { /* Names are optional; never infer privileges from this catalog. */ }
  return { authenticated: true, roles, message: '' };
}
