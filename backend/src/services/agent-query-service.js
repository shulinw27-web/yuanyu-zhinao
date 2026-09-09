export const MAX_QUERY_BUSINESS_IDS = 10;

// Token boundaries matter: ORD-100 must not match ORD-1000. Require a digit
// to avoid treating ordinary hyphenated prose as an enterprise identifier.
export function extractQueryBusinessIds(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return [...new Set((text.toUpperCase().match(/\b[A-Z][A-Z0-9_]*(?:-[A-Z0-9_]+)+\b/g) || [])
    .filter((id) => /\d/.test(id) && !/^(?:MEMORY|TRACE|RUN)-/.test(id)))];
}

export function matchingQueryBusinessIds(value, businessIds) {
  const found = new Set(extractQueryBusinessIds(value));
  return businessIds.filter((id) => found.has(id));
}

export function validateAgentReadInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  if (Object.keys(input).some((key) => key !== 'businessIds')) return false;
  if (input.businessIds === undefined) return true;
  return Array.isArray(input.businessIds) && input.businessIds.length <= MAX_QUERY_BUSINESS_IDS
    && new Set(input.businessIds).size === input.businessIds.length
    && input.businessIds.every((id) => typeof id === 'string' && id.length <= 100 && extractQueryBusinessIds(id).length === 1 && extractQueryBusinessIds(id)[0] === id);
}

export function businessIdDomains(input) {
  const domains = new Set();
  for (const id of extractQueryBusinessIds(input)) {
    if (/^(?:RC|RM|RMB|PB|FG|INV|TR|EQ|EQP|EQPT|DEV)-/.test(id)) domains.add('production');
    if (/^(?:ORD|ORDER|SKU|STORE|COMPLAINT)-/.test(id)) domains.add('marketing');
    if (/^(?:SUP|SUPPLIER|PO|PR|BUDGET|CONTRACT)-/.test(id)) domains.add('internal');
  }
  return [...domains];
}

export function describeQueryCoverage(businessIds, matchedIds) {
  const matched = businessIds.filter((id) => matchedIds.includes(id));
  const missing = businessIds.filter((id) => !matchedIds.includes(id));
  return { schemaVersion: 'agent-query.v1', businessIds, matchedIds: matched, missingIds: missing,
    status: !businessIds.length ? 'overview' : !missing.length ? 'matched' : matched.length ? 'partial' : 'not_found_or_not_visible' };
}

export function validateAgentQueryAnswer(text, businessIds, evidence) {
  const permitted = new Set([...businessIds, ...extractQueryBusinessIds(evidence)]);
  const unsupportedIds = extractQueryBusinessIds(text).filter((id) => !permitted.has(id));
  return { valid: unsupportedIds.length === 0, unsupportedIds };
}

export function hasUnsupportedQueryTimeFilter(text) {
  const prose = String(text).replace(/\b[A-Z][A-Z0-9_]*(?:-[A-Z0-9_]+)+\b/giu, '');
  return /(?:今天|昨天|前天|明天|本周|本月|上周|上个月|上月|最近|最新|过去\s*\d+\s*(?:天|周|月)|近\s*\d+\s*(?:天|周|月)|\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b|20\d{2}年\d{1,2}月|\b(?:yesterday|today|latest)\b|\blast\s+(?:week|month|\d+\s+days)\b)/iu.test(prose);
}
