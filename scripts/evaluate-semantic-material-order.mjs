// Deterministic parser diagnostics, not a model-quality score.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
process.env.NODE_ENV = 'test'; process.env.RUNTIME_STORE_DRIVER = 'memory'; process.env.AGENT_RUNTIME_MODE = 'mock';
const { inspectMultimodalInput, extractMultimodalEvidence } = await import('../backend/src/services/multimodal-input-service.js');
const { discoverSchemasFromAttachments } = await import('../backend/src/services/semantic-schema-discovery-service.js');
const { getRole } = await import('../backend/src/services/authorization-service.js');
const root = resolve(import.meta.dirname, '..');
const original = JSON.parse(await readFile(resolve(root, 'examples/semantic-schemas/manufacturing-case/data-dictionary.json'), 'utf8'));
const base = original.tables.find(t => t.name === 'PurchaseOrder');
const first = { tables: [base] };
const conflict = structuredClone(first);
conflict.tables[0].primaryKey = 'external_po_id';
conflict.tables[0].fields = conflict.tables[0].fields.map(f => f.name === 'po_id' ? { ...f, name: 'external_po_id' } : f);
const reports = [];
for (const [id, entries] of [['original_then_conflict', [['erp-contract-a.json', first], ['erp-contract-b.json', conflict]]], ['conflict_then_original', [['erp-contract-b.json', conflict], ['erp-contract-a.json', first]]]]) {
  const input = inspectMultimodalInput({ text: '对照 ERP 两份合同，只识别结构冲突。', attachments: entries.map(([name, data]) => ({ name, mimeType: 'application/json', dataUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(data)).toString('base64')}` })) }, getRole('executive'));
  if (input.error) throw new Error('Synthetic input rejected');
  const material = await extractMultimodalEvidence(input.attachments);
  const result = discoverSchemasFromAttachments({ attachments: input.attachments, reports: material.reports, input: 'ERP 采购订单字典' });
  reports.push({ id, source: 'deterministic_existing_parser', pickedKey: result.objectTypes[0]?.key, status: result.status, warnings: result.warnings, files: result.files });
}
await writeFile(resolve(root, 'output/semantic-manufacturing-fixed/order-conflicts.json'), JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports));
