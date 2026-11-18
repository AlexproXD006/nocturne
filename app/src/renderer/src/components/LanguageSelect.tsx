import type { ReactNode } from 'react'
import { LANGUAGES, languageLabel, useT, type LanguageCode, type LanguagePref } from '../i18n'
import { useSettings } from '../store/settings'

/** Language picker: "System default" (follows the browser/OS list) plus every shipped language by its own name. */
export function LanguageSelect({ className, id }: { className?: string; id?: string }): ReactNode {
  const t = useT()
  const language = useSettings((s) => s.language)
  const update = useSettings((s) => s.update)
  return (
    <select
      id={id}
      aria-label={t('login.language')}
      value={language}
      onChange={(e) => update({ language: e.currentTarget.value as LanguagePref })}
      className={className}
    >
      <option value="system">{t('lang.system')}</option>
      {(Object.keys(LANGUAGES) as LanguageCode[]).map((code) => (
        <option key={code} value={code}>
          {languageLabel(code)}
        </option>
      ))}
    </select>
  )
}
