import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { describeError } from '../api/errors'
import { Modal } from './Modal'

export interface ConfirmDialogProps {
  title: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  /** When set, the confirm button stays disabled until this exact text is typed. */
  requireText?: string
  /** May return a promise: the dialog shows a spinner, closes on success and shows the error on failure. */
  onConfirm: () => void | Promise<void>
  onClose: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  requireText,
  onConfirm,
  onClose
}: ConfirmDialogProps): ReactNode {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const ready = !requireText || typed === requireText

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(describeError(err))
      setBusy(false)
    }
  }

  const danger = tone === 'danger'
  return (
    <Modal
      title={title}
      description={message}
      dismissible={!busy}
      onClose={onClose}
      initialFocus={() => (requireText ? inputRef.current : cancelRef.current)}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={onClose}
            className="h-10 rounded-full bg-white/[0.08] px-5 text-sm font-semibold hover:bg-white/[0.14] disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            form={`${inputId}-form`}
            disabled={!ready || busy}
            className={`inline-flex h-10 items-center justify-center gap-2 rounded-full px-5 text-sm font-bold transition active:scale-[0.98] disabled:opacity-40 ${
              danger ? 'bg-[#e5484d] text-white hover:brightness-110' : 'bg-accent text-ink-950 hover:brightness-110'
            }`}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <form id={`${inputId}-form`} onSubmit={(e) => void submit(e)} noValidate>
        {requireText && (
          <div>
            <label htmlFor={inputId} className="mb-1.5 block text-xs font-semibold text-fg-muted">
              Type <span className="font-mono text-fg">{requireText}</span> to confirm
            </label>
            <input
              id={inputId}
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={busy}
              className="w-full rounded-xl border border-line bg-ink-900 px-4 py-2.5 font-mono text-sm tracking-wider outline-none placeholder:text-fg-subtle focus:border-accent/70"
              placeholder={requireText}
            />
          </div>
        )}
        <p role="alert" className={`mt-2 min-h-5 text-sm text-[#ff9b9b] ${error ? '' : 'sr-only'}`}>
          {error ?? ''}
        </p>
      </form>
    </Modal>
  )
}
