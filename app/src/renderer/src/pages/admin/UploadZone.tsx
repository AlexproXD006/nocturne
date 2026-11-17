import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Check, FileAudio, UploadCloud, X } from 'lucide-react'
import { describeError, isAbort } from '../../api/errors'
import { resources } from '../../lib/resource'
import { api } from '../../services'
import { useUi } from '../../store/ui'
import { cx } from '../../components/common'
import { formatBytes } from './format'
import { Button, Card, Chip, ProgressBar } from './ui'

export const AUDIO_ACCEPT = 'audio/*,.mp3,.flac,.m4a,.aac,.ogg,.opus,.wav'
const AUDIO_EXT = /\.(mp3|flac|m4a|aac|ogg|opus|wav)$/i

export function isAudioFile(file: { name: string; type: string }): boolean {
  return file.type.startsWith('audio/') || AUDIO_EXT.test(file.name)
}

/** Returns an error message for files that must not be uploaded, else null. */
export function validateUpload(file: { name: string; type: string; size: number }, maxBytes: number | undefined): string | null {
  if (!isAudioFile(file)) return 'Not an audio file (mp3, flac, m4a, aac, ogg, opus or wav).'
  if (file.size === 0) return 'The file is empty.'
  if (maxBytes !== undefined && maxBytes > 0 && file.size > maxBytes) return `Too large — the limit is ${formatBytes(maxBytes)}.`
  return null
}

type Status = 'pending' | 'uploading' | 'done' | 'error' | 'cancelled'
interface Item {
  id: number
  file: File
  status: Status
  progress: number
  error?: string
}

let nextId = 1

export function UploadZone({ maxBytes }: { maxBytes: number | undefined }): ReactNode {
  const [items, setItems] = useState<Item[]>([])
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const activeId = useRef<number | null>(null)
  const ctrls = useRef(new Map<number, AbortController>())
  const hadSuccess = useRef(false)

  const patch = (id: number, p: Partial<Item>): void => setItems((list) => list.map((i) => (i.id === id ? { ...i, ...p } : i)))

  const add = (files: FileList | File[]): void => {
    const next: Item[] = Array.from(files).map((file) => {
      const error = validateUpload(file, maxBytes)
      return { id: nextId++, file, status: error ? 'error' : 'pending', progress: 0, error: error ?? undefined }
    })
    if (next.length > 0) setItems((list) => [...list, ...next])
  }

  // Strictly sequential: start the next pending file once nothing is uploading.
  useEffect(() => {
    if (activeId.current !== null) return
    const next = items.find((i) => i.status === 'pending')
    if (!next) {
      if (hadSuccess.current && !items.some((i) => i.status === 'uploading')) {
        hadSuccess.current = false
        resources.invalidate('')
      }
      return
    }
    activeId.current = next.id
    const ctrl = new AbortController()
    ctrls.current.set(next.id, ctrl)
    patch(next.id, { status: 'uploading', progress: 0 })
    api
      .adminUpload(next.file, next.file.name, { signal: ctrl.signal, onProgress: (f) => patch(next.id, { progress: f }) })
      .then((track) => {
        hadSuccess.current = true
        activeId.current = null
        ctrls.current.delete(next.id)
        patch(next.id, { status: 'done', progress: 1 })
        useUi.getState().toast(`Uploaded “${track.title || next.file.name}”`)
      })
      .catch((err: unknown) => {
        activeId.current = null
        ctrls.current.delete(next.id)
        if (ctrl.signal.aborted || isAbort(err)) patch(next.id, { status: 'cancelled' })
        else patch(next.id, { status: 'error', error: describeError(err) })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  // Leaving the page abandons the in-flight upload.
  useEffect(() => {
    const map = ctrls.current
    return () => map.forEach((c) => c.abort())
  }, [])

  const cancel = (item: Item): void => {
    if (item.status === 'uploading') ctrls.current.get(item.id)?.abort()
    else if (item.status === 'pending') patch(item.id, { status: 'cancelled' })
  }

  const busyCount = items.filter((i) => i.status === 'pending' || i.status === 'uploading').length
  const finished = items.filter((i) => i.status !== 'pending' && i.status !== 'uploading')

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (e.dataTransfer.files.length > 0) add(e.dataTransfer.files)
  }

  return (
    <Card id="upload-title" title="Upload files">
      <div
        onDragEnter={(e) => {
          e.preventDefault()
          dragDepth.current += 1
          setDragging(true)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDragging(false)
        }}
        onDrop={onDrop}
        data-testid="upload-dropzone"
        className={cx(
          'flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors',
          dragging ? 'border-accent bg-accent-soft' : 'border-white/12 bg-white/[0.02]'
        )}
      >
        <UploadCloud className={cx('h-9 w-9', dragging ? 'text-accent' : 'text-fg-subtle')} strokeWidth={1.5} aria-hidden />
        <p className="text-sm font-semibold">{dragging ? 'Drop to upload' : 'Drag audio files here'}</p>
        <p className="text-[13px] text-fg-muted">
          mp3, flac, m4a, aac, ogg, opus or wav{maxBytes ? ` · up to ${formatBytes(maxBytes)} each` : ''}
        </p>
        <Button className="mt-2" onClick={() => inputRef.current?.click()}>
          Choose files
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={AUDIO_ACCEPT}
          aria-label="Choose audio files to upload"
          className="sr-only"
          tabIndex={-1}
          data-testid="upload-input"
          onChange={(e) => {
            if (e.currentTarget.files) add(e.currentTarget.files)
            e.currentTarget.value = ''
          }}
        />
      </div>

      {items.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-[13px] text-fg-muted tabular-nums" aria-live="polite">
              {busyCount > 0 ? `${busyCount} remaining` : `${items.length} ${items.length === 1 ? 'file' : 'files'}`}
            </p>
            {finished.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setItems((l) => l.filter((i) => i.status === 'pending' || i.status === 'uploading'))}>
                Clear finished
              </Button>
            )}
          </div>
          <ul className="space-y-2">
            {items.map((i) => (
              <li key={i.id} className="flex items-center gap-3 rounded-xl bg-white/[0.03] p-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-fg-muted" aria-hidden>
                  {i.status === 'done' ? <Check className="h-4 w-4 text-[#5fd698]" /> : <FileAudio className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="min-w-0 truncate text-sm font-medium" title={i.file.name}>{i.file.name}</p>
                    <span className="text-xs text-fg-subtle tabular-nums">{formatBytes(i.file.size)}</span>
                    {i.status === 'pending' && <Chip>Waiting</Chip>}
                    {i.status === 'done' && <Chip tone="good">Uploaded</Chip>}
                    {i.status === 'cancelled' && <Chip tone="warn">Cancelled</Chip>}
                    {i.status === 'error' && <Chip tone="bad">Failed</Chip>}
                  </div>
                  {i.status === 'uploading' && (
                    <div className="mt-2 flex items-center gap-3">
                      <ProgressBar value={i.progress} label={`Uploading ${i.file.name}`} />
                      <span className="w-10 shrink-0 text-right text-xs text-fg-muted tabular-nums">{Math.round(i.progress * 100)}%</span>
                    </div>
                  )}
                  {i.status === 'error' && i.error && <p className="mt-1 text-[13px] text-[#ff9b9b] [overflow-wrap:anywhere]">{i.error}</p>}
                </div>
                {(i.status === 'uploading' || i.status === 'pending') && (
                  <Button size="sm" variant="ghost" icon={<X />} aria-label={`Cancel upload of ${i.file.name}`} onClick={() => cancel(i)}>
                    <span className="max-sm:sr-only">Cancel</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}
