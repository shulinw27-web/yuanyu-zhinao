// All authentication stays in the owning SDK's request function.
export function createKnowledgeClient(request, surface) {
  if (!['agent', 'semantic-operations'].includes(surface)) throw new TypeError('Unknown knowledge surface');
  const base = `/${surface}/knowledge-library`;
  const post = (path, body) => request(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
  const documentPath = id => `/documents/${encodeURIComponent(id)}`;
  return {
    list: () => request(base),
    studies: () => request(`${base}/studies`),
    study: (id, revision) => request(`${base}/studies/${encodeURIComponent(id)}${revision === undefined ? '' : `?revision=${encodeURIComponent(revision)}`}`),
    prepareStudy: body => post('/studies/prepare', body),
    restoreStudy: (id, body) => post(`/studies/${encodeURIComponent(id)}/restore`, body),
    saveStudy: (id, body) => request(`${base}/studies/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    providers: () => request(`${base}/providers`),
    answer: body => post('/answer', body),
    supplement: body => post('/answer-sources', body),
    proposeReadPlan: surface === 'semantic-operations' ? body => post('/read-plan-proposal', body) : undefined,
    jointBrief: surface === 'agent' ? body => post('/joint-brief', body) : undefined,
    jointPlans: surface === 'agent' ? () => request(`${base}/joint-plans`) : undefined,
    previewMaterial: body => post('/materials/preview', body),
    preview: text => post('/preview', { text }),
    save: (id, body) => request(`${base}${documentPath(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    read: (id, revision) => request(`${base}${documentPath(id)}?revision=${encodeURIComponent(revision)}`),
    retract: (id, expectedRevision) => post(`${documentPath(id)}/retract`, { expectedRevision }),
    brief: (query, provider) => post('/brief', { query, limit: 5, ...(provider ? { provider } : {}) }),
    citation: citation => post('/citation', citation)
  };
}
