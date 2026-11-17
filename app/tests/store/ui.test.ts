import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUi } from '@/store/ui'

const s = (): ReturnType<typeof useUi.getState> => useUi.getState()

beforeEach(() => {
  vi.useFakeTimers()
  useUi.setState({ panel: null, fullscreen: false, toasts: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('panels', () => {
  it('toggles panels on and off', () => {
    s().togglePanel('queue')
    expect(s().panel).toBe('queue')
    s().togglePanel('queue')
    expect(s().panel).toBeNull()
  })

  it('switches directly between panels', () => {
    s().togglePanel('queue')
    s().togglePanel('lyrics')
    expect(s().panel).toBe('lyrics')
  })

  it('closePanel closes whatever is open and is idempotent', () => {
    s().togglePanel('lyrics')
    s().closePanel()
    expect(s().panel).toBeNull()
    s().closePanel()
    expect(s().panel).toBeNull()
  })
})

describe('fullscreen', () => {
  it('sets the flag', () => {
    s().setFullscreen(true)
    expect(s().fullscreen).toBe(true)
    s().setFullscreen(false)
    expect(s().fullscreen).toBe(false)
  })
})

describe('toasts', () => {
  it('adds toasts with unique ids and the default info tone', () => {
    s().toast('hello')
    s().toast('world', 'error')
    const [a, b] = s().toasts
    expect(a).toMatchObject({ message: 'hello', tone: 'info' })
    expect(b).toMatchObject({ message: 'world', tone: 'error' })
    expect(a!.id).not.toBe(b!.id)
  })

  it('collapses duplicates of the same message, keeping the newest', () => {
    s().toast('same')
    const first = s().toasts[0]!.id
    s().toast('same')
    s().toast('same')
    expect(s().toasts).toHaveLength(1)
    expect(s().toasts[0]!.id).not.toBe(first)
  })

  it('keeps at most three toasts', () => {
    for (const m of ['a', 'b', 'c', 'd', 'e']) s().toast(m)
    expect(s().toasts.map((t) => t.message)).toEqual(['c', 'd', 'e'])
  })

  it('auto-dismisses info toasts after 3.5s', () => {
    s().toast('info')
    vi.advanceTimersByTime(3499)
    expect(s().toasts).toHaveLength(1)
    vi.advanceTimersByTime(2)
    expect(s().toasts).toHaveLength(0)
  })

  it('auto-dismisses error toasts after 6s', () => {
    s().toast('bad', 'error')
    vi.advanceTimersByTime(5999)
    expect(s().toasts).toHaveLength(1)
    vi.advanceTimersByTime(2)
    expect(s().toasts).toHaveLength(0)
  })

  it("an older timer does not remove a newer duplicate", () => {
    s().toast('dup')
    vi.advanceTimersByTime(3000)
    s().toast('dup') // replaces the first; first timer fires at 3.5s
    vi.advanceTimersByTime(600)
    expect(s().toasts.map((t) => t.message)).toEqual(['dup'])
    vi.advanceTimersByTime(3000)
    expect(s().toasts).toHaveLength(0)
  })

  it('dismissToast removes just that toast', () => {
    s().toast('a')
    s().toast('b')
    const [a] = s().toasts
    s().dismissToast(a!.id)
    expect(s().toasts.map((t) => t.message)).toEqual(['b'])
  })

  it('dismissing an unknown id is a no-op', () => {
    s().toast('a')
    s().dismissToast(-1)
    expect(s().toasts).toHaveLength(1)
  })

  it('a manually dismissed toast stays gone when its timer fires', () => {
    s().toast('a')
    s().dismissToast(s().toasts[0]!.id)
    s().toast('b')
    vi.advanceTimersByTime(3499)
    expect(s().toasts.map((t) => t.message)).toEqual(['b'])
  })
})
