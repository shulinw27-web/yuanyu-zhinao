import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { parseOfficeMaterial } from './office-material-parser.js';
import { observeVisualMaterial, visualModelAvailability } from './visual-material-service.js';
import { assessPromptContent, normalizeUntrustedText } from './prompt-security-service.js';

const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const structuredMimeTypes = new Set(['application/json', 'text/csv', 'application/yaml', 'application/x-yaml', 'text/yaml', 'text/x-yaml']);
const officeMimeTypes = new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', ...structuredMimeTypes, ...officeMimeTypes]);
const MAX_PDF_PAGES = 20;
const MAX_PAGE_CHARACTERS = 6_000;
const MAX_MODEL_CONTEXT_CHARACTERS = 24_000;
const ATTACHMENT_RETENTION_MINUTES = 60;
const require = createRequire(import.meta.url);
const standardFontDataUrl = pathToFileURL(`${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/`).toString();

const byteLengthFromDataUrl = (dataUrl = '') => {
  const encoded = dataUrl.split(',')[1] || '';
  try { return Buffer.from(encoded, 'base64').length; } catch { return 0; }
};

const hasExpectedSignature = (dataUrl, mimeType) => {
  try {
    const bytes = Buffer.from(dataUrl.split(',')[1] || '', 'base64');
    if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
    if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    if (mimeType === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    if (mimeType === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
    if (officeMimeTypes.has(mimeType)) return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && [0x03, 0x05, 0x07].includes(bytes[2]);
    if (structuredMimeTypes.has(mimeType)) {
      const text = bytes.toString('utf8');
      const replacementCount = (text.match(/\uFFFD/g) || []).length;
      return bytes.length > 0 && !bytes.includes(0) && replacementCount <= 2;
    }
    return false;
  } catch {
    return false;
  }
};

const attachmentType = (mimeType) => mimeType.startsWith('image/') ? 'image' : 'document';
const hasCanonicalBase64 = (dataUrl = '') => {
  const encoded = dataUrl.split(',')[1] || '';
  return encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded);
};

const embeddedTextCandidate = (dataUrl = '') => {
  const encoded = dataUrl.split(',')[1] || '';
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return (decoded.match(/[\p{L}\p{N}\s.,:;!?_/-]{20,}/gu) || []).slice(0, 24).join('\n').slice(0, 4_000);
  } catch {
    return '';
  }
};

const publicAttachment = (attachment) => ({
  id: attachment.id,
  name: attachment.name,
  type: attachment.type,
  mimeType: attachment.mimeType,
  size: attachment.size,
  classification: attachment.classification,
  scanStatus: attachment.promptSecurity.status,
  modelContentEligible: attachment.promptSecurity.modelContentEligible,
  retentionExpiresAt: attachment.retentionExpiresAt
});

const privateServiceEndpoint = (endpoint, allowExternalVariable) => {
  try {
    const url = new URL(String(endpoint || ''));
    const hostname = url.hostname.toLowerCase();
    const privateHost = hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
      || /^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || hostname.endsWith('.local');
    return ['http:', 'https:'].includes(url.protocol) && (privateHost || process.env[allowExternalVariable] === 'true') ? url : null;
  } catch { return null; }
};

const requiredContentSecurity = () => process.env.NODE_ENV === 'production' || process.env.MULTIMODAL_CONTENT_SECURITY_MODE === 'required';

export async function scanMultimodalAttachment(attachment) {
  const endpoint = String(process.env.MULTIMODAL_SECURITY_SCAN_ENDPOINT || '').trim();
  if (!endpoint) return requiredContentSecurity()
    ? { allowed: false, status: 'security_scanner_not_configured', reason: '生产或强制模式未配置企业病毒扫描/DLP 服务。' }
    : { allowed: true, status: 'development_basic_scan', dlpAction: 'local_redaction', classifications: [] };
  const url = privateServiceEndpoint(endpoint, 'MULTIMODAL_SECURITY_SCAN_ALLOW_EXTERNAL');
  if (!url) return { allowed: false, status: 'security_scanner_rejected', reason: '内容安全端点不属于允许的企业内网地址。' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...(process.env.MULTIMODAL_SECURITY_SCAN_API_KEY ? { Authorization: `Bearer ${process.env.MULTIMODAL_SECURITY_SCAN_API_KEY}` } : {}) }, body: JSON.stringify({ attachmentId: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, contentBase64: attachment.dataUrl.split(',')[1] || '', policy: { antivirus: 'required', dlp: 'required', sandbox: attachment.mimeType === 'application/pdf' ? 'pdf' : 'document' } }), signal: controller.signal });
    if (!response.ok) throw new Error(`scanner status ${response.status}`);
    const payload = await response.json();
    if (payload?.malwareDetected || payload?.clean !== true || !['allow', 'redact'].includes(payload?.dlpAction)) return { allowed: false, status: payload?.malwareDetected ? 'malware_blocked' : 'dlp_blocked', reason: '企业内容安全策略未明确允许该材料。', scanId: String(payload?.scanId || '').slice(0, 160) || null };
    return { allowed: true, status: 'enterprise_security_scanned', dlpAction: payload?.dlpAction === 'redact' ? 'redact' : 'allow', classifications: Array.isArray(payload?.classifications) ? payload.classifications.map(String).slice(0, 20) : [], scanId: String(payload?.scanId || '').slice(0, 160) || null };
  } catch {
    return requiredContentSecurity() ? { allowed: false, status: 'security_scanner_unavailable', reason: '企业内容安全服务不可用，材料已失败关闭。' } : { allowed: true, status: 'development_scanner_unavailable', dlpAction: 'local_redaction', classifications: [] };
  } finally { clearTimeout(timeout); }
}

const applyLocalDlp = (value) => {
  const source = String(value || '');
  const signals = [];
  const redact = (pattern, label) => source.match(pattern) ? signals.push(label) : null;
  redact(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, 'email');
  redact(/\b1\d{10}\b/g, 'phone');
  redact(/\b\d{17}[\dXx]\b/g, 'national_id');
  const text = source.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[邮箱已脱敏]').replace(/\b1\d{10}\b/g, '[手机号已脱敏]').replace(/\b\d{17}[\dXx]\b/g, '[身份标识已脱敏]');
  return { text, signals: [...new Set(signals)] };
};

export function inspectMultimodalInput(payload = {}, role) {
  const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments.slice(0, MAX_ATTACHMENTS) : [];
  if (Array.isArray(payload.attachments) && payload.attachments.length > MAX_ATTACHMENTS) return { error: `一次最多上传 ${MAX_ATTACHMENTS} 个附件。` };

  const attachments = [];
  let totalBytes = 0;
  for (const raw of rawAttachments) {
    const mimeType = String(raw?.mimeType || '').toLowerCase();
    const name = String(raw?.name || '未命名附件').slice(0, 120);
    const dataUrl = String(raw?.dataUrl || '');
    if (!allowedMimeTypes.has(mimeType)) return { error: '仅支持 JPEG、PNG、WEBP、PDF、DOCX、XLSX、JSON、YAML 和 CSV 材料。' };
    if (!dataUrl.startsWith(`data:${mimeType};base64,`)) return { error: '附件格式不符合安全上传规范。' };
    if (!hasCanonicalBase64(dataUrl)) return { error: '附件 Base64 编码不符合安全上传规范。' };
    if (!hasExpectedSignature(dataUrl, mimeType)) return { error: '附件实际内容与声明类型不一致。' };
    const size = byteLengthFromDataUrl(dataUrl);
    if (!size || size > MAX_ATTACHMENT_BYTES) return { error: `单个附件必须小于 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB。` };
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) return { error: `本次附件总大小必须小于 ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024}MB。` };
    const metadataSafety = assessPromptContent(name, { source: 'attachment_name', maxCharacters: 120 });
    if (!metadataSafety.safe) return { error: `附件“${normalizeUntrustedText(name).slice(0, 40)}”的名称包含高风险指令，已隔离该材料。`, security: metadataSafety };
    const embeddedSafety = assessPromptContent(embeddedTextCandidate(dataUrl), { source: 'attachment_embedded_text', maxCharacters: 4_000 });
    if (!embeddedSafety.safe) return { error: `附件“${normalizeUntrustedText(name).slice(0, 40)}”包含疑似隐藏指令，已隔离该材料。`, security: embeddedSafety };
    const type = attachmentType(mimeType);
    attachments.push({
      id: `media-${createHash('sha256').update(name).update(dataUrl).digest('hex').slice(0, 16)}`,
      name,
      type,
      mimeType,
      size,
      classification: '受限业务材料',
      // Signature checks and printable-byte inspection are not OCR or a sandboxed
      // PDF parser. Until those production scanners are connected, the raw content
      // is never eligible for model egress or write-action planning.
      promptSecurity: {
        status: 'basic_signature_and_embedded_text_checked',
        rawImageEligible: false,
        contentScan: 'unscanned',
        modelContentEligible: false,
        fingerprint: embeddedSafety.fingerprint
      },
      retentionExpiresAt: new Date(Date.now() + ATTACHMENT_RETENTION_MINUTES * 60_000).toISOString(),
      dataUrl
    });
  }

  const imageCount = attachments.filter((item) => item.type === 'image').length;
  const documentCount = attachments.length - imageCount;
  return {
    attachments,
    publicAttachments: attachments.map(publicAttachment),
    promptSummary: attachments.length
      ? `已接收 ${imageCount ? `${imageCount} 张图片` : ''}${imageCount && documentCount ? '和' : ''}${documentCount ? `${documentCount} 份文档` : ''}。材料按“受限业务材料”处理；只有通过 OCR 或受控文档解析及内容级扫描的文本才会进入模型上下文，也不据此绕过写操作确认。`
      : '',
    audit: {
      actor: role.id,
      action: '智脑接收多模态材料',
      attachmentCount: attachments.length,
      dataClassification: '受限业务材料',
      contentScan: attachments.length ? 'unscanned' : 'not_applicable',
      modelContentEgress: 'blocked_until_content_scan',
      retention: `附件原文件不持久化；已扫描文本可作为有界会话节选保存，仅同一身份与授权可检索，最长 ${ATTACHMENT_RETENTION_MINUTES} 分钟后失效；失效不代表存储备份已物理删除`
    }
  };
}

const normalizeExtractedText = (value) => normalizeUntrustedText(String(value || ''))
  .replace(/[ \t]+/g, ' ')
  .trim();

const documentEvidence = ({ attachment, page, text, assessment }) => ({
  source: '受控多模态解析',
  id: `${attachment.id}:${attachment.mimeType === 'application/pdf' ? `page-${page}` : 'document-text'}`,
  title: `${attachment.name} · ${attachment.mimeType === 'application/pdf' ? `第 ${page} 页` : '文档文本（非分页定位）'}`,
  classification: attachment.classification,
  statement: text,
  locator: { attachmentId: attachment.id, mimeType: attachment.mimeType,
    ...(attachment.mimeType === 'application/pdf' ? { page, kind: 'pdf_page' }
      : { kind: attachment.mimeType.includes('spreadsheetml') ? 'worksheet_cells_in_text' : attachment.mimeType.includes('wordprocessingml') ? 'paragraphs_tables_in_text' : 'structured_document_text' }) },
  confidence: 'extracted_text',
  contentHash: createHash('sha256').update(text).digest('hex'),
  promptSecurity: { status: assessment.safe ? 'validated' : 'quarantined', fingerprint: assessment.fingerprint }
});

async function extractPdfText(attachment, securityScan) {
  const bytes = Buffer.from(attachment.dataUrl.split(',')[1] || '', 'base64');
  const structuralText = bytes.toString('latin1');
  if (/\/(?:JavaScript|JS|Launch|EmbeddedFile)\b/i.test(structuralText)) throw new Error('active pdf content is not allowed');
  const document = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), disableWorker: true, stopAtErrors: true, isEvalSupported: false, maxImageSize: 8_000_000, standardFontDataUrl, verbosity: 0 }).promise;
  const pages = [];
  const missingPages = [];
  const failures = [];
  let visualPages = 0;
  try {
    for (let page = 1; page <= Math.min(document.numPages, MAX_PDF_PAGES); page += 1) {
      const item = await document.getPage(page);
      const content = await item.getTextContent();
      const plain = normalizeExtractedText(content.items.map(token => `${token.str || ''}${token.hasEOL ? '\n' : ' '}`).join(''));
      // Mixed pages can contain a text heading above a scanned table. Render
      // image-bearing pages too, not just pages with absolutely no text.
      const ops = await item.getOperatorList();
      const hasImage = ops.fnArray.some(op => [pdfjsLib.OPS.paintImageXObject, pdfjsLib.OPS.paintInlineImageXObject, pdfjsLib.OPS.paintImageMaskXObject].includes(op));
      let visualText = '';
      if (!plain || hasImage) {
        const enabled = configuredOcrEndpoint() || visualModelAvailability(securityScan).allowed;
        if (enabled && visualPages < 3) {
          visualPages += 1;
          const size = item.getViewport({ scale: 1 });
          const viewport = item.getViewport({ scale: Math.min(2, 1800 / Math.max(size.width, size.height)) });
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await item.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          const dataUrl = `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`;
          const extracted = await extractImageText({ ...attachment, id: `${attachment.id}-page-${page}`, type: 'image', mimeType: 'image/png', dataUrl }, securityScan);
          if (extracted.evidence) visualText = extracted.evidence.statement;
          else failures.push({ page, ...extracted.report });
        }
        if (!visualText) missingPages.push(page);
      }
      const text = [plain, visualText ? `页面视觉观察（需复核）：\n${visualText}` : ''].filter(Boolean).join('\n');
      if (text) pages.push({ page, text });
      item.cleanup();
    }
    return { pages, missingPages, failures, totalPages: document.numPages, truncated: document.numPages > MAX_PDF_PAGES };
  } finally {
    await document.destroy();
  }
}

const configuredOcrEndpoint = () => String(process.env.MULTIMODAL_OCR_ENDPOINT || '').trim();
const ocrEvidence = ({ attachment, text, confidence, region, assessment }) => ({
  source: '受控多模态 OCR',
  id: `${attachment.id}:ocr`,
  title: `${attachment.name} · OCR 文本`,
  classification: attachment.classification,
  statement: text,
  locator: { attachmentId: attachment.id, mimeType: attachment.mimeType, ...(region ? { region } : {}) },
  confidence: Number.isFinite(confidence) ? `ocr_${confidence.toFixed(2)}` : 'ocr_unscored',
  contentHash: createHash('sha256').update(text).digest('hex'),
  promptSecurity: { status: assessment.safe ? 'validated' : 'quarantined', fingerprint: assessment.fingerprint }
});

async function extractImageText(attachment, securityScan) {
  const endpoint = configuredOcrEndpoint();
  if (!endpoint) {
    const observed = await observeVisualMaterial(attachment, securityScan);
    if (observed.error) return { report: { attachmentId: attachment.id, ...observed.error, modelContentEligible: false, rawImageEligible: false } };
    const dlp = applyLocalDlp(observed.text);
    const assessment = assessPromptContent(dlp.text, { source: 'visual_observation', maxCharacters: 24000 });
    if (!assessment.safe) return { report: { attachmentId: attachment.id, status: 'quarantined', modelContentEligible: false, reason: '视觉观察未通过内容检查。' }, quarantined: { attachmentId: attachment.id, assessment } };
    return { report: { attachmentId: attachment.id, status: 'content_scanned', modelContentEligible: true, rawImageEligible: false, method: 'vision_model', provider: observed.source, warnings: ['视觉观察可能存在识别误差；模糊数值和关系需人工复核。'] }, evidence: { ...ocrEvidence({ attachment, text: dlp.text, assessment }), source: '受控视觉模型观察', title: `${attachment.name} · 视觉观察`, confidence: 'model_observation_unverified' } };
  }
  const url = privateServiceEndpoint(endpoint, 'MULTIMODAL_OCR_ALLOW_EXTERNAL');
  if (!url) return { report: { attachmentId: attachment.id, status: 'visual_adapter_rejected', modelContentEligible: false, reason: 'OCR 端点不属于允许的企业内网地址，已拒绝发送图片。' } };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.MULTIMODAL_OCR_API_KEY ? { Authorization: `Bearer ${process.env.MULTIMODAL_OCR_API_KEY}` } : {})
      },
      body: JSON.stringify({ attachmentId: attachment.id, mimeType: attachment.mimeType, contentBase64: attachment.dataUrl.split(',')[1] || '' }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`OCR endpoint status ${response.status}`);
    const payload = await response.json();
    const dlp = applyLocalDlp(normalizeExtractedText(payload?.text));
    const text = dlp.text;
    if (!text) return { report: { attachmentId: attachment.id, status: 'no_extractable_text', modelContentEligible: false, reason: 'OCR 未返回可验证文本，图片内容未提供给模型。' } };
    const assessment = assessPromptContent(text, { source: 'ocr_extracted_text', maxCharacters: MAX_PAGE_CHARACTERS });
    if (!assessment.safe) return {
      report: { attachmentId: attachment.id, status: 'quarantined', modelContentEligible: false, reason: 'OCR 文本包含疑似指令注入，图片内容已隔离。', fingerprint: assessment.fingerprint },
      quarantined: { attachmentId: attachment.id, page: null, assessment }
    };
    const confidence = Number(payload?.confidence);
    const region = payload?.region && typeof payload.region === 'object' && !Array.isArray(payload.region) ? payload.region : null;
    return {
      report: { attachmentId: attachment.id, status: 'content_scanned', modelContentEligible: true, rawImageEligible: false, method: 'ocr', confidence: Number.isFinite(confidence) ? confidence : null, dlpSignals: dlp.signals, warnings: ['OCR 仅识别文字，不保证图形关系和版面含义。'] },
      evidence: ocrEvidence({ attachment, text, confidence, region, assessment })
    };
  } catch {
    return { report: { attachmentId: attachment.id, status: 'visual_adapter_unavailable', modelContentEligible: false, reason: '企业 OCR/视觉适配器不可用，图片内容未提供给模型。' } };
  } finally {
    clearTimeout(timeout);
  }
}

const assessExtracted = (text, source) => {
  let result = assessPromptContent('', { source });
  for (let start = 0; start < text.length; start += 23000) {
    result = assessPromptContent(text.slice(start, start + 24000), { source, maxCharacters: 24000 });
    if (!result.safe) return result;
  }
  return result;
};

export async function extractMultimodalEvidence(attachments = []) {
  const evidence = [];
  // Server-only complete, scanned and DLP-redacted text. Presentation/model
  // budgets must not truncate the input of deterministic schema parsers.
  const documents = [];
  const reports = [];
  const quarantined = [];
  for (const attachment of attachments) {
    const securityScan = await scanMultimodalAttachment(attachment);
    if (!securityScan.allowed) {
      reports.push({ attachmentId: attachment.id, status: securityScan.status, modelContentEligible: false, reason: securityScan.reason, scanId: securityScan.scanId || null });
      quarantined.push({ attachmentId: attachment.id, page: null, assessment: { safe: false, action: 'block', reason: securityScan.reason } });
      continue;
    }
    if (structuredMimeTypes.has(attachment.mimeType)) {
      const dlp = applyLocalDlp(normalizeUntrustedText(Buffer.from(attachment.dataUrl.split(',')[1] || '', 'base64').toString('utf8')));
      const text = dlp.text;
      const assessment = assessExtracted(text, 'structured_schema_document');
      if (!assessment.safe) {
        quarantined.push({ attachmentId: attachment.id, page: 1, assessment });
        reports.push({ attachmentId: attachment.id, status: 'quarantined', modelContentEligible: false, reason: '结构化材料包含疑似指令注入，已隔离。', fingerprint: assessment.fingerprint });
        continue;
      }
      if (!text) {
        reports.push({ attachmentId: attachment.id, status: 'no_extractable_text', modelContentEligible: false, reason: '结构化材料为空。' });
        continue;
      }
      evidence.push(documentEvidence({ attachment, page: 1, text: normalizeExtractedText(text), assessment }));
      documents.push({ attachmentId: attachment.id, name: attachment.name, mimeType: attachment.mimeType, text });
      reports.push({ attachmentId: attachment.id, status: 'content_scanned', modelContentEligible: true, pageCount: 1, structuredSchemaCandidate: true, securityScan: securityScan.status, dlpSignals: dlp.signals });
      continue;
    }
    if (officeMimeTypes.has(attachment.mimeType)) {
      try {
        const parsed = await parseOfficeMaterial(Buffer.from(attachment.dataUrl.split(',')[1] || '', 'base64'), attachment.mimeType);
        const dlp = applyLocalDlp(parsed.text);
        const text = dlp.text;
        if (!text) {
          reports.push({ attachmentId: attachment.id, status: 'no_extractable_text', modelContentEligible: false, reason: 'Office 文档未提取到可验证文本。' });
          continue;
        }
        const assessment = assessExtracted(text, 'office_extracted_text');
        if (!assessment.safe) {
          quarantined.push({ attachmentId: attachment.id, page: 1, assessment });
          reports.push({ attachmentId: attachment.id, status: 'quarantined', modelContentEligible: false, reason: 'Office 文档包含疑似指令注入，已隔离。', fingerprint: assessment.fingerprint });
          continue;
        }
        evidence.push(documentEvidence({ attachment, page: 1, text: normalizeExtractedText(text), assessment }));
        reports.push({ attachmentId: attachment.id, status: 'content_scanned', modelContentEligible: true, pageCount: 1, officeDocument: true, securityScan: securityScan.status, dlpSignals: dlp.signals, truncated: parsed.truncated, warnings: parsed.warnings });
      } catch {
        reports.push({ attachmentId: attachment.id, status: 'parse_failed', modelContentEligible: false, reason: 'Office 文档无法在受控解析器中安全读取。' });
      }
      continue;
    }
    if (attachment.mimeType !== 'application/pdf') {
      const extracted = await extractImageText(attachment, securityScan);
      reports.push(extracted.report);
      if (extracted.evidence) evidence.push(extracted.evidence);
      if (extracted.quarantined) quarantined.push(extracted.quarantined);
      continue;
    }
    try {
      const extracted = await extractPdfText(attachment, securityScan);
      if (extracted.failures.some(item => item.status === 'quarantined')) {
        reports.push({ attachmentId: attachment.id, status: 'quarantined', modelContentEligible: false, reason: 'PDF 视觉内容未通过安全检查，整份材料已隔离。' });
        quarantined.push({ attachmentId: attachment.id, assessment: { safe: false, action: 'block' } });
        continue;
      }
      if (!extracted.pages.length) {
        reports.push({ attachmentId: attachment.id, status: 'no_extractable_text', modelContentEligible: false, reason: 'PDF 扫描页面尚未识别；需启用企业 OCR 或获准的视觉模型，不能根据文件名推测内容。', truncated: extracted.truncated, totalPages: extracted.totalPages, missingPages: extracted.missingPages });
        continue;
      }
      const unsafePage = extracted.pages
        .map((item) => ({ ...item, assessment: assessExtracted(item.text, 'pdf_extracted_text') }))
        .find((item) => !item.assessment.safe);
      if (unsafePage) {
        quarantined.push({ attachmentId: attachment.id, page: unsafePage.page, assessment: unsafePage.assessment });
        reports.push({ attachmentId: attachment.id, status: 'quarantined', modelContentEligible: false, reason: '解析文本包含疑似指令注入，附件内容已隔离。', page: unsafePage.page, fingerprint: unsafePage.assessment.fingerprint });
        continue;
      }
      const pageEvidence = extracted.pages.map((item) => {
        const dlp = applyLocalDlp(item.text);
        return documentEvidence({ attachment, page: item.page, text: dlp.text, assessment: assessExtracted(dlp.text, 'pdf_extracted_text') });
      });
      evidence.push(...pageEvidence);
      reports.push({ attachmentId: attachment.id, status: 'content_scanned', modelContentEligible: true, pageCount: pageEvidence.length, totalPages: extracted.totalPages, missingPages: extracted.missingPages, partial: extracted.missingPages.length > 0, truncated: extracted.truncated, securityScan: securityScan.status, dlpApplied: true, warnings: ['PDF 文本阅读顺序不保证还原复杂多栏、图形或表格；视觉页需复核。'] });
    } catch {
      reports.push({ attachmentId: attachment.id, status: 'parse_failed', modelContentEligible: false, reason: 'PDF 无法在受控解析器中安全读取，未向模型提供内容。' });
    }
  }
  // Fair allocation prevents the first large document starving later files.
  // Coverage notices travel with the material into follow-up conversation memory.
  const budget = Math.floor(MAX_MODEL_CONTEXT_CHARACTERS / Math.max(1, attachments.length)) - 700;
  const blocks = attachments.map(attachment => {
    const report = reports.find(item => item.attachmentId === attachment.id);
    const items = evidence.filter(item => item.locator.attachmentId === attachment.id);
    const original = items.map(item => `[${item.title}]\n${item.statement}`).join('\n');
    const included = original.slice(0, budget);
    if (!documents.some(item => item.attachmentId === attachment.id) && report.modelContentEligible && !report.partial && !report.truncated) documents.push({ attachmentId: attachment.id, name: attachment.name, mimeType: attachment.mimeType, text: original });
    Object.assign(report, { name: attachment.name, extractedCharacters: original.length, includedCharacters: included.length, extractionComplete: Boolean(report.modelContentEligible && !report.partial && !report.truncated), contextTruncated: original.length > included.length, truncated: Boolean(report.truncated || original.length > included.length), rawImageEligible: false });
    if (report.missingPages?.length) report.partial = true;
    const limited = report.truncated || report.partial || !report.modelContentEligible;
    const notice = `${limited ? '【未完整读取】' : '【可引用摘录】'} ${report.reason || ''}${report.truncated ? '内容达到处理上限，后续未展示内容不能推断；请拆分或指定范围。' : ''}${report.missingPages?.length ? `未识别页面视觉内容：${report.missingPages.join(', ')}。` : ''}${(report.warnings || []).join(' ')}`;
    // Keep evidence no larger than the supplied context, rather than exposing a
    // huge parsed document in public API responses under an "excerpt" label.
    let remaining = budget;
    items.forEach(item => { const length = Math.min(remaining, item.statement.length); item.sourceContentHash = item.contentHash; item.statement = item.statement.slice(0, length); item.contentHash = createHash('sha256').update(item.statement).digest('hex'); remaining -= length; });
    return `[附件 ${attachment.name} | ${attachment.id}]\n${notice}\n${included}`;
  });
  const modelContext = blocks.join('\n');
  const result = {
    evidence,
    reports,
    quarantined,
    modelContext,
    summary: reports.length
      ? `内容级解析：${reports.filter((item) => item.status === 'content_scanned').length} 份材料可引用；${reports.filter((item) => item.status === 'quarantined').length} 份已隔离；${reports.filter((item) => !['content_scanned', 'quarantined'].includes(item.status)).length} 份未提供模型内容。`
      : '未上传多模态材料。'
  };
  Object.defineProperty(result, 'documents', { value: documents, enumerable: false });
  return result;
}
