import { ApiError } from '../../api/errors'

/** A failure that means "cannot reach the server" (as opposed to the server answering with an error). */
export function isNetworkFailure(err: unknown): boolean {
  if (err instanceof ApiError) return err.code === 'network' || err.code === 'timeout'
  if (err instanceof TypeError) return /fetch|network|load failed/i.test(err.message)
  return false
}

export interface ConnectivityInput {
  /** `navigator.onLine`. */
  browser: boolean
  /** Native connectivity (Android ConnectivityManager); null when there is none. */
  native: boolean | null
  /** False after an API call failed with a network error, until one succeeds again. */
  apiReachable: boolean
}

/** Online = the OS says there is a network AND the server answered the last time we asked. */
export function computeOnline(i: ConnectivityInput): boolean {
  return (i.native ?? i.browser) && i.apiReachable
}
