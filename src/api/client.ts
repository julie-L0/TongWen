export type { Snapshot, Comparison } from '../../shared/contracts/workspace.ts';
export type ApiRequest = <T = any>(path: string, body?: unknown, method?: string, options?: { signal?: AbortSignal }) => Promise<T>;
export function createApiClient({
  baseUrl = '/api',
  transport = globalThis.fetch,
}: { baseUrl?: string; transport?: typeof fetch } = {}): ApiRequest {
  return async <T = any>(path: string, body?: unknown, method = 'POST', options?: { signal?: AbortSignal }): Promise<T> => {
    const response = await transport(baseUrl + path, {
      method: body === undefined ? 'GET' : method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options?.signal,
    });
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(data.error?.message || '操作失败'), { code: data.error?.code });
    return data;
  };
}
export const api = createApiClient();
export const requestId = () => crypto.randomUUID();
