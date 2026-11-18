import { fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it } from 'vitest'
import { FastScroll } from '@/components/FastScroll'

function Harness({ count, letterAt }: { count: number; letterAt?: (i: number) => string }) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div data-testid="scroller" style={{ overflowY: 'auto' }}>
      <div ref={ref}>
        <FastScroll anchorRef={ref} count={count} letterAt={letterAt} />
      </div>
    </div>
  )
}

function mockLayout(): HTMLElement {
  const el = screen.getByTestId('scroller')
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 10000 })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 800 })
  el.getBoundingClientRect = () => ({ top: 0, left: 0, right: 400, bottom: 800, width: 400, height: 800, x: 0, y: 0, toJSON: () => ({}) })
  fireEvent.scroll(el)
  return el
}

describe('FastScroll', () => {
  it('renders nothing for short lists', () => {
    render(<Harness count={10} />)
    expect(screen.queryByRole('scrollbar', { hidden: true })).toBeNull()
  })

  it('exposes an accessible scrollbar for long lists', () => {
    render(<Harness count={1795} />)
    mockLayout()
    const bar = screen.getByRole('scrollbar', { hidden: true })
    expect(bar.getAttribute('aria-valuemin')).toBe('1')
    expect(bar.getAttribute('aria-valuemax')).toBe('1795')
    expect(bar.getAttribute('aria-label')).toBeTruthy()
  })

  it('dragging the handle scrolls proportionally and shows the bubble', () => {
    render(<Harness count={1795} />)
    const el = mockLayout()
    const bar = screen.getByRole('scrollbar', { hidden: true })
    fireEvent.pointerDown(bar, { clientY: 72 + 28, pointerId: 1, button: 0 })
    // track = 800-72-20 = 708, thumb 56 => travel 652; move to the end
    fireEvent.pointerMove(bar, { clientY: 72 + 28 + 652, pointerId: 1 })
    expect(el.scrollTop).toBe(10000 - 800)
    expect(bar.getAttribute('aria-valuenow')).toBe('1795')
    expect(document.body.textContent).toContain('1,795 / 1,795')
    fireEvent.pointerUp(bar, { pointerId: 1 })
  })

  it('shows the letter when sorted alphabetically', () => {
    render(<Harness count={100} letterAt={(i) => (i < 50 ? 'A' : 'M')} />)
    mockLayout()
    const bar = screen.getByRole('scrollbar', { hidden: true })
    fireEvent.pointerDown(bar, { clientY: 100, pointerId: 1, button: 0 })
    fireEvent.pointerMove(bar, { clientY: 100 + 652, pointerId: 1 })
    expect(document.body.textContent).toContain('M')
    expect(document.body.textContent).not.toContain('/')
  })

  it('keyboard End/Home scroll the list', () => {
    render(<Harness count={500} />)
    const el = mockLayout()
    const bar = screen.getByRole('scrollbar', { hidden: true })
    fireEvent.keyDown(bar, { key: 'End' })
    expect(el.scrollTop).toBe(10000)
    fireEvent.keyDown(bar, { key: 'Home' })
    expect(el.scrollTop).toBe(0)
  })
})
