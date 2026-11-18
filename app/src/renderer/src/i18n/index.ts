import { useSyncExternalStore } from 'react'
import { en } from './en'
import { es } from './es'
import type { MessageKey } from './en'

export type { MessageKey } from './en'

/** Languages the UI ships. To add one: create `xx.ts` typed `Record<MessageKey, string>` and register it here. */
export const LANGUAGES = {
  en: { label: 'English', locale: 'en', messages: en as Record<MessageKey, string> },
  es: { label: 'Español', locale: 'es-ES', messages: es as Record<MessageKey, string> }
} as const

export type LanguageCode = keyof typeof LANGUAGES
/** What the user picked: 'system' follows `navigator.languages`. */
export type LanguagePref = 'system' | LanguageCode
export const LANGUAGE_PREFS: LanguagePref[] = ['system', ...(Object.keys(LANGUAGES) as LanguageCode[])]
export const DEFAULT_LANGUAGE: LanguageCode = 'en'

export type Params = Record<string, string | number>

export function isLanguageCode(v: unknown): v is LanguageCode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(LANGUAGES, v)
}

export function isLanguagePref(v: unknown): v is LanguagePref {
  return v === 'system' || isLanguageCode(v)
}

/** First supported language in the browser's preference list (base-language match), else English. */
export function detectLanguage(langs?: readonly string[]): LanguageCode {
  const list = langs ?? (typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [])
  for (const l of list) {
    const base = String(l ?? '').toLowerCase().split(/[-_]/)[0]
    if (isLanguageCode(base)) return base
  }
  return DEFAULT_LANGUAGE
}

export function resolveLanguage(pref: LanguagePref, langs?: readonly string[]): LanguageCode {
  return pref === 'system' ? detectLanguage(langs) : pref
}

let current: LanguageCode = DEFAULT_LANGUAGE
const listeners = new Set<() => void>()

export function getLanguage(): LanguageCode {
  return current
}

export function getLocale(): string {
  return LANGUAGES[current].locale
}

/** Applies a language preference: updates the active language, `<html lang>` and notifies subscribers. */
export function setLanguagePref(pref: LanguagePref): void {
  const next = resolveLanguage(pref)
  if (typeof document !== 'undefined') document.documentElement.lang = LANGUAGES[next].locale
  if (next === current) return
  current = next
  fmtCache.clear()
  listeners.forEach((l) => l())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

const fmtCache = new Map<string, Intl.NumberFormat | Intl.PluralRules>()

function nf(): Intl.NumberFormat {
  const k = `n:${getLocale()}`
  let f = fmtCache.get(k) as Intl.NumberFormat | undefined
  if (!f) fmtCache.set(k, (f = new Intl.NumberFormat(getLocale())))
  return f
}

function pr(): Intl.PluralRules {
  const k = `p:${getLocale()}`
  let f = fmtCache.get(k) as Intl.PluralRules | undefined
  if (!f) fmtCache.set(k, (f = new Intl.PluralRules(getLocale())))
  return f
}

/**
 * Translates `key`. `{name}` placeholders are replaced from `params` (numbers are formatted with the active
 * locale). A message may carry plural forms separated by `|` ("one|other"); the form is picked from
 * `params.count` with Intl.PluralRules (extra forms: "one|few|other" are not needed for en/es).
 */
export function translate(lang: LanguageCode, key: MessageKey, params?: Params): string {
  const raw = LANGUAGES[lang].messages[key] ?? en[key] ?? key
  let msg = raw
  if (params && typeof params.count === 'number' && raw.includes('|')) {
    const forms = raw.split('|')
    msg = pr().select(params.count) === 'one' ? (forms[0] ?? raw) : (forms[1] ?? forms[0] ?? raw)
  }
  if (!params) return msg
  return msg.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = params[name]
    return v === undefined ? m : typeof v === 'number' ? nf().format(v) : v
  })
}

export function t(key: MessageKey, params?: Params): string {
  return translate(current, key, params)
}

export type TFn = (key: MessageKey, params?: Params) => string

/** Subscribes the component to language changes; returns the translate function. */
export function useT(): TFn {
  useSyncExternalStore(subscribe, getLanguage, getLanguage)
  return t
}

/** Active language code as reactive state. */
export function useLanguage(): LanguageCode {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage)
}

/** Language names are shown in their own language. */
export function languageLabel(code: LanguageCode): string {
  return LANGUAGES[code].label
}

