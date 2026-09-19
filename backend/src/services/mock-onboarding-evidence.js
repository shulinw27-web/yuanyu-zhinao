// Exact-text provenance only. A matching quote does not prove the business rule.
const supported = new Set(['requirements', 'api', 'dictionary', 'rules']);
export function validateMockAlignmentEvidence(config, materials, { requireAll = false } = {}) {
  const issues = [];
  for (const category of ['identities', 'units', 'states']) for (const [index, rule] of (config?.[category] || []).entries()) {
    const path = `${category}[${index}].materialEvidence`;
    const ref = rule.materialEvidence;
    const add = (code, message) => issues.push({ code, path, message });
    if (ref === undefined) { if (requireAll) add('EVIDENCE_REQUIRED', '此规则尚未绑定原始材料摘录。'); continue; }
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).some(key => !['kind', 'digest', 'quote'].includes(key))
      || !supported.has(ref.kind) || !/^[a-f0-9]{64}$/u.test(ref.digest || '') || typeof ref.quote !== 'string'
      || ref.quote.trim().length < 12 || ref.quote.length > 2000) { add('EVIDENCE_INVALID', '需选择材料版本及 12–2000 字符的原文摘录，不接受样本记录或自定义文件地址。'); continue; }
    const material = materials[ref.kind];
    if (!material || material.digest !== ref.digest) { add('EVIDENCE_STALE', '材料版本已变化或不存在，请重新核对并绑定摘录。'); continue; }
    if (!material.text.includes(ref.quote)) add('EVIDENCE_QUOTE_NOT_FOUND', '摘录不在当前材料原文中，请原样引用，不要改写。');
  }
  return issues.slice(0, 100);
}

export function mockAlignmentEvidenceSources(materials) {
  return [...supported].filter(kind => materials[kind]).map(kind => ({ kind, name: materials[kind].name, digest: materials[kind].digest, text: materials[kind].text }));
}
