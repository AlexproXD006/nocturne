import { useRef, type KeyboardEvent, type ReactNode } from 'react'

export interface TabDef<T extends string> {
  id: T
  label: string
  icon?: ReactNode
}

export function tabDomId(prefix: string, id: string): string {
  return `${prefix}-tab-${id}`
}
export function panelDomId(prefix: string): string {
  return `${prefix}-panel`
}

/** WAI-ARIA tab bar with roving tabindex and arrow / Home / End keys. Scrolls sideways on narrow screens. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix
}: {
  tabs: TabDef<T>[]
  value: T
  onChange: (id: T) => void
  label: string
  idPrefix: string
}): ReactNode {
  const refs = useRef(new Map<T, HTMLButtonElement>())

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = tabs.findIndex((t) => t.id === value)
    let next = -1
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    if (next < 0) return
    e.preventDefault()
    const id = tabs[next]!.id
    onChange(id)
    refs.current.get(id)?.focus()
  }

  return (
    <div className="hide-scrollbar -mx-4 overflow-x-auto px-4 md:mx-0 md:overflow-visible md:px-0">
      <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="inline-flex min-w-full gap-1 border-b border-line md:flex md:min-w-0 md:flex-wrap">
        {tabs.map((t) => {
          const selected = t.id === value
          return (
            <button
              key={t.id}
              ref={(el) => {
                if (el) refs.current.set(t.id, el)
                else refs.current.delete(t.id)
              }}
              type="button"
              role="tab"
              id={tabDomId(idPrefix, t.id)}
              aria-selected={selected}
              aria-controls={panelDomId(idPrefix)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t.id)}
              className={`relative inline-flex shrink-0 items-center gap-2 px-3.5 py-3 text-sm font-semibold whitespace-nowrap transition-colors ${
                selected ? 'text-fg' : 'text-fg-muted hover:text-fg'
              }`}
            >
              {t.icon && <span className="[&>svg]:h-4 [&>svg]:w-4" aria-hidden>{t.icon}</span>}
              {t.label}
              {selected && <span aria-hidden className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
