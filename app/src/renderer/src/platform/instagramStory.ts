import type { StoryPayload, StoryResult } from '../lib/instagramStory'

/**
 * JS side of the app-local Capacitor plugin `NocturneShare` (Android: .../share/NocturneSharePlugin.java,
 * iOS: App/NocturneShare.swift). `shareToInstagramStory` hands the sticker + background colours to
 * Instagram's "Add to story" flow and reports whether Instagram could be opened.
 */
export interface NocturneSharePlugin {
  shareToInstagramStory(options: { imageBase64: string; appId: string; topColor: string; bottomColor: string }): Promise<{
    opened?: boolean
    installed?: boolean
  }>
}

export type InstagramStoryShare = (payload: StoryPayload) => Promise<StoryResult>

function isCancel(err: unknown): boolean {
  const e = err as { message?: string } | null
  return /cancel/i.test(e?.message ?? '')
}

/** Wraps the (lazily registered) plugin: `not-installed` when Instagram is missing, errors propagate. */
export function createInstagramStoryShare(box: Promise<{ plugin: NocturneSharePlugin }>): InstagramStoryShare {
  return async (p) => {
    const { plugin } = await box
    try {
      const r = await plugin.shareToInstagramStory({
        imageBase64: p.imageBase64,
        appId: p.appId,
        topColor: p.top,
        bottomColor: p.bottom
      })
      if (r?.installed === false || r?.opened === false) return 'not-installed'
      return 'opened'
    } catch (err) {
      if (isCancel(err)) return 'cancelled'
      throw err
    }
  }
}
