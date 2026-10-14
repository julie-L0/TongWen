import { AppError } from '../domain/rules.ts';

// Only transient request failures; auth, quota, invalid output and cancellation
// require a different recovery action and must never trigger another request.
export function retryableModelError(error: unknown) {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError') return true;
  if (error instanceof AppError)
    return ['MODEL_HTTP_429', 'MODEL_HTTP_500', 'MODEL_HTTP_502', 'MODEL_HTTP_503', 'MODEL_HTTP_504'].includes(error.code);
  const code = (error.cause as { code?: string } | undefined)?.code;
  return error instanceof TypeError && !!code &&
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(code);
}
