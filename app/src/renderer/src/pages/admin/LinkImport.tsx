import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { Link2, ListPlus } from 'lucide-react'
import type { AdminJob, AdminSource } from '../../api/types'
import { describeError } from '../../api/errors'
import { api } from '../../services'
import { useUi } from '../../store/ui'
import { detectSource } from './format'
import { SOURCE_LABEL } from './SourceSearch'
import { Button, Card, Field, InlineError, inputClass } from './ui'

function useLinkForm(sources: AdminSource[], run: (url: string, source: AdminSource) => Promise<AdminJob>, doneMessage: string, upsert: (j: AdminJob) => void) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const detected = value.trim() ? detectSource(value) : null
  const unsupported = detected && !sources.includes(detected.source)

  const problem = !value.trim()
    ? null
    : !detected
      ? 'That doesn’t look like a Spotify or YouTube link.'
      : unsupported
        ? `This server can’t fetch from ${SOURCE_LABEL[detected.source]}.`
        : null

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!detected || unsupported || busy) return
    setBusy(true)
    setError(null)
    try {
      upsert(await run(detected.url, detected.source))
      useUi.getState().toast(doneMessage)
      setValue('')
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }
  return { value, setValue: (v: string) => (setError(null), setValue(v)), busy, error, detected, problem, submit, ready: Boolean(detected && !unsupported) }
}

function LinkForm({ id, label, placeholder, buttonLabel, icon, form }: {
  id: string
  label: string
  placeholder: string
  buttonLabel: string
  icon: ReactNode
  form: ReturnType<typeof useLinkForm>
}): ReactNode {
  const hint = form.problem ?? (form.detected ? `${SOURCE_LABEL[form.detected.source]} link detected` : undefined)
  return (
    <form onSubmit={(e) => void form.submit(e)} noValidate>
      <Field label={label} htmlFor={id} hint={<span className={form.problem ? 'text-[#ff9b9b]' : undefined}>{hint}</span>}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={id}
            type="url"
            inputMode="url"
            className={inputClass}
            placeholder={placeholder}
            value={form.value}
            onChange={(e) => form.setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            aria-invalid={form.problem ? true : undefined}
          />
          <Button type="submit" variant="primary" icon={icon} busy={form.busy} disabled={!form.ready} className="sm:self-start">
            {buttonLabel}
          </Button>
        </div>
      </Field>
      <div className="mt-1.5"><InlineError message={form.error} /></div>
    </form>
  )
}

export function LinkImport({ sources, upsert }: { sources: AdminSource[]; upsert: (job: AdminJob) => void }): ReactNode {
  const linkId = useId()
  const importId = useId()
  const link = useLinkForm(sources, (url, source) => api.adminStartDownload({ source, url }), 'Download queued', upsert)
  const playlist = useLinkForm(sources, (url) => api.adminImportPlaylist(url), 'Playlist import queued', upsert)
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card id="paste-title" title="Paste a link">
        <LinkForm id={linkId} label="Song or album link" placeholder="https://open.spotify.com/track/…" buttonLabel="Download" icon={<Link2 />} form={link} />
      </Card>
      <Card id="import-title" title="Import a playlist">
        <LinkForm id={importId} label="Playlist link" placeholder="https://music.youtube.com/playlist?list=…" buttonLabel="Import" icon={<ListPlus />} form={playlist} />
      </Card>
    </div>
  )
}
