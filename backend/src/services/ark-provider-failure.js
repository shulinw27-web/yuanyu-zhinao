// Only a fixed provider code may cross this boundary. Never expose error messages,
// request identifiers, credentials or arbitrary upstream JSON to users/logs.
export async function arkFailureReason(response) {
  const fallback = `ark chat completions status ${response.status}`;
  if (response.status !== 403 || !response.body?.getReader) return fallback;
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) return fallback;
      chunks.push(value);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return payload?.error?.code === 'AccountOverdueError' ? 'ARK_ACCOUNT_OVERDUE' : fallback;
  } catch { return fallback; }
  finally { try { await reader.cancel(); } catch { /* error body is disposable */ } }
}

export const arkAccountOverdueMessage = '方舟返回账户欠费错误（AccountOverdueError），本轮无法调用模型。请管理员检查方舟账户余额与欠费状态后重试。';
