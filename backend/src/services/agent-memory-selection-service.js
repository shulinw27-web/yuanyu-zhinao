// Retrieval is performed only after the store has filtered tenant, subject,
// role, expiry and memory admission. Past goals never authorize new writes.
export function selectAgentGoalMemory(input, candidates) {
  const text = String(input || '').toUpperCase();
  const businessIds = [...new Set(text.match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g) || [])];
  const selectedById = candidates.filter((item) => item.id && businessIds.includes(item.id.toUpperCase()));
  const matches = selectedById.length ? selectedById : businessIds.length
    ? candidates.filter((item) => {
        const identifiers = new Set(String(item.content || item.summary || '').toUpperCase().match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g) || []);
        return businessIds.every((id) => identifiers.has(id));
      })
    : candidates;
  // Two goals in the SAME domain can still concern different cases. Recency
  // is a presentation order, not evidence that the user chose a task.
  return { selected: matches.length === 1 ? matches : [], ambiguous: matches.length > 1, candidates: matches };
}
