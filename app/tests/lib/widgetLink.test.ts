import { describe, expect, it } from 'vitest'
import { parseWidgetLink } from '../../src/renderer/src/lib/widgetLink'

describe('parseWidgetLink', () => {
  it('recognises the widget deep links', () => {
    expect(parseWidgetLink('es.alexcloudweb.nocturne://widget/player')).toBe('player')
    expect(parseWidgetLink('es.alexcloudweb.nocturne://widget/open')).toBe('open')
    expect(parseWidgetLink('es.alexcloudweb.nocturne://widget/player/?x=1#y')).toBe('player')
  })
  it('ignores everything else', () => {
    expect(parseWidgetLink(undefined)).toBeNull()
    expect(parseWidgetLink(null)).toBeNull()
    expect(parseWidgetLink('')).toBeNull()
    expect(parseWidgetLink('https://example.com/widget/player')).toBeNull()
    expect(parseWidgetLink('es.alexcloudweb.nocturne://widget/other')).toBeNull()
    expect(parseWidgetLink('es.alexcloudweb.nocturne://other/player')).toBeNull()
  })
})
