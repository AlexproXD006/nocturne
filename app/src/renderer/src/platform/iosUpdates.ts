/**
 * iOS sideloads cannot self-install an update (no APK-style installer), so the update banner
 * sends the user to the release page, where the new unsigned .ipa is attached; AltStore /
 * SideStore users also get it through the source at ALTSTORE_SOURCE_URL.
 */
export const IOS_RELEASES_URL = 'https://github.com/AlexproXD006/nocturne/releases/latest'
export const IOS_BETA_RELEASES_URL = 'https://github.com/AlexproXD006/nocturne/releases'
export const ALTSTORE_SOURCE_URL = 'https://nocturne.alexcloudweb.es/altstore.json'

/** Where "Update now" goes on iOS. */
export function iosUpdateUrl(prerelease: boolean): string {
  return prerelease ? IOS_BETA_RELEASES_URL : IOS_RELEASES_URL
}
