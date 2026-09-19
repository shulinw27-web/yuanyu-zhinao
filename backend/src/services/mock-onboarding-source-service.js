import http, { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const PROTOCOL = 'mock-onboarding-query.v1';
const PAGE_SIZE = 16;
const MAX_RECORDS = 500;
const MAX_BYTES = 64 * 1024;
export const mockOnboardingSourceFaults = Object.freeze(['none', 'rate_limited', 'timeout', 'malformed', 'cross_tenant', 'incomplete', 'schema_drift']);
const messages = {
  SANDBOX_ONLY: '模拟数据源不在生产环境开放。', CONTRACT_INVALID: '模拟接口响应不符合只读数据契约。',
  RATE_LIMITED: '模拟接口返回 429 限流；本次未取得完整数据，请恢复正常模式后重试。',
  TIMEOUT: '模拟接口读取超时，部分数据未用于预览。', MALFORMED: '模拟接口未返回有效 JSON。',
  TENANT_MISMATCH: '模拟接口返回了不属于当前租户的记录，已拒绝整批数据。',
  INCOMPLETE: '分页、快照或完整性声明不一致，已拒绝不完整数据。',
  TRANSPORT_FAILED: '本地模拟接口通信失败；未连接外部企业系统。', BUSY: '本地模拟连接测试繁忙，请稍后重试。'
};
const failure = key => Object.assign(new Error(messages[key]), { code: `MOCK_SOURCE_${key}` });
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
let active = 0;
let testPortObserver = null;

// This only registers the exact ephemeral port with the offline test guard;
// it cannot replace an endpoint, source data or authentication decision.
export function observeMockOnboardingPortsForTest(observer) {
  if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'memory') throw failure('SANDBOX_ONLY');
  const previous = testPortObserver;
  testPortObserver = observer;
  return () => { testPortObserver = previous; };
}

async function fixture(scenarioId, tenantId) {
  const source = scenarioId === 'fulfillment'
    ? await import('../../../examples/knowledge/dual-agent-mock/input-materials.mjs')
    : await import('../../../examples/semantic-schemas/supply-chain-incident/scenario.mjs');
  const seen = new Set();
  const records = structuredClone(source.samples.records).filter(row => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  // Namespace fixed synthetic facts to the authenticated scope. This does not
  // certify customer data ownership and never reads uploaded samples as output.
  for (const row of records) row.tenantId = tenantId;
  return { records, systems: [...new Set(source.dictionary.tables.map(table => table.system))].sort() };
}

async function readJSON(response) {
  if (!response.headers['content-type']?.startsWith('application/json')) { response.destroy(); throw failure('MALFORMED'); }
  const chunks = []; let bytes = 0;
  try {
    for await (const value of response) {
      bytes += value.length;
      if (bytes > MAX_BYTES) throw failure('CONTRACT_INVALID');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw failure('MALFORMED'); }
  } finally { response.destroy(); }
}

// agent:false prevents idle pooling/reconnection after a fault or port revoke.
// node:http does not follow redirects; non-2xx responses are rejected below.
function requestPage(url, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { ...options, agent: false }, resolve);
    req.once('error', reject); req.end();
  });
}

// Embedded synthetic HTTP source, deliberately NOT a customer connector or an
// ontology-query.v1 adapter. No URL, credential, path or uploaded API instruction
// may select a destination. Each request gets an isolated, short-lived listener.
export async function readMockOnboardingSource({ scenarioId, tenantId, projectId, faultMode = 'none' }) {
  if (process.env.NODE_ENV === 'production') throw failure('SANDBOX_ONLY');
  if (!['fulfillment', 'quality_incident'].includes(scenarioId) || !mockOnboardingSourceFaults.includes(faultMode)
    || typeof tenantId !== 'string' || !tenantId.trim() || tenantId.length > 120
    || typeof projectId !== 'string' || !projectId.startsWith('mock-onboarding-') || projectId.length > 100) throw failure('CONTRACT_INVALID');
  if (active >= 4) throw failure('BUSY');
  active++;
  let server; let revokePort;
  let requests = 0; let pageCount = 0;
  try {
    const source = await fixture(scenarioId, tenantId);
    const snapshotId = `synthetic-${randomUUID()}`;
    const token = randomUUID();
    const query = cursor => ({ protocol: PROTOCOL, scenarioId, tenantId, projectId, cursor, pageSize: PAGE_SIZE });
    server = createServer((req, res) => {
      const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
      if (req.method !== 'GET' || req.headers.authorization !== `Bearer ${token}`) return send(403, { code: 'FORBIDDEN' });
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const cursor = Number(url.searchParams.get('cursor'));
        if (url.pathname !== '/records') return send(404, { code: 'NOT_FOUND' });
        if (!url.searchParams.has('cursor') || !Number.isSafeInteger(cursor) || cursor < 0 || cursor % PAGE_SIZE || cursor >= source.records.length) return send(400, { code: 'CURSOR_INVALID' });
        if (faultMode === 'rate_limited') return send(429, { code: 'SIMULATED_RATE_LIMIT' });
        if (faultMode === 'timeout' && cursor > 0) return; // Client deadline and finally close the socket.
        if (faultMode === 'malformed') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{invalid'); return; }
        const records = structuredClone(source.records.slice(cursor, cursor + PAGE_SIZE));
        if (faultMode === 'cross_tenant' && cursor > 0) records[0].tenantId = 'synthetic-foreign-tenant';
        if (faultMode === 'schema_drift' && cursor === 0) records[0].payload.undeclared_mock_field = '模拟新增字段';
        const nextCursor = cursor + records.length < source.records.length ? cursor + records.length : null;
        return send(200, { protocol: PROTOCOL, snapshotId, queryFingerprint: fingerprint(query(cursor)), systems: source.systems,
          coverage: { complete: faultMode !== 'incomplete', totalRecords: source.records.length }, records, nextCursor });
      } catch { return send(400, { code: 'INVALID_REQUEST' }); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    revokePort = testPortObserver?.(port);
    const records = []; const seen = new Set(); const seenCursors = new Set();
    let cursor = 0; let expectedTotal;
    const deadline = AbortSignal.timeout(5_000);
    while (cursor !== null) {
      if (seenCursors.has(cursor) || pageCount >= Math.ceil(MAX_RECORDS / PAGE_SIZE)) throw failure('INCOMPLETE');
      seenCursors.add(cursor); requests++;
      const response = await requestPage(`http://127.0.0.1:${port}/records?cursor=${cursor}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.any([deadline, AbortSignal.timeout(1_000)])
      });
      if (response.statusCode !== 200) { response.destroy(); throw failure(response.statusCode === 429 ? 'RATE_LIMITED' : 'TRANSPORT_FAILED'); }
      const page = await readJSON(response); pageCount++;
      if (page?.protocol !== PROTOCOL || page.queryFingerprint !== fingerprint(query(cursor)) || !Array.isArray(page.records)
        || page.records.length < 1 || page.records.length > PAGE_SIZE || JSON.stringify(page.systems) !== JSON.stringify(source.systems)) throw failure('CONTRACT_INVALID');
      if (page.snapshotId !== snapshotId || page.coverage?.complete !== true || !Number.isSafeInteger(page.coverage.totalRecords)
        || page.coverage.totalRecords < 1 || page.coverage.totalRecords > MAX_RECORDS) throw failure('INCOMPLETE');
      expectedTotal ??= page.coverage.totalRecords;
      if (expectedTotal !== page.coverage.totalRecords || records.length + page.records.length > expectedTotal) throw failure('INCOMPLETE');
      for (const row of page.records) {
        if (!plain(row) || row.tenantId !== tenantId) throw failure('TENANT_MISMATCH');
        if (!source.systems.includes(row.system) || typeof row.id !== 'string' || !row.id || typeof row.objectType !== 'string' || !row.objectType
          || typeof row.version !== 'string' || !row.version || typeof row.organizationId !== 'string' || !row.organizationId
          || !Number.isFinite(Date.parse(row.occurredAt)) || !plain(row.payload)) throw failure('CONTRACT_INVALID');
        const key = JSON.stringify([row.system, row.objectType, row.id]);
        if (seen.has(key)) throw failure('INCOMPLETE');
        seen.add(key); records.push(row);
      }
      const next = records.length < expectedTotal ? cursor + page.records.length : null;
      if (page.nextCursor !== next || (next !== null && page.records.length !== PAGE_SIZE)) throw failure('INCOMPLETE');
      cursor = page.nextCursor;
    }
    if (records.length !== expectedTotal) throw failure('INCOMPLETE');
    return { sourceKind: 'local_mock_http', protocol: PROTOCOL, snapshotId, systems: source.systems, records, requests, pageCount };
  } catch (error) {
    const safe = typeof error.code === 'string' && error.code.startsWith('MOCK_SOURCE_') ? error
      : ['TimeoutError', 'AbortError'].includes(error.name) ? failure('TIMEOUT') : failure('TRANSPORT_FAILED');
    safe.requests = requests; safe.pageCount = pageCount;
    throw safe;
  } finally {
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    revokePort?.(); active--;
  }
}
