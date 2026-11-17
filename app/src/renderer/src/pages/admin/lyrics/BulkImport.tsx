import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Check, FileText, Loader2, Search, Sparkles, UploadCloud, X } from 'lucide-react'
import type { AdminTrack } from '../../../api/types'
import { describeError, isAbort } from '../../../api/errors'
import { artistNames, formatTime } from '../../../lib/format'
import { resources } from '../../../lib/resource'
import { AUTO_THRESHOLD, confidenceOf, scoreTrackMatch, type LyricsFileDescription } from '../../../lyrics/match'
import { api } from '../../../services'
import { useUi } from '../../../store/ui'
import { cx } from '../../../components/common'
import { Button, Chip, inputClass, useDebounced, type ChipTone } from '../ui'
import { createPool, findCandidates, selectBest, type SearchFn } from './bulk'
import { LYRICS_ACCEPT, loadLyricsFile, saveLyrics } from './files'

type Status = 'reading' | 'matching' | 'ready' | 'saving' | 'saved' | 'error' | 'invalid'

interface Item {
  id: number
  name: string
  size: number
  content: string
  desc: LyricsFileDescription | null
  status: Status
  candidates: AdminTrack[]
  selected: AdminTrack | null
  score: number
  checked: boolean
  manual: boolean
  error?: string
}

let nextId = 1

const search: SearchFn = (q, signal) => api.adminTracks({ q, limit: 8, signal }).then((p) => p.items)

const trackLabel = (t: AdminTrack): string => `${t.title} — ${artistNames(t.artists) || 'Unknown artist'}`

function confidenceChip(item: Item): { tone: ChipTone; label: string } {
  if (!item.selected) return { tone: 'bad', label: 'No match' }
  if (item.manual) return { tone: 'accent', label: 'Manual' }
  const c = confidenceOf(item.score)
  return c === 'auto' ? { tone: 'good', label: 'Auto' } : c === 'review' ? { tone: 'warn', label: 'Review' } : { tone: 'bad', label: 'No match' }
}

/** Inline track search used to pick a match that the automatic search did not offer. */
function TrackFinder({ onPick, onClose }: { onPick: (t: AdminTrack) => void; onClose: () => void }): ReactNode {
  const [text, setText] = useState('')
  const q = useDebounced(text.trim(), 300)
  const [results, setResults] = useState<AdminTrack[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!q) {
      setResults(null)
      return
    }
    const ctrl = new AbortController()
    setError(null)
    search(q, ctrl.signal).then(
      (r) => setResults(r),
      (err: unknown) => {
        if (!isAbort(err) && !ctrl.signal.aborted) setError(describeError(err))
      }
    )
    return () => ctrl.abort()
  }, [q])

  return (
    <div className="mt-2 rounded-xl bg-white/[0.04] p-2">
      <div className="flex items-center gap-2">
        <input
          type="search"
          autoFocus
          aria-label="Search for a track"
          placeholder="Search by title or artist"
          className={`${inputClass} !py-1.5 text-sm`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <Button size="sm" variant="ghost" aria-label="Close search" onClick={onClose} icon={<X />} />
      </div>
      {error && <p role="alert" className="mt-1 text-[13px] text-[#ff9b9b]">{error}</p>}
      {results && results.length === 0 && <p className="mt-2 px-1 text-[13px] text-fg-muted">No tracks found.</p>}
      {results && results.length > 0 && (
        <ul className="mt-1">
          {results.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onPick(t)}
                className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/[0.08]"
              >
                <span className="min-w-0 truncate">{trackLabel(t)}</span>
                <span className="shrink-0 text-xs text-fg-subtle tabular-nums">{formatTime(t.duration)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Row({
  item,
  duplicate,
  onToggle,
  onChoose,
  onRemove
}: {
  item: Item
  duplicate: boolean
  onToggle: () => void
  onChoose: (t: AdminTrack | null) => void
  onRemove: () => void
}): ReactNode {
  const [finding, setFinding] = useState(false)
  const { desc } = item
  const chip = confidenceChip(item)
  const locked = item.status === 'saving' || item.status === 'saved'
  const canPick = item.status === 'ready' || item.status === 'error'
  const detected = desc ? [desc.title, desc.artist].filter(Boolean).join(' — ') : ''

  return (
    <li className="rounded-xl bg-white/[0.03] p-3" data-testid="bulk-row" data-status={item.status}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1.5 h-4 w-4 shrink-0 accent-[var(--color-accent,#1ed760)]"
          aria-label={`Save ${item.name}`}
          checked={item.checked}
          disabled={!item.selected || !canPick}
          onChange={onToggle}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <FileText className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden />
            <p className="min-w-0 truncate text-sm font-semibold" title={item.name}>{item.name}</p>
            {desc && <Chip>{desc.format}</Chip>}
            {desc?.valid && desc.wordSynced && <Chip tone="accent">Word sync</Chip>}
            {item.status === 'reading' && <Chip>Reading</Chip>}
            {item.status === 'matching' && (
              <Chip>
                <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden />
                Matching
              </Chip>
            )}
            {item.status === 'ready' && <Chip tone={chip.tone}>{chip.label}</Chip>}
            {item.status === 'saving' && <Chip>Saving</Chip>}
            {item.status === 'saved' && <Chip tone="good">Saved</Chip>}
            {item.status === 'error' && <Chip tone="bad">Failed</Chip>}
            {item.status === 'invalid' && <Chip tone="bad">Invalid</Chip>}
            {item.selected?.lyrics && !locked && <Chip tone="warn">Replaces {item.selected.lyrics}</Chip>}
            {duplicate && <Chip tone="warn">Same track as another file</Chip>}
          </div>
          {detected && <p className="mt-0.5 truncate text-[13px] text-fg-muted">Detected: {detected}</p>}
          {item.error && <p className="mt-1 text-[13px] text-[#ff9b9b] [overflow-wrap:anywhere]">{item.error}</p>}

          {(item.status === 'ready' || item.status === 'error' || item.status === 'saving' || item.status === 'saved') && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                aria-label={`Track for ${item.name}`}
                className={cx(inputClass, 'min-w-0 flex-1 !py-1.5 text-sm')}
                value={item.selected?.id ?? ''}
                disabled={!canPick}
                onChange={(e) => onChoose(item.candidates.find((c) => c.id === e.target.value) ?? null)}
              >
                <option value="">No match</option>
                {item.candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {trackLabel(c)}
                    {c.lyrics ? ` (has ${c.lyrics})` : ''}
                  </option>
                ))}
              </select>
              {canPick && (
                <Button size="sm" variant="ghost" icon={<Search />} onClick={() => setFinding((v) => !v)} aria-expanded={finding}>
                  Find track
                </Button>
              )}
            </div>
          )}
          {finding && canPick && (
            <TrackFinder
              onClose={() => setFinding(false)}
              onPick={(t) => {
                onChoose(t)
                setFinding(false)
              }}
            />
          )}
        </div>
        {!locked && (
          <Button size="sm" variant="ghost" icon={<X />} aria-label={`Remove ${item.name}`} onClick={onRemove} />
        )}
      </div>
    </li>
  )
}

export function BulkImport({ onSaved }: { onSaved: (trackIds: string[]) => void }): ReactNode {
  const [items, setItems] = useState<Item[]>([])
  const [dragging, setDragging] = useState(false)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const ctrl = useRef(new AbortController())
  const matchPool = useRef(createPool(3))
  const savePool = useRef(createPool(2))
  const itemsRef = useRef(items)
  itemsRef.current = items

  const patch = (id: number, p: Partial<Item>): void => setItems((list) => list.map((i) => (i.id === id ? { ...i, ...p } : i)))

  useEffect(() => {
    const c = ctrl.current
    const mp = matchPool.current
    return () => {
      c.abort()
      mp.clear()
    }
  }, [])

  const process = async (id: number, file: File, signal: AbortSignal): Promise<void> => {
    const loaded = await loadLyricsFile(file)
    if (signal.aborted) return
    if (!loaded.desc.valid) {
      patch(id, { status: 'invalid', desc: loaded.desc, error: loaded.desc.error })
      return
    }
    patch(id, { status: 'matching', desc: loaded.desc, content: loaded.content })
    let candidates: AdminTrack[] = []
    let error: string | undefined
    try {
      candidates = await findCandidates(loaded.desc, search, signal)
    } catch (err) {
      if (signal.aborted || isAbort(err)) return
      error = `Search failed: ${describeError(err)}`
    }
    if (signal.aborted) return
    if (!loaded.desc.title) error ??= 'No title found in the file or its name — pick the track yourself.'
    const sel = selectBest(loaded.desc, candidates, AUTO_THRESHOLD)
    patch(id, { status: 'ready', candidates, selected: sel.selected, score: sel.score, checked: sel.checked, error })
  }

  const add = (files: File[]): void => {
    if (files.length === 0) return
    const signal = ctrl.current.signal
    const created: Item[] = files.map((f) => ({
      id: nextId++,
      name: f.name,
      size: f.size,
      content: '',
      desc: null,
      status: 'reading',
      candidates: [],
      selected: null,
      score: 0,
      checked: false,
      manual: false
    }))
    setItems((l) => [...l, ...created])
    created.forEach((it, i) => matchPool.current.push(() => process(it.id, files[i]!, signal)))
  }

  const clearAll = (): void => {
    ctrl.current.abort()
    ctrl.current = new AbortController()
    matchPool.current.clear()
    setItems((l) => l.filter((i) => i.status === 'saving'))
  }

  const choose = (item: Item, track: AdminTrack | null): void => {
    const candidates = track && !item.candidates.some((c) => c.id === track.id) ? [track, ...item.candidates] : item.candidates
    patch(item.id, {
      candidates,
      selected: track,
      score: track && item.desc ? scoreTrackMatch(item.desc, track) : 0,
      manual: true,
      checked: Boolean(track),
      error: item.status === 'error' ? undefined : item.error,
      status: item.status === 'error' ? 'ready' : item.status
    })
  }

  const targets = useMemo(() => items.filter((i) => i.checked && i.selected && i.desc?.valid && (i.status === 'ready' || i.status === 'error')), [items])
  const duplicates = useMemo(() => {
    const count = new Map<string, number>()
    for (const i of items) if (i.checked && i.selected && i.status !== 'saved') count.set(i.selected.id, (count.get(i.selected.id) ?? 0) + 1)
    return new Set([...count].filter(([, n]) => n > 1).map(([id]) => id))
  }, [items])

  const save = async (): Promise<void> => {
    const batch = itemsRef.current.filter((i) => i.checked && i.selected && i.desc?.valid && (i.status === 'ready' || i.status === 'error'))
    if (batch.length === 0) return
    setSaving(true)
    const saved: string[] = []
    let failed = 0
    for (const it of batch) patch(it.id, { status: 'saving', error: undefined })
    for (const it of batch) {
      savePool.current.push(async () => {
        try {
          await saveLyrics(it.selected!.id, it.desc!.format, it.content, { skipResources: true })
          saved.push(it.selected!.id)
          patch(it.id, { status: 'saved', checked: false })
        } catch (err) {
          failed++
          patch(it.id, { status: 'error', error: describeError(err) })
        }
      })
    }
    await savePool.current.drain()
    setSaving(false)
    if (saved.length > 0) {
      resources.invalidate('')
      onSaved(saved)
    }
    const ui = useUi.getState()
    if (saved.length > 0) ui.toast(`Saved lyrics for ${saved.length} ${saved.length === 1 ? 'track' : 'tracks'}${failed ? ` · ${failed} failed` : ''}`)
    else if (failed > 0) ui.toast(`${failed} ${failed === 1 ? 'file' : 'files'} could not be saved`, 'error')
  }

  const selectAuto = (): void =>
    setItems((l) => l.map((i) => (i.status === 'ready' && i.selected && !i.manual && confidenceOf(i.score) === 'auto' ? { ...i, checked: true } : i)))

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    add(Array.from(e.dataTransfer.files))
  }

  const matching = items.filter((i) => i.status === 'reading' || i.status === 'matching').length
  const autoCount = items.filter((i) => i.status === 'ready' && i.selected && confidenceOf(i.score) === 'auto').length

  return (
    <div>
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
        data-testid="lyrics-dropzone"
        className={cx(
          'flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-7 text-center transition-colors',
          dragging ? 'border-accent bg-accent-soft' : 'border-white/12 bg-white/[0.02]'
        )}
      >
        <UploadCloud className={cx('h-8 w-8', dragging ? 'text-accent' : 'text-fg-subtle')} strokeWidth={1.5} aria-hidden />
        <p className="text-sm font-semibold">{dragging ? 'Drop to match' : 'Drag .ttml and .lrc files here'}</p>
        <p className="max-w-md text-[13px] text-fg-muted">
          Files are matched to tracks by their embedded title and artist, or by a name like “Artist - Title.ttml”. You review the matches before anything is saved.
        </p>
        <Button className="mt-1" onClick={() => inputRef.current?.click()}>
          Choose files
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={LYRICS_ACCEPT}
          aria-label="Choose lyrics files to import"
          className="sr-only"
          tabIndex={-1}
          data-testid="lyrics-bulk-input"
          onChange={(e) => {
            add(Array.from(e.currentTarget.files ?? []))
            e.currentTarget.value = ''
          }}
        />
      </div>

      {items.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] text-fg-muted tabular-nums" aria-live="polite">
              {matching > 0 ? `Matching ${matching} of ${items.length}…` : `${items.length} ${items.length === 1 ? 'file' : 'files'} · ${autoCount} matched automatically`}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" icon={<Sparkles />} onClick={selectAuto} disabled={autoCount === 0 || saving}>
                Select auto matches
              </Button>
              <Button size="sm" variant="ghost" onClick={clearAll} disabled={saving}>
                Clear
              </Button>
              <Button variant="primary" size="sm" icon={<Check />} busy={saving} disabled={targets.length === 0} onClick={() => void save()}>
                Save {targets.length}
              </Button>
            </div>
          </div>
          <ul className="space-y-2">
            {items.map((i) => (
              <Row
                key={i.id}
                item={i}
                duplicate={Boolean(i.selected && i.checked && duplicates.has(i.selected.id))}
                onToggle={() => patch(i.id, { checked: !i.checked })}
                onChoose={(t) => choose(i, t)}
                onRemove={() => setItems((l) => l.filter((x) => x.id !== i.id))}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
