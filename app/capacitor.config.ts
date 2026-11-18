import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Android shell. The WebView serves dist-web/ from https://localhost (androidScheme
 * "https"), which is also the origin your music server must allow via CORS.
 * WebView remote debugging is off unless NOCTURNE_DEBUG_WEBVIEW=1 at sync time.
 * Mixed content stays blocked unless NOCTURNE_LAN_HOSTS is set (development builds that
 * talk plain http to a LAN host; scripts/patch-android.mjs also whitelists those hosts).
 */
const config: CapacitorConfig = {
  appId: 'es.alexcloudweb.nocturne',
  appName: 'Nocturne',
  webDir: 'dist-web',
  backgroundColor: '#08080b',
  server: {
    androidScheme: 'https'
  },
  android: {
    allowMixedContent: Boolean(process.env['NOCTURNE_LAN_HOSTS']),
    webContentsDebuggingEnabled: process.env['NOCTURNE_DEBUG_WEBVIEW'] === '1',
    backgroundColor: '#08080b'
  },
  // iOS: WKWebView cannot serve https, so the app origin is capacitor://localhost (allowed by the
  // server's default NOCTURNE_CORS_ORIGINS). Background audio is configured in ios/App/App/AppDelegate.swift.
  ios: {
    backgroundColor: '#08080b'
  },
  plugins: {
    StatusBar: {
      overlaysWebView: true,
      style: 'DARK',
      backgroundColor: '#08080b'
    }
  }
}

export default config
