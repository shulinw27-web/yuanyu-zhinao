import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { extractMultimodalEvidence, inspectMultimodalInput, scanMultimodalAttachment } from '../src/services/multimodal-input-service.js';

const png = `data:image/png;base64,${Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]).toString('base64')}`;
const role = { id: 'quality_manager' };
const saved = { nodeEnv: process.env.NODE_ENV, mode: process.env.MULTIMODAL_CONTENT_SECURITY_MODE, endpoint: process.env.MULTIMODAL_SECURITY_SCAN_ENDPOINT };
test.afterEach(() => {
  if (saved.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.nodeEnv;
  if (saved.mode === undefined) delete process.env.MULTIMODAL_CONTENT_SECURITY_MODE; else process.env.MULTIMODAL_CONTENT_SECURITY_MODE = saved.mode;
  if (saved.endpoint === undefined) delete process.env.MULTIMODAL_SECURITY_SCAN_ENDPOINT; else process.env.MULTIMODAL_SECURITY_SCAN_ENDPOINT = saved.endpoint;
});

test('production multimodal ingestion fails closed before OCR when antivirus and DLP are not configured', async () => {
  process.env.NODE_ENV = 'production';
  delete process.env.MULTIMODAL_SECURITY_SCAN_ENDPOINT;
  const inspected = inspectMultimodalInput({ attachments: [{ name: 'inspection.png', mimeType: 'image/png', dataUrl: png }] }, role);
  const extracted = await extractMultimodalEvidence(inspected.attachments);
  assert.equal(extracted.evidence.length, 0);
  assert.equal(extracted.reports[0].status, 'security_scanner_not_configured');
});

test('enterprise scanner malware decision blocks the attachment without returning raw content', async () => {
  const server = createServer((req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ clean: false, malwareDetected: true, scanId: 'scan-malware-1' })); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.NODE_ENV = 'production';
    process.env.MULTIMODAL_SECURITY_SCAN_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
    const inspected = inspectMultimodalInput({ attachments: [{ name: 'inspection.png', mimeType: 'image/png', dataUrl: png }] }, role);
    const scan = await scanMultimodalAttachment(inspected.attachments[0]);
    assert.equal(scan.allowed, false);
    assert.equal(scan.status, 'malware_blocked');
    assert.equal(Object.hasOwn(scan, 'contentBase64'), false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('local DLP redacts identity fields before structured text becomes model evidence', async () => {
  process.env.NODE_ENV = 'development';
  const text = Buffer.from('contact,email\nowner,person@example.test\nphone,13800138000');
  const dataUrl = `data:text/csv;base64,${text.toString('base64')}`;
  const inspected = inspectMultimodalInput({ attachments: [{ name: 'contacts.csv', mimeType: 'text/csv', dataUrl }] }, role);
  const extracted = await extractMultimodalEvidence(inspected.attachments);
  assert.equal(extracted.reports[0].status, 'content_scanned');
  assert.doesNotMatch(extracted.modelContext, /person@example\.test|13800138000/);
  assert.match(extracted.modelContext, /已脱敏/);
});

test('a scanner response without an explicit DLP decision cannot authorize image egress', async () => {
  const server = createServer((req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ clean: true })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.MULTIMODAL_SECURITY_SCAN_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
    const inspected = inspectMultimodalInput({ attachments: [{ name: 'inspection.png', mimeType: 'image/png', dataUrl: png }] }, role);
    assert.equal((await scanMultimodalAttachment(inspected.attachments[0])).allowed, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
