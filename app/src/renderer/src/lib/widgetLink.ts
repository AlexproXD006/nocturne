/**
 * Deep links the Android home-screen widgets open the app with (explicit VIEW intents handled by
 * Capacitor's App plugin: `appUrlOpen`, and `getLaunchUrl` on a cold start). See WidgetRenderer.java.
 */
export type WidgetLink = 'player' | 'open'

const PREFIX = 'es.alexcloudweb.nocturne://widget/'

/** Maps a launch/open URL to a widget action; anything else (other schemes, junk) is null. */
export function parseWidgetLink(url: string | null | undefined): WidgetLink | null {
  if (typeof url !== 'string' || !url.startsWith(PREFIX)) return null
  const path = url.slice(PREFIX.length).split(/[?#]/)[0]?.replace(/\/+$/, '')
  return path === 'player' || path === 'open' ? path : null
}
