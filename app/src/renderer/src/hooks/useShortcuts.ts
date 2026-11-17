import { useEffect } from 'react'
import { playback } from '../services'
import { useUi } from '../store/ui'
import { useNav } from '../store/nav'

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/** Global keyboard shortcuts. See Settings → Shortcuts for the list. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        useNav.getState().go({ name: 'search' })
        requestAnimationFrame(() => document.getElementById('search-input')?.focus())
        return
      }
      if (isTyping(e.target) || e.altKey || mod) return
      const p = playback
      const ui = useUi.getState()
      switch (e.key) {
        case ' ':
          if ((e.target as HTMLElement)?.tagName === 'BUTTON') return
          e.preventDefault()
          p.toggle()
          break
        case 'ArrowRight':
          e.preventDefault()
          if (e.shiftKey) void p.next()
          else p.seek(p.position() + 5)
          break
        case 'ArrowLeft':
          e.preventDefault()
          if (e.shiftKey) void p.previous()
          else p.seek(Math.max(0, p.position() - 5))
          break
        case 'ArrowUp':
          e.preventDefault()
          p.setVolume(p.volume() + 0.05)
          break
        case 'ArrowDown':
          e.preventDefault()
          p.setVolume(p.volume() - 0.05)
          break
        case 'm':
        case 'M':
          p.toggleMute()
          break
        case 'l':
        case 'L':
          ui.togglePanel('lyrics')
          break
        case 'q':
        case 'Q':
          ui.togglePanel('queue')
          break
        case 'f':
        case 'F':
          if (p.hasItem()) ui.setFullscreen(!ui.fullscreen)
          break
        case 's':
        case 'S':
          p.setShuffle(!p.shuffle())
          break
        case 'r':
        case 'R':
          p.cycleRepeat()
          break
        case '/':
          e.preventDefault()
          useNav.getState().go({ name: 'search' })
          requestAnimationFrame(() => document.getElementById('search-input')?.focus())
          break
        case 'Escape':
          if (ui.fullscreen) ui.setFullscreen(false)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
