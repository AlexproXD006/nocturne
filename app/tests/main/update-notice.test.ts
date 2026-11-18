// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseUpdateNotice } from '../../src/main/update-notice'

describe('parseUpdateNotice (IPC payload validation)', () => {
  it('accepts a version + http(s) URL and builds the notification text', () => {
    expect(parseUpdateNotice({ version: ' 1.2.3-beta.1 ', url: 'https://music.example.com/dl/app.exe' })).toEqual({
      version: '1.2.3-beta.1',
      url: 'https://music.example.com/dl/app.exe',
      title: 'Nocturne 1.2.3-beta.1 available',
      body: 'Click to download the update'
    })
  })

  it('localises the text from the renderer locale (es-ES -> Spanish, unknown -> English)', () => {
    const base = { version: '1.2.3', url: 'https://music.example.com/dl/app.exe' }
    expect(parseUpdateNotice({ ...base, locale: 'es-ES' })).toMatchObject({ title: 'Nocturne 1.2.3 disponible', body: 'Haz clic para descargar la actualización' })
    expect(parseUpdateNotice({ ...base, locale: 'fr' })).toMatchObject({ title: 'Nocturne 1.2.3 available' })
    expect(parseUpdateNotice({ ...base, locale: 42 })).toMatchObject({ title: 'Nocturne 1.2.3 available' })
  })

  it('rejects junk', () => {
    for (const bad of [
      null,
      'x',
      {},
      { version: 1, url: 'https://a.b' },
      { version: '1.0.0' },
      { version: '1.0.0', url: 'file:///etc/passwd' },
      { version: '1.0.0', url: 'javascript:alert(1)' },
      { version: '<script>', url: 'https://a.b' },
      { version: 'x'.repeat(65), url: 'https://a.b' }
    ]) {
      expect(parseUpdateNotice(bad)).toBeNull()
    }
  })
})
