import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The theme ids are read from the source (importing the store would drag the DOM into this node-side project).
const settings = readFileSync('src/renderer/src/store/settings.ts', 'utf8')
const THEMES = [...settings.matchAll(/\{ id: '(\w+)', labelKey: 'theme\.\w+' \}/g)].map((m) => ({ id: m[1] as string }))

describe('native widget themes mirror the app themes', () => {
  it('found the app themes', () => {
    expect(THEMES.length).toBe(12)
  })
  const java = readFileSync('android/app/src/main/java/es/alexcloudweb/nocturne/widget/WidgetThemes.java', 'utf8')
  it('knows every selectable app theme (Adaptive is cover-driven natively)', () => {
    for (const t of THEMES) {
      if (t.id === 'adaptive') expect(java).toContain('ADAPTIVE = "adaptive"')
      else expect(java, t.id).toMatch(new RegExp(`new Theme\\((?:"${t.id}"|[A-Z_]+)`))
    }
  })
  it('has a label for every theme in both languages', () => {
    for (const lang of ['values', 'values-es']) {
      const xml = readFileSync(`android/app/src/main/res/${lang}/nocturne_widget_strings.xml`, 'utf8')
      for (const t of THEMES) if (t.id !== 'adaptive') expect(xml, `${lang}/${t.id}`).toContain(`name="widget_theme_${t.id}"`)
    }
  })
})
