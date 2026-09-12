import { inspectMultimodalInput, extractMultimodalEvidence } from './multimodal-input-service.js';
import { knowledgeFailure } from './knowledge-evidence-service.js';

export async function previewKnowledgeMaterial({ body, roleId, canRead }) {
  if (!body || Array.isArray(body) || body.confirmed !== true || Object.keys(body).some(key => !['attachments', 'confirmed'].includes(key))
    || !Array.isArray(body.attachments) || body.attachments.length !== 1) return knowledgeFailure('KNOWLEDGE_MATERIAL_INPUT_INVALID');
  if (!await canRead()) return knowledgeFailure('KNOWLEDGE_ACCESS_DENIED', 403);
  const inspected = inspectMultimodalInput(body, { id: roleId });
  if (inspected.error) return knowledgeFailure('KNOWLEDGE_MATERIAL_REJECTED');
  let parsed;
  try { parsed = await extractMultimodalEvidence(inspected.attachments); }
  catch { return knowledgeFailure('KNOWLEDGE_MATERIAL_PARSE_FAILED', 422); }
  if (!await canRead()) return knowledgeFailure('KNOWLEDGE_ACCESS_DENIED', 403);
  if (parsed.quarantined.length) return knowledgeFailure('KNOWLEDGE_MATERIAL_QUARANTINED', 422);
  return { mode: 'material_review_not_persisted', persisted: false, published: false, summary: parsed.summary, reports: parsed.reports,
    items: parsed.evidence.filter(item => item.statement).map(item => ({ id: item.id, title: item.title, text: item.statement,
      locator: item.locator, contentHash: item.contentHash, confidence: item.confidence })),
    notice: '只有解析器提供的位置可用于定位；未返回图像区域时不生成坐标。校对结果保存为人工参考资料，不覆盖原文件。' };
}
