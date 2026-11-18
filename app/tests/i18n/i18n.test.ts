import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '@/i18n/en'
import { es } from '@/i18n/es'
import { LANGUAGES, detectLanguage, getLanguage, getLocale, resolveLanguage, setLanguagePref, t, translate } from '@/i18n'
import { formatDate, formatList, formatNumber, formatRelative } from '@/i18n/format'
import { formatTotal, greeting } from '@/lib/format'
import { formatMinutes } from '@/lib/stats'

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()

afterEach(() => setLanguagePref('en'))

describe('catalogues', () => {
  it('es has exactly the keys of en (no missing, no extra)', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort())
  })

  it('every registered language covers every key', () => {
    for (const [code, lang] of Object.entries(LANGUAGES)) {
      expect(Object.keys(lang.messages).sort(), code).toEqual(Object.keys(en).sort())
    }
  })

  it('has no empty strings and keeps placeholders and plural forms in sync with en', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(es[key].trim(), key).not.toBe('')
      expect(placeholders(es[key]), `${key} placeholders`).toEqual(placeholders(en[key]))
      expect(es[key].split('|').length, `${key} plural forms`).toBe(en[key].split('|').length)
    }
  })

  it('uses the agreed Spanish terminology', () => {
    expect(es['nav.libraryShort']).toBe('Biblioteca')
    expect(es['nav.likedSongs']).toBe('Canciones que te gustan')
    expect(es['app.queue']).toBe('Cola')
    expect(es['queue.nextUp']).toBe('A continuación')
    expect(es['ctl.play']).toBe('Reproducir')
    expect(es['ctl.shuffleOn']).toContain('aleatorio')
    expect(es['app.lyrics']).toBe('Letras')
    expect(es['player.devices']).toBe('Dispositivos')
    expect(es['nav.settings']).toBe('Ajustes')
    expect(es['nav.stats']).toBe('Estadísticas')
  })
})

describe('t()', () => {
  it('translates and interpolates', () => {
    expect(t('card.play', { title: 'Song' })).toBe('Play Song')
    setLanguagePref('es')
    expect(t('card.play', { title: 'Song' })).toBe('Reproducir Song')
  })

  it('leaves unknown placeholders untouched and ignores extra params', () => {
    expect(translate('en', 'card.play', {})).toBe('Play {title}')
    expect(translate('en', 'card.play', { title: 'A', other: 'B' })).toBe('Play A')
  })

  it('picks plural forms from count (en and es)', () => {
    expect(t('common.song', { count: 1 })).toBe('1 song')
    expect(t('common.song', { count: 0 })).toBe('0 songs')
    expect(t('common.song', { count: 2 })).toBe('2 songs')
    setLanguagePref('es')
    expect(t('common.song', { count: 1 })).toBe('1 canción')
    expect(t('common.song', { count: 5 })).toBe('5 canciones')
  })

  it('formats numeric params with the active locale', () => {
    expect(t('common.song', { count: 1234 })).toBe('1,234 songs')
    setLanguagePref('es')
    expect(t('common.song', { count: 12345 })).toBe('12.345 canciones')
  })

  it('falls back to English when a language lacks a key', () => {
    const key = 'common.cancel' as const
    const saved = LANGUAGES.es.messages[key]
    ;(LANGUAGES.es.messages as Record<string, string | undefined>)[key] = undefined
    try {
      expect(translate('es', key)).toBe('Cancel')
    } finally {
      ;(LANGUAGES.es.messages as Record<string, string>)[key] = saved
    }
  })
})

describe('language selection', () => {
  it('detects the first supported language from the browser list', () => {
    expect(detectLanguage(['es-ES', 'en'])).toBe('es')
    expect(detectLanguage(['fr-FR', 'es-MX', 'en-US'])).toBe('es')
    expect(detectLanguage(['en-GB'])).toBe('en')
    expect(detectLanguage(['de', 'fr'])).toBe('en')
    expect(detectLanguage([])).toBe('en')
  })

  it('resolves "system" through the detection and passes explicit choices through', () => {
    expect(resolveLanguage('system', ['es'])).toBe('es')
    expect(resolveLanguage('en', ['es'])).toBe('en')
    expect(resolveLanguage('es', ['en'])).toBe('es')
  })

  it('setLanguagePref updates the active locale and <html lang>', () => {
    setLanguagePref('es')
    expect(getLanguage()).toBe('es')
    expect(getLocale()).toBe('es-ES')
    expect(document.documentElement.lang).toBe('es-ES')
    setLanguagePref('en')
    expect(document.documentElement.lang).toBe('en')
  })
})

describe('startup', () => {
  it('applies the saved language preference (and <html lang>) when the settings store loads', async () => {
    localStorage.setItem('nocturne.settings.v1', JSON.stringify({ language: 'es' }))
    vi.resetModules()
    const i18n = await import('@/i18n')
    await import('@/store/settings')
    expect(i18n.getLanguage()).toBe('es')
    expect(document.documentElement.lang).toBe('es-ES')
  })

  it('"system" follows navigator.languages', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['es-ES', 'en'])
    vi.resetModules()
    const i18n = await import('@/i18n')
    await import('@/store/settings')
    expect(i18n.getLanguage()).toBe('es')
  })
})

describe('Intl helpers follow the active locale', () => {
  it('formats numbers, dates, relative time and lists', () => {
    expect(formatNumber(1234567)).toBe('1,234,567')
    expect(formatDate('2026-11-16T12:00:00Z', { month: 'long', year: 'numeric', timeZone: 'UTC' })).toBe('November 2026')
    expect(formatRelative(300)).toMatch(/5 min/)
    expect(formatList(['a', 'b', 'c'])).toBe('a, b, and c')
    setLanguagePref('es')
    expect(formatNumber(1234567)).toBe('1.234.567')
    expect(formatDate('2026-11-16T12:00:00Z', { month: 'long', year: 'numeric', timeZone: 'UTC' })).toBe('noviembre de 2026')
    expect(formatRelative(300)).toMatch(/^hace 5 min/)
    expect(formatList(['a', 'b', 'c'])).toBe('a, b y c')
  })

  it('formats durations and greetings in both languages', () => {
    expect(formatTotal(3600 + 12 * 60)).toBe('1 hr 12 min')
    expect(formatMinutes(135)).toBe('2 h 15 min')
    expect(greeting(9)).toBe('Good morning')
    setLanguagePref('es')
    expect(formatTotal(3600 + 12 * 60)).toBe('1 h 12 min')
    expect(formatMinutes(135)).toBe('2 h 15 min')
    expect(greeting(9)).toBe('Buenos días')
    expect(greeting(20)).toBe('Buenas noches')
  })
})
