/**
 * API client.
 *
 * One place that knows about the envelope, the active workspace header and
 * silent access-token refresh, so no component ever handles a raw fetch.
 */
import type { ApiResponse } from '@mail/shared';

const BASE = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isAuthError() {
    return this.status === 401;
  }
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) {
      for (const issue of this.details as Array<{ path: string; message: string }>) {
        if (issue?.path) out[issue.path] = issue.message;
      }
    }
    return out;
  }
}

let activeWorkspaceId: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setActiveWorkspace(id: string | null) {
  activeWorkspaceId = id;
  if (id) document.cookie = `mf_workspace=${id};path=/;max-age=31536000;samesite=lax`;
}

export function getActiveWorkspace() {
  return activeWorkspaceId;
}

export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Set false for the refresh call itself to avoid an infinite loop. */
  retryOnAuthFailure?: boolean;
  raw?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, retryOnAuthFailure = true, raw, headers, ...rest } = options;

  const isFormData = body instanceof FormData;
  const response = await fetch(`${BASE}/api${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      ...(isFormData ? {} : { 'content-type': 'application/json' }),
      ...(activeWorkspaceId ? { 'x-workspace-id': activeWorkspaceId } : {}),
      ...(headers ?? {}),
    },
    body: isFormData ? (body as FormData) : body === undefined ? undefined : JSON.stringify(body),
  });

  if (raw) return response as unknown as T;

  // A 401 on a normal call means the short-lived access token expired: rotate
  // it once with the refresh cookie and replay the request transparently.
  if (response.status === 401 && retryOnAuthFailure && !path.startsWith('/auth/refresh')) {
    const refreshed = await fetch(`${BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (refreshed.ok) return request<T>(path, { ...options, retryOnAuthFailure: false });
    onUnauthorized?.();
  }

  let payload: ApiResponse<T>;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError('NETWORK_ERROR', `Request failed with status ${response.status}`, response.status);
  }

  if (!response.ok || payload.success === false) {
    const error = payload.success === false ? payload.error : { code: 'UNKNOWN', message: 'Request failed' };
    throw new ApiError(error.code, error.message, response.status, (error as { details?: unknown }).details);
  }

  return payload.data;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'DELETE' }),
  upload: <T>(path: string, formData: FormData) => request<T>(path, { method: 'POST', body: formData }),
  download: async (path: string, filename: string) => {
    const response = await fetch(`${BASE}/api${path}`, {
      credentials: 'include',
      headers: activeWorkspaceId ? { 'x-workspace-id': activeWorkspaceId } : {},
    });
    if (!response.ok) throw new ApiError('DOWNLOAD_FAILED', 'Download failed', response.status);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },
};
