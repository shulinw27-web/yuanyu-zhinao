let csrf = '';
export const setCsrf = value => { csrf = value || ''; };
export async function portalRequest(path, body) {
  const response = await fetch(`/api/portal/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Client': 'web', ...(body === undefined ? {} : { 'X-CSRF-Token': csrf }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.code), { code: data.code, status: response.status });
  if (data.csrfToken) setCsrf(data.csrfToken);
  return data;
}
