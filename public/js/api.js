async function parseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function request(route, { method = 'GET', body } = {}) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(route, options);
  } catch {
    throw new Error('网络请求失败，请检查服务是否在运行');
  }
  if (response.status === 401) {
    window.location.reload();
    throw new Error('登录状态失效');
  }
  const data = await parseBody(response);
  if (!response.ok) {
    throw new Error(data?.error || `请求失败（${response.status}）`);
  }
  return data;
}

export const api = {
  meta() {
    return request('/api/meta');
  },
  job(id) {
    return request(`/api/jobs/${encodeURIComponent(id)}`);
  },
  create(payload) {
    return request('/api/jobs', { method: 'POST', body: payload });
  },
  cancel(id) {
    return request(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  },
  async log(id) {
    let response;
    try {
      response = await fetch(`/api/jobs/${encodeURIComponent(id)}/log`);
    } catch {
      throw new Error('日志请求失败');
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`日志读取失败（${response.status}）`);
    return response.text();
  },
  eventsUrl(id) {
    return `/api/jobs/${encodeURIComponent(id)}/events`;
  },
  logUrl(id) {
    return `/api/jobs/${encodeURIComponent(id)}/log`;
  },
};
