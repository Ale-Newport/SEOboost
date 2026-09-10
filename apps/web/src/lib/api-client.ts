'use client';

/**
 * Browser-side fetch helpers.
 * Attaches the double-submit CSRF token so mutations pass `assertCsrf` on the server.
 */

function csrfToken(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)seo_os_csrf=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': csrfToken(),
      ...(init.headers ?? {}),
    },
  });

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload: unknown = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const body = (payload ?? {}) as { error?: string; code?: string; details?: unknown };
    throw new ApiError(
      body.error ?? `Request failed with status ${response.status}`,
      response.status,
      body.code ?? 'ERROR',
      body.details,
    );
  }
  return payload as T;
}

export const apiGet = <T>(url: string) => request<T>(url, { method: 'GET' });
export const apiPost = <T>(url: string, body: unknown) =>
  request<T>(url, { method: 'POST', body: JSON.stringify(body) });
export const apiPatch = <T>(url: string, body: unknown) =>
  request<T>(url, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDelete = <T>(url: string) => request<T>(url, { method: 'DELETE' });
