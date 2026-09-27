// Thin wrapper over fetch for the JSON API.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, url, body) {
  const options = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && api.onUnauthorized) api.onUnauthorized();
    throw new ApiError(res.status, data.error || `Ошибка ${res.status}`);
  }
  return data;
}

function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) q.set(k, v === true ? '1' : v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const api = {
  onUnauthorized: null,
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  patch: (url, body) => request('PATCH', url, body),
  put: (url, body = {}) => request('PUT', url, body),
  del: (url, body) => request('DELETE', url, body),
  query,

  // Multipart upload with progress reporting (fetch has no upload progress).
  upload(form, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/media');
      xhr.responseType = 'json';
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
        else reject(new ApiError(xhr.status, xhr.response?.error || `Ошибка ${xhr.status}`));
      };
      xhr.onerror = () => reject(new ApiError(0, 'Сеть недоступна'));
      xhr.send(form);
    });
  },
};
