const normalize = (value) => String(value || '').trim();

const matchesRule = (event, rule) => {
  const match = rule.match || {};
  if (match.sourceSystems?.length && !match.sourceSystems.includes(normalize(event.sourceSystem).toUpperCase())) return false;
  if (match.eventTypes?.length && !match.eventTypes.includes(normalize(event.eventType))) return false;
  if (Number.isFinite(match.minimumAffectedOrders) && Number(event.affectedOrders || 0) < match.minimumAffectedOrders) return false;
  return true;
};

export function classifyAlert(event, rules, severityLevels) {
  const enabledLevels = new Set((severityLevels || []).filter((item) => item.enabled).map((item) => item.id));
  const selectedRule = [...(rules || [])]
    .filter((rule) => rule.enabled && enabledLevels.has(rule.resultSeverity))
    .sort((left, right) => right.priority - left.priority)
    .find((rule) => matchesRule(event, rule));
  const requestedSeverity = normalize(event.rawSeverity).toUpperCase();
  const severity = requestedSeverity === 'P0' && enabledLevels.has('P0')
    ? 'P0'
    : selectedRule?.resultSeverity || (enabledLevels.has('P2') ? 'P2' : [...enabledLevels][0]);
  const level = (severityLevels || []).find((item) => item.id === severity);
  return {
    severity,
    level: level ? structuredClone(level) : null,
    ruleId: requestedSeverity === 'P0' ? 'upstream-p0-signal' : selectedRule?.id || null,
    ruleName: requestedSeverity === 'P0' ? '上游可信 P0 信号' : selectedRule?.name || '未匹配规则',
    evaluatedAt: new Date().toISOString(),
    input: {
      sourceSystem: normalize(event.sourceSystem).toUpperCase(),
      eventType: normalize(event.eventType),
      affectedOrders: Math.max(0, Number(event.affectedOrders || 0))
    }
  };
}
