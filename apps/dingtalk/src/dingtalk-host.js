export const isDingTalkHost = (userAgent = '') => /DingTalk/i.test(userAgent);
export const dingTalkPlatform = (userAgent = '') => /Android|iPhone|iPad|Mobile/i.test(userAgent) ? 'dingtalk-mobile' : 'dingtalk-pc';
export const workbenchLayout = (width) => width <= 900 ? 'mobile' : 'desktop';

// UA detection is only a UX hint; the server always verifies the one-use code.
export async function authenticateDingTalk({ client, sdk, userAgent = globalThis.navigator?.userAgent || '', timeoutMs = 15000 }) {
  if (!isDingTalkHost(userAgent)) throw new Error('请从手机或电脑钉钉的企业工作台打开此应用，普通浏览器不能钉钉免登。');
  const config = await client.dingTalkConnection();
  if (!config.configured) throw new Error('企业尚未完成钉钉接入配置，请联系管理员。');
  const { challengeId } = await client.dingTalkChallenge();
  const code = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('钉钉授权超时，请检查网络后重试。')), timeoutMs);
    try {
      sdk.ready(() => {
        if (settled) return;
        try {
          // Official H5 internal-app flow; no dd.config signature is required
          // for runtime.permission.requestAuthCode itself.
          sdk.runtime.permission.requestAuthCode({
            corpId: config.corpId,
            onSuccess: (result) => typeof result?.code === 'string' && result.code ? finish(null, result.code) : finish(new Error('钉钉未返回免登码。')),
            onFail: () => finish(new Error('未能取得钉钉授权，请确认企业、应用可见范围及客户端版本。'))
          });
        } catch { finish(new Error('当前钉钉客户端不支持免登接口，请升级客户端。')); }
      });
    } catch { finish(new Error('钉钉 SDK 初始化失败，请重新打开应用。')); }
  });
  return client.loginDingTalk({ code, corpId: config.corpId, challengeId });
}
