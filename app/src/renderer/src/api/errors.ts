import { t } from '../i18n'

export type ApiErrorCode =
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'server'
  | 'bad_response'
  | 'bad_request'

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status = 0,
    readonly retryAfter?: number
  ) {
    super(message)
    this.name = 'ApiError'
  }

  static fromStatus(status: number, message?: string, retryAfter?: number): ApiError {
    const code: ApiErrorCode =
      status === 401 ? 'unauthorized'
      : status === 403 ? 'forbidden'
      : status === 404 ? 'not_found'
      : status === 429 ? 'rate_limited'
      : status >= 500 ? 'server'
      : 'bad_request'
    return new ApiError(code, message || defaultMessage(code), status, retryAfter)
  }
}

function defaultMessage(code: ApiErrorCode): string {
  switch (code) {
    case 'unauthorized': return t('err.sessionExpired')
    case 'forbidden': return t('err.forbidden')
    case 'not_found': return t('err.notFound')
    case 'rate_limited': return t('err.rateLimited')
    case 'server': return t('err.server')
    default: return t('err.generic')
  }
}

export function isAbort(err: unknown): boolean {
  return err instanceof ApiError ? err.code === 'aborted' : err instanceof DOMException && err.name === 'AbortError'
}

/** Human friendly message for any thrown value. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error && err.message) return err.message
  return t('err.generic')
}
