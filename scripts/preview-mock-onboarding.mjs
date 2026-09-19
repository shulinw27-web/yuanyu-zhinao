import { resolve } from 'node:path';
import { installOfflineNetworkGuard } from './lib/offline-network-guard.mjs';
import { startMockOnboardingHTTP } from './lib/mock-onboarding-http.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('Synthetic UI preview is not a production server.');
Object.assign(process.env, { NODE_ENV: 'test', NODE_TEST_CONTEXT: 'mock-onboarding-preview', RUNTIME_STORE_DRIVER: 'memory',
  IDENTITY_SESSION_STORE_DRIVER: 'runtime', IAM_STORE_DRIVER: 'runtime', SEMANTIC_GOVERNANCE_STORE_DRIVER: 'runtime',
  IDENTITY_PROVIDERS_FILE: '', DEMO_ALLOW_ROLE_HEADER: 'false', TENANT_RUNTIME_CONTROL_REQUIRED: 'false' });
const guard = installOfflineNetworkGuard();
const api = await startMockOnboardingHTTP(guard);
const { createServer } = await import('vite');
const { default: vue } = await import('@vitejs/plugin-vue');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>元域 · 模拟企业接入验证</title></head><body>
<div id="app"></div><script type="module">
import { createApp, h } from '/node_modules/vue/dist/vue.esm-bundler.js';
import Workspace from '/apps/semantic-operations-console/src/components/SemanticOnboardingWorkspace.vue';
import '/apps/semantic-operations-console/src/styles.css';
const request = async (path = '', body) => { const response = await fetch('/api/semantic-operations/onboarding' + path, { method: body === undefined ? 'GET' : 'POST', headers: {'Content-Type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)}) }); const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.message || '模拟请求失败'), {status:response.status,code:value.code}); return value; };
const client = {onboarding:()=>request(), createOnboardingProject:body=>request('',body), onboardingProject:id=>request('/'+encodeURIComponent(id)),saveOnboardingMaterial:(id,body)=>request('/'+encodeURIComponent(id)+'/materials',body),testOnboardingConnection:(id,body)=>request('/'+encodeURIComponent(id)+'/connection',body),onboardingPreview:(id,objectType)=>request('/'+encodeURIComponent(id)+'/preview'+(objectType?'?objectType='+encodeURIComponent(objectType):''))};
client.onboardingAlignment=id=>request('/'+encodeURIComponent(id)+'/alignment');
client.saveOnboardingAlignment=(id,body)=>request('/'+encodeURIComponent(id)+'/alignment',body);
client.handoffOnboarding=(id,body)=>request('/'+encodeURIComponent(id)+'/handoff',body);
client.onboardingCalculations=id=>request('/'+encodeURIComponent(id)+'/calculations');
client.previewOnboardingCalculation=(id,body)=>request('/'+encodeURIComponent(id)+'/calculations',body);
createApp({render:()=>h('main',{style:'max-width:1440px;margin:0 auto;padding:24px;box-sizing:border-box'},[h('p',{style:'color:#9db7c3'},'隔离浏览器验证 · 合成甲企业 · 内存数据关闭即清除 · 未连接云模型'),h(Workspace,{client,canWrite:true})])}).mount('#app');
</script></body></html>`;
let preview; let revokePreviewPort;
try {
  if (process.argv.includes('--reviewed-calculation-fixture')) {
    const { prepareReviewedCalculationFixture } = await import('./lib/mock-onboarding-reviewed-fixture.mjs');
    console.log('Explicit synthetic human-reviewed setup:', await prepareReviewedCalculationFixture(api));
  }
  preview = await createServer({ configFile: false, root: resolve('.'), logLevel: 'error', plugins: [vue(), {
    name: 'mock-onboarding-preview', configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url !== '/') return next();
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(await server.transformIndexHtml('/', html));
    }); }
  }], server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': { target: `http://127.0.0.1:${api.port}`, headers: api.syntheticHeaders('mock-onboarding-a') } } } });
  await preview.listen(); revokePreviewPort = guard.allowPort(preview.httpServer.address().port);
  console.log(`Synthetic UI preview: http://127.0.0.1:${preview.httpServer.address().port}/`);
} catch (error) { if (preview) await preview.close(); revokePreviewPort?.(); await api.close(); guard.restore(); throw error; }
let closing = false;
const stop = async () => { if (closing) return; closing = true; await preview.close(); revokePreviewPort?.(); await api.close(); guard.restore(); process.exit(0); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
