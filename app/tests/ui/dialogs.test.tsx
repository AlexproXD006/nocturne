import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Tabs } from '@/components/Tabs'

describe('ConfirmDialog', () => {
  it('is an accessible modal dialog, focuses Cancel and closes on Escape', async () => {
    const onClose = vi.fn()
    render(<ConfirmDialog title="Delete it?" message="Gone forever" onConfirm={() => undefined} onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: 'Delete it?' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleDescription('Gone forever')
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('traps focus with Tab and Shift+Tab', async () => {
    render(<ConfirmDialog title="T" message="m" confirmLabel="Yes" onConfirm={() => undefined} onClose={() => undefined} />)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const yes = screen.getByRole('button', { name: 'Yes' })
    expect(cancel).toHaveFocus()
    expect(yes).toBeInTheDocument()
    for (let i = 0; i < 6; i++) await userEvent.tab()
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    for (let i = 0; i < 6; i++) await userEvent.tab({ shift: true })
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  })

  it('confirms, shows busy state and closes on success', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    render(<ConfirmDialog title="T" message="m" confirmLabel="Do it" onConfirm={onConfirm} onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Do it' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('stays open and shows the error when confirming fails', async () => {
    const onClose = vi.fn()
    render(<ConfirmDialog title="T" message="m" confirmLabel="Do it" onConfirm={() => Promise.reject(new Error('Nope, 409'))} onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Do it' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Nope, 409')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Do it' })).toBeEnabled()
  })

  it('requires the typed text before enabling confirm', async () => {
    const onConfirm = vi.fn()
    render(<ConfirmDialog title="Restore" message="m" confirmLabel="Restore" requireText="RESTORE" tone="danger" onConfirm={onConfirm} onClose={() => undefined} />)
    const confirm = screen.getByRole('button', { name: 'Restore' })
    const input = screen.getByLabelText(/to confirm/i)
    expect(input).toHaveFocus()
    expect(confirm).toBeDisabled()
    await userEvent.type(input, 'restore')
    expect(confirm).toBeDisabled()
    await userEvent.clear(input)
    await userEvent.type(input, 'RESTORE')
    expect(confirm).toBeEnabled()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  })

  it('restores focus to the opener when closed', async () => {
    function Host() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>open</button>
          {open && <ConfirmDialog title="T" message="m" onConfirm={() => undefined} onClose={() => setOpen(false)} />}
        </>
      )
    }
    render(<Host />)
    const opener = screen.getByRole('button', { name: 'open' })
    await userEvent.click(opener)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(opener).toHaveFocus())
  })
})

describe('Tabs', () => {
  const tabs = [{ id: 'a' as const, label: 'A' }, { id: 'b' as const, label: 'B' }, { id: 'c' as const, label: 'C' }]
  function Host() {
    const [v, setV] = useState<'a' | 'b' | 'c'>('a')
    return <Tabs tabs={tabs} value={v} onChange={setV} label="Sections" idPrefix="t" />
  }

  it('exposes tab semantics and a roving tabindex', () => {
    render(<Host />)
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('tabindex', '-1')
  })

  it('moves with arrow keys, Home and End, and on click', async () => {
    render(<Host />)
    screen.getByRole('tab', { name: 'A' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'B' })).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'C' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tab', { name: 'C' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(screen.getByRole('tab', { name: 'B' }))
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('aria-selected', 'true')
  })
})
