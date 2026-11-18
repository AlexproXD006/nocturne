import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileUp, Loader2, Trash2 } from 'lucide-react'
import type { AdminTrack } from '../../api/types'
import { describeError } from '../../api/errors'
import { Modal } from '../../components/Modal'
import { api } from '../../services'
import { useUi } from '../../store/ui'
import { artistNames } from '../../lib/format'
import { Button, inputClass } from './ui'
import { removeLyrics, saveLyrics } from './lyrics/files'
import { EDIT_FILE_ACCEPT, EDIT_MAX_BYTES, checkEditLyrics, detectEditFormat, type EditFormat } from './lyrics/edit'
import { useT } from '../../i18n'
import { formatNumber } from '../../i18n/format'

/**
 * Admin "Edit lyrics" dialog: paste text or pick a .lrc / .txt file, preview, save or remove.
 * Stored lyrics (LRC or plain) have top priority over everything automatic.
 */
export function LyricsEditDialog({
  track,
  onClose,
  onChanged
}: {
  track: AdminTrack
  onClose: () => void
  /** Called after lyrics were saved or removed. */
  onChanged?: (stored: EditFormat | null) => void
}): ReactNode {
  const tr = useT()
  const stored = track.lyrics ?? null
  const [text, setText] = useState('')
  const [format, setFormat] = useState<EditFormat>('plain')
  const [auto, setAuto] = useState(true)
  const [loading, setLoading] = useState(stored === 'lrc' || stored === 'plain')
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const areaId = useId()

  // Prefill with what is stored (TTML cannot be edited here: saving replaces it).
  useEffect(() => {
    if (stored !== 'lrc' && stored !== 'plain') return
    const ctrl = new AbortController()
    api.lyrics(track.id, ctrl.signal).then(
      (l) => {
        const content = (stored === 'lrc' ? l.synced : l.plain) ?? ''
        setText(content)
        setFormat(stored)
        setAuto(false)
        setLoading(false)
      },
      () => setLoading(false)
    )
    return () => ctrl.abort()
  }, [track.id, stored])

  const effective: EditFormat = auto ? detectEditFormat(text) : format
  const check = useMemo(() => checkEditLyrics(effective, text), [effective, text])

  const onFile = async (file: File): Promise<void> => {
    setError(null)
    if (file.size > EDIT_MAX_BYTES) {
      setError(tr('led.fileTooBig'))
      return
    }
    try {
      const content = await file.text()
      setText(content)
      setAuto(true)
    } catch {
      setError(tr('lfile.unreadable'))
    }
  }

  const save = async (): Promise<void> => {
    if (!check.ok || busy) return
    setBusy('save')
    setError(null)
    try {
      await saveLyrics(track.id, effective, text)
      useUi.getState().toast(tr('led.saved', { title: track.title }))
      onChanged?.(effective)
      onClose()
    } catch (err) {
      setError(describeError(err))
      setBusy(null)
    }
  }

  const remove = async (): Promise<void> => {
    if (busy) return
    setBusy('remove')
    setError(null)
    try {
      await removeLyrics(track.id)
      useUi.getState().toast(tr('ly.removed', { title: track.title }))
      onChanged?.(null)
      onClose()
    } catch (err) {
      setError(describeError(err))
      setBusy(null)
    }
  }

  return (
    <Modal
      title={tr('led.title')}
      size="md"
      dismissible={!busy}
      onClose={onClose}
      description={
        <>
          {track.title} &middot; {artistNames(track.artists) || tr('ly.unknownArtist')}
        </>
      }
      footer={
        <>
          {stored && (
            <Button variant="danger" icon={<Trash2 />} busy={busy === 'remove'} disabled={busy === 'save'} onClick={() => void remove()} className="mr-auto">
              {tr('led.remove')}
            </Button>
          )}
          <Button onClick={onClose} disabled={busy !== null}>
            {tr('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy === 'save'} disabled={!check.ok || busy === 'remove' || loading} onClick={() => void save()}>
            {tr('led.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {stored === 'ttml' && <p className="text-[13px] text-fg-muted">{tr('led.hasTtml')}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept={EDIT_FILE_ACCEPT}
            aria-label={tr('ly.chooseFile')}
            className="sr-only"
            tabIndex={-1}
            data-testid="lyrics-edit-file"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0]
              e.currentTarget.value = ''
              if (f) void onFile(f)
            }}
          />
          <Button size="sm" icon={<FileUp />} onClick={() => fileRef.current?.click()}>
            {tr('led.chooseLrc')}
          </Button>
          <div role="radiogroup" aria-label={tr('led.format')} className="ml-auto inline-flex rounded-full bg-white/[0.08] p-0.5 text-[13px] font-semibold">
            {(['lrc', 'plain'] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={effective === f}
                onClick={() => {
                  setFormat(f)
                  setAuto(false)
                }}
                className={`rounded-full px-3 py-1 ${effective === f ? 'bg-accent text-ink-950' : 'text-fg-muted hover:text-fg'}`}
              >
                {f === 'lrc' ? tr('led.synced') : tr('led.plain')}
              </button>
            ))}
          </div>
        </div>
        <label htmlFor={areaId} className="sr-only">
          {tr('led.text')}
        </label>
        <textarea
          id={areaId}
          data-autofocus
          value={text}
          disabled={loading}
          onChange={(e) => setText(e.target.value)}
          rows={9}
          spellCheck={false}
          placeholder={tr('led.placeholder')}
          className={`${inputClass} resize-y font-mono text-[13px] leading-relaxed`}
        />
        <div aria-label={tr('led.preview')} data-testid="lyrics-edit-preview" className="rounded-xl bg-ink-900 p-3 text-[13px]">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-fg-muted" aria-label={tr('ui.loading')} />
          ) : check.preview.length ? (
            <>
              <p className="mb-1.5 text-xs text-fg-subtle tabular-nums">
                {tr('led.stats', { lines: check.lines, count: check.lines, kb: formatNumber(check.bytes / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), kind: effective === 'lrc' ? tr('led.timeSynced') : tr('led.plainKind') })}
              </p>
              <ul className="space-y-0.5 text-fg-muted">
                {check.preview.map((l, i) => (
                  <li key={i} className="truncate">
                    {l}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-fg-subtle">{tr('led.nothing')}</p>
          )}
        </div>
        <p role="alert" className={`min-h-5 text-sm text-[#ff9b9b] ${error || (text && check.error) ? '' : 'sr-only'}`}>
          {error ?? (text ? check.error : '') ?? ''}
        </p>
      </div>
    </Modal>
  )
}
