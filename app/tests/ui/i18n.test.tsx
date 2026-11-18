import { describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LanguageSelect } from '@/components/LanguageSelect'
import { ErrorState } from '@/components/common'
import { useT, setLanguagePref } from '@/i18n'
import { useSettings } from '@/store/settings'

function Probe(): React.ReactNode {
  const t = useT()
  return (
    <div>
      <p data-testid="msg">{t('common.song', { count: 2 })}</p>
      <ErrorState message="x" onRetry={() => undefined} />
    </div>
  )
}

describe('language switching (render)', () => {
  it('re-renders translated text when the language changes', () => {
    render(<Probe />)
    expect(screen.getByTestId('msg')).toHaveTextContent('2 songs')
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
    act(() => setLanguagePref('es'))
    expect(screen.getByTestId('msg')).toHaveTextContent('2 canciones')
    expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument()
  })

  it('the Settings selector switches the UI, persists the choice and updates <html lang>', async () => {
    render(
      <>
        <LanguageSelect />
        <Probe />
      </>
    )
    const select = screen.getByRole('combobox')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['System default', 'English', 'Español'])
    await userEvent.selectOptions(select, 'es')
    expect(useSettings.getState().language).toBe('es')
    expect(JSON.parse(localStorage.getItem('nocturne.settings.v1')!).language).toBe('es')
    expect(document.documentElement.lang).toBe('es-ES')
    expect(screen.getByTestId('msg')).toHaveTextContent('2 canciones')
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Predeterminado del sistema')
    await userEvent.selectOptions(select, 'system')
    expect(useSettings.getState().language).toBe('system')
    act(() => useSettings.getState().update({ language: 'en' }))
    expect(document.documentElement.lang).toBe('en')
    expect(screen.getByTestId('msg')).toHaveTextContent('2 songs')
  })
})
