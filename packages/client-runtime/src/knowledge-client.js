// All authentication stays in the owning SDK's request function.
export function createKnowledgeClient(request, surface) {
  if (!['agent', 'semantic-operations'].includes(surface)) throw new TypeError('Unknown knowledge surface');
  const base = `/${surface}/knowledge-library`;
  const post = (path, body) => request(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
  const documentPath = id => `/documents/${encodeURIComponent(id)}`;
  return {
    list: () => request(base),
    modelLinks: surface === 'semantic-operations' ? () => request(`${base}/model-links`) : undefined,
    materialReviews: surface === 'semantic-operations' ? (offset = 0) => request(`${base}/material-reviews?${new URLSearchParams({ offset })}`) : undefined,
    materialReview: surface === 'semantic-operations' ? id => request(`${base}/material-reviews/${encodeURIComponent(id)}`) : undefined,
    materialReviewHistory: surface === 'semantic-operations' ? (offset = 0) => request(`${base}/material-reviews/history?${new URLSearchParams({ offset })}`) : undefined,
    materialReviewers: surface === 'semantic-operations' ? () => request(`${base}/material-reviews/reviewers`) : undefined,
    assignMaterialReview: surface === 'semantic-operations' ? (id, expectedRevision, subjectId) => post(`/material-reviews/${encodeURIComponent(id)}/assignment`, { expectedRevision, subjectId, confirmed: true }) : undefined,
    archiveMaterialReview: surface === 'semantic-operations' ? (id, expectedRevision) => post(`/material-reviews/${encodeURIComponent(id)}/archive`, { expectedRevision, confirmed: true }) : undefined,
    submitMaterialReview: surface === 'semantic-operations' ? citations => post('/material-reviews', { citations, confirmed: true }) : undefined,
    decideMaterialReview: surface === 'semantic-operations' ? (id, expectedRevision, decision, note) => post(`/material-reviews/${encodeURIComponent(id)}/decision`, { expectedRevision, decision, confirmed: true, ...(note === undefined ? {} : { note }) }) : undefined,
    modelViews: surface === 'semantic-operations' ? () => request(`${base}/model-views`) : undefined,
    modelView: surface === 'semantic-operations' ? id => request(`${base}/model-views/${encodeURIComponent(id)}`) : undefined,
    saveModelView: surface === 'semantic-operations' ? body => post('/model-views', body) : undefined,
    teamModelViews: surface === 'semantic-operations' ? () => request(`${base}/team-model-views`) : undefined,
    teamModelView: surface === 'semantic-operations' ? id => request(`${base}/team-model-views/${encodeURIComponent(id)}`) : undefined,
    shareModelView: surface === 'semantic-operations' ? (id, body) => post(`/model-views/${encodeURIComponent(id)}/share`, body) : undefined,
    retractTeamModelView: surface === 'semantic-operations' ? (id, expectedRevision) => post(`/team-model-views/${encodeURIComponent(id)}/retract`, { expectedRevision }) : undefined,
    teamModelHistory: surface === 'semantic-operations' ? (offset = 0, limit = 20) => request(`${base}/team-model-views/history?${new URLSearchParams({ offset, limit })}`) : undefined,
    archiveTeamModelView: surface === 'semantic-operations' ? (id, expectedRevision) => post(`/team-model-views/${encodeURIComponent(id)}/archive`, { expectedRevision }) : undefined,
    saveModelLink: surface === 'semantic-operations' ? body => post('/model-links', body) : undefined,
    suggestModelLinks: surface === 'semantic-operations' ? body => post('/model-links/suggest', body) : undefined,
    retractModelLink: surface === 'semantic-operations' ? (id, expectedRevision) => post(`/model-links/${encodeURIComponent(id)}/retract`, { expectedRevision }) : undefined,
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
