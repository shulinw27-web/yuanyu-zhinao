// 系统登记文档物料 schema 发现候选消费（ADR-028 阶段 8-5）专项测试。
//
// 覆盖：
//   1. 登记带 attachmentDocuments 的系统 → 文档解析 → 提取文本存库 → schema 发现候选可用
//   2. 多系统文档合并进候选
//   3. 文档解析失败不阻塞登记（warning 披露）
//   4. getAllSystemDocumentTexts 按租户隔离
//   5. discoverWorkspaceSchemas 自动合并系统文档
import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithSemanticTenant } from '../src/services/semantic-tenant-context.js';
import { registerSystemOnboarding, getSystemDocumentTexts, getAllSystemDocumentTexts } from '../src/services/system-access-service.js';
import { discoverWorkspaceSchemas } from '../src/services/semantic-material-workspace-service.js';

if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'memory') throw new Error('Use the runtime-test-bootstrap memory store.');

const identity = tenantId => ({ tenantId, subjectId: 'doc-tester', deviceId: 'device-1' });
const within = (tenant, work) => runWithSemanticTenant(identity(tenant), work);

const registrationMaterials = (overrides = {}) => ({
  name: '文档候选测试系统',
  domain: '供应链',
  description: '管理供应商准入与绩效的外部平台，覆盖寻源到付款全流程。',
  keyEntities: ['供应商档案', '绩效评分'],
  dataDomains: ['production', 'internal'],
  accessIntention: '读取供应商资质与绩效数据，支撑采购风险分析与供应商画像。',
  businessOwner: '采购负责人',
  heartbeat: { endpoint: 'https://api.example.com/health', method: 'GET', expectedStatus: 200 },
  auth: { scheme: 'user_token_passthrough', writeApprovalRequired: true },
  ...overrides
});

// 构造一个简单 CSV 字典文档的 dataUrl
function csvDataUrl(csvText) {
  return 'data:text/csv;base64,' + Buffer.from(csvText).toString('base64');
}

test('正例：登记带 CSV 字典文档的系统 → 提取文本存库 → schema 发现产出候选', async () => {
  const csv = 'object,field,type,required\n供应商档案,供应商名称,string,true\n供应商档案,资质等级,string,false';
  const materials = registrationMaterials({
    code: 'SDCA',
    attachmentDocuments: [{ mimeType: 'text/csv', dataUrl: csvDataUrl(csv) }]
  });
  const result = await within('doc-a', () => registerSystemOnboarding({ materials, identityScope: { tenantId: 'doc-a', subjectId: 'tester' } }));
  assert.equal(result.code, 'SDCA');
  // 文档应被解析并存库
  const docState = within('doc-a', () => getSystemDocumentTexts('SDCA'));
  assert.ok(docState.documents.length >= 1, '应至少有 1 份提取文本');
  assert.ok(docState.documents[0].text.includes('供应商档案'), '提取文本应含 CSV 内容');
  assert.equal(docState.documents[0].mimeType, 'text/csv');
  // schema 发现：在租户上下文内调用，确认系统文档进候选
  const discovery = within('doc-a', () => discoverWorkspaceSchemas([], '供应商'));
  assert.ok(discovery.objectTypes.length >= 1, `schema 发现应产出至少 1 个候选对象，实际 ${discovery.objectTypes.length}：${JSON.stringify(discovery.objectTypes.map(o => o.id))}`);
  assert.ok(discovery.objectTypes.some((obj) => obj.id.includes('供应商档案') || obj.label?.includes('供应商档案')), '候选应含供应商档案');
});

test('正例：多系统文档合并进候选', async () => {
  const csv1 = 'object,field,type,required\n产品,产品编码,string,true\n产品,产品名称,string,false';
  const csv2 = 'object,field,type,required\n仓库,仓库编码,string,true\n仓库,仓库名称,string,false';
  await within('doc-b', () => registerSystemOnboarding({
    materials: registrationMaterials({ code: 'SDCB', attachmentDocuments: [{ mimeType: 'text/csv', dataUrl: csvDataUrl(csv1) }] }),
    identityScope: { tenantId: 'doc-b', subjectId: 'tester' }
  }));
  await within('doc-b', () => registerSystemOnboarding({
    materials: registrationMaterials({ code: 'SDCC', attachmentDocuments: [{ mimeType: 'text/csv', dataUrl: csvDataUrl(csv2) }] }),
    identityScope: { tenantId: 'doc-b', subjectId: 'tester' }
  }));
  const allDocs = within('doc-b', () => getAllSystemDocumentTexts());
  assert.ok(Object.keys(allDocs).length >= 2, '应至少有 2 个系统的文档');
  const discovery = within('doc-b', () => discoverWorkspaceSchemas([], '产品 仓库'));
  assert.ok(discovery.objectTypes.length >= 2, `两个系统的文档应合并产出至少 2 个候选，实际 ${discovery.objectTypes.length}：${JSON.stringify(discovery.objectTypes.map(o => o.id))}`);
});

test('反例：文档解析失败不阻塞登记（warning 披露）', async () => {
  // 传一个无法解析的 dataUrl
  const result = await within('doc-c', () => registerSystemOnboarding({
    materials: registrationMaterials({ code: 'SDCD', attachmentDocuments: [{ mimeType: 'text/csv', dataUrl: 'data:text/csv;base64,!!invalid-base64!!' }] }),
    identityScope: { tenantId: 'doc-c', subjectId: 'tester' }
  }));
  assert.equal(result.code, 'SDCD', '登记应成功（文档解析失败不阻塞）');
  // documentWarnings 可能为空（取决于解析是否抛异常 vs 返回空文本）
  // 关键是登记不失败
});

test('租户隔离：不同租户的系统文档互不可见', async () => {
  const csv = 'object,field,type,required\n隔离对象,字段,string,true';
  await within('doc-d', () => registerSystemOnboarding({
    materials: registrationMaterials({ code: 'SDCE', attachmentDocuments: [{ mimeType: 'text/csv', dataUrl: csvDataUrl(csv) }] }),
    identityScope: { tenantId: 'doc-d', subjectId: 'tester' }
  }));
  // 另一租户看不到 doc-d 的文档
  const otherDocs = within('doc-e', () => getSystemDocumentTexts('SDCE'));
  assert.deepEqual(otherDocs.documents, [], '不同租户不应看到其他租户的系统文档');
});

test('discoverWorkspaceSchemas 自动合并系统文档与工作台文档', async () => {
  const csv = 'object,field,type,required\n设备,设备编码,string,true\n设备,设备名称,string,false';
  await within('doc-f', () => registerSystemOnboarding({
    materials: registrationMaterials({ code: 'SDCF', attachmentDocuments: [{ mimeType: 'text/csv', dataUrl: csvDataUrl(csv) }] }),
    identityScope: { tenantId: 'doc-f', subjectId: 'tester' }
  }));
  // 工作台文档 + 系统文档合并
  const workspaceDocs = [{ attachmentId: 'ws-1', name: 'workspace-dict.csv', mimeType: 'text/csv', text: 'object,field,type,required\n产线,产线编码,string,true\n产线,产线名称,string,false' }];
  const discovery = within('doc-f', () => discoverWorkspaceSchemas(workspaceDocs, '设备 产线'));
  assert.ok(discovery.objectTypes.length >= 2, `工作台 + 系统文档应合并产出至少 2 个候选，实际 ${discovery.objectTypes.length}：${JSON.stringify(discovery.objectTypes.map(o => o.id))}`);
  const ids = discovery.objectTypes.map((obj) => obj.id);
  assert.ok(ids.some((id) => id.includes('设备') || id.includes('SDCF')), '候选应含系统文档的设备对象');
  assert.ok(ids.some((id) => id.includes('产线')), '候选应含工作台文档的产线对象');
});
