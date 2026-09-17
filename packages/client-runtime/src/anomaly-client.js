export function createAnomalyClient(request) {
  const base = '/agent/anomalies';
  return { list: () => request(base), create: body => request(base, { method: 'POST', body: JSON.stringify(body) }),
    change: (id, action, body) => {
      if (!['append', 'edit', 'extract', 'ask', 'reply', 'confirm', 'retract'].includes(action)) throw new TypeError('Unknown anomaly action');
      return request(`${base}/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
    } };
}
