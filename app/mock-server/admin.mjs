// The /v1/admin/* API (docs/HOSTED_AND_ADMIN.md sections 4 and 6). Everything is in memory:
// the library is the server's mutable copy of the demo catalog, jobs run on timers (jobs.mjs)
// and all "Spotify"/"YouTube" content is invented locally (sources.mjs). Nothing is fetched.

import { HttpError } from './auth.mjs'
import { inspectAudio, parseUploadName } from './audiofile.mjs'
import { avatarFor } from './userjson.mjs'
import { addPlaylist, addTrack, reindex, removeTrack, restoreLibrary, snapshotLibrary, snapshotSize, storageBytes, uploadedBytes } from './library.mjs'
import { page, readJson, sendJson, sendNoContent } from './http.mjs'
import { readMultipartFile } from './multipart.mjs'
import { SOURCES, itemFromResultId, itemFromUrl, parseResultId, parseSourceUrl, searchSource } from './sources.mjs'
import { validateLyrics } from './ttml.mjs'
import { trackJson } from './catalog.mjs'
import { fold, rngFor } from './util.mjs'

const MAX_BACKUPS = 10
const LYRICS_BODY_MAX = 4 * 1024 * 1024
const DISK_TOTAL = 512 * 1024 ** 3

/**
 * @param {{opt:object, auth:import('./auth.mjs').AuthService, lib:object, jobs:import('./jobs.mjs').JobEngine,
 *   userState:Map<string,{liked:string[],played:string[]}>, ctxFor:Function, originOf:Function}} env
 */
export function createAdmin(env) {
  const { opt, auth, lib, jobs, userState, ctxFor, originOf } = env
  const nowIso = () => new Date(opt.now()).toISOString()

  // ---- Backups ---------------------------------------------------------------------
  let backupCounter = 0
  const baseline = { library: snapshotLibrary(lib), users: new Map() }
  const backups = [
    { id: `bk-${String(++backupCounter).padStart(4, '0')}`, createdAt: new Date(opt.now() - 2 * 86_400_000).toISOString(), sizeBytes: snapshotSize(baseline.library), label: 'database', snap: baseline },
    { id: `bk-${String(++backupCounter).padStart(4, '0')}`, createdAt: new Date(opt.now() - 86_400_000).toISOString(), sizeBytes: snapshotSize(baseline.library) + 4096, label: 'database+playlists', snap: baseline }
  ]
  const backupJson = (b) => ({ id: b.id, createdAt: b.createdAt, sizeBytes: b.sizeBytes, label: b.label })

  function cloneUsers() {
    return new Map([...userState].map(([k, v]) => [k, { liked: [...v.liked], played: [...v.played] }]))
  }

  // ---- Serializers -----------------------------------------------------------------
  const adminTrackJson = (ctx, t) => ({
    ...trackJson(ctx, t),
    addedAt: t.addedAt,
    playCount: t.plays,
    sizeBytes: t.sizeBytes,
    format: t.format,
    lyrics: t.lyricsStored?.format ?? null
  })

  const adminUserJson = (entry, origin) => ({
    id: entry.user.id,
    username: entry.user.username,
    displayName: entry.user.displayName,
    avatar: avatarFor(entry.user, origin),
    role: entry.user.role,
    createdAt: entry.createdAt,
    lastLoginAt: entry.lastLoginAt,
    disabled: entry.disabled
  })

  const libraryHas = (kind, title) => {
    const key = fold(title)
    const list = kind === 'track' ? lib.tracks : kind === 'album' ? lib.albums : lib.playlists
    return list.some((e) => fold(e.title ?? e.name) === key)
  }

  // ---- Job builders ----------------------------------------------------------------
  function lyricsModeFor(seed) {
    const r = rngFor(`lyricsmode:${seed}`)()
    return r < 0.16 ? 'none' : r < 0.24 ? 'plain' : 'synced'
  }

  /** Download / import job for a described item (see sources.mjs). */
  function itemJob({ kind, jobSource, item, seed }) {
    const added = []
    const tracks = item.tracks
    const resolved = [] // track ids (new or pre-existing) in order, for playlists
    let skipped = 0
    const year = new Date(opt.now()).getUTCFullYear()
    const failAt = Math.min(2, tracks.length) - 1
    const steps = [{ message: 'Resolving source', progress: 0.05 }]
    tracks.forEach((t, i) => {
      steps.push({
        message: `Downloading ${i + 1}/${tracks.length}`,
        progress: 0.1 + (0.8 * (i + 1)) / tracks.length,
        run() {
          if (item.fail && i === failAt) throw new Error('The source refused the download (simulated failure).')
          const dup = lib.tracks.find((x) => fold(x.title) === fold(t.title) && fold(lib.artistById.get(x.artistIds[0])?.name ?? '') === fold(t.artist))
          if (dup) {
            skipped++
            resolved.push(dup.id)
            return
          }
          const album =
            item.kind === 'album' ? { title: item.title, type: 'album' } : item.kind === 'track' && item.album ? { title: item.album, type: 'album' } : { title: t.title, type: 'single' }
          const track = addTrack(lib, {
            title: t.title,
            artistName: t.artist,
            albumTitle: album.title,
            albumType: album.type,
            year,
            duration: t.duration,
            lyricsMode: lyricsModeFor(`${seed}:${i}`),
            now: nowIso()
          })
          added.push(track.id)
          resolved.push(track.id)
        }
      })
    })
    steps.push({
      get message() {
        if (added.length === 0) return 'Already in your library'
        return `Added ${added.length} track${added.length === 1 ? '' : 's'}${skipped ? ` (${skipped} already in the library)` : ''}`
      },
      progress: 1,
      run() {
        if (item.kind === 'playlist' && resolved.length > 0 && !lib.playlists.some((p) => fold(p.name) === fold(item.title))) {
          addPlaylist(lib, { name: item.title, description: `Imported from ${item.source === 'spotify' ? 'Spotify' : 'YouTube'}. Curated by ${item.artist}.`, trackIds: resolved })
        }
      }
    })
    return jobs.create({
      kind,
      source: jobSource,
      title: kind === 'import' ? `Import playlist: ${item.title}` : `${item.title} - ${item.artist}`,
      trackIds: added,
      steps
    })
  }

  // ---- Handlers --------------------------------------------------------------------
  const handlers = {
    stats({ res }) {
      const storage = storageBytes(lib)
      sendJson(res, 200, {
        tracks: lib.tracks.length,
        albums: lib.albums.length,
        artists: lib.artists.length,
        playlists: lib.playlists.length,
        users: auth.allEntries().length,
        storageBytes: storage,
        freeBytes: Math.max(0, DISK_TOTAL - storage),
        plays: lib.tracks.reduce((sum, t) => sum + t.plays, 0),
        activeJobs: jobs.activeCount()
      })
    },

    sourcesSearch({ req, res, query }) {
      const source = query.get('source') ?? ''
      if (!SOURCES.includes(source)) throw new HttpError(400, `"source" must be one of: ${SOURCES.join(', ')}.`)
      const q = query.get('q') ?? ''
      if (q.length > 200) throw new HttpError(400, '"q" is too long (max 200 characters).')
      sendJson(res, 200, { results: searchSource(source, q, { origin: originOf(req), libraryHas }) })
    },

    async startDownload({ req, res }) {
      const body = await readJson(req, { required: true })
      if (!SOURCES.includes(body.source)) throw new HttpError(400, `"source" must be one of: ${SOURCES.join(', ')}.`)
      const hasId = body.id !== undefined
      const hasUrl = body.url !== undefined
      if (hasId === hasUrl) throw new HttpError(400, 'Provide exactly one of "id" or "url".')
      let item, jobSource, seed
      if (hasId) {
        const parsed = parseResultId(body.id)
        if (!parsed || parsed.source !== body.source) throw new HttpError(400, '"id" is not a result id of this source.')
        item = itemFromResultId(body.id)
        jobSource = body.source
        seed = body.id
      } else {
        const parsed = parseSourceUrl(body.url)
        if (!parsed) throw new HttpError(400, 'Unsupported link. Paste a Spotify or YouTube track, album or playlist link.')
        if (parsed.source !== body.source) throw new HttpError(400, 'The link does not match the selected source.')
        item = itemFromUrl(parsed)
        jobSource = 'url'
        seed = `url:${parsed.source}:${parsed.ext}`
      }
      sendJson(res, 201, itemJob({ kind: 'download', jobSource, item, seed }))
    },

    async startImport({ req, res }) {
      const body = await readJson(req, { required: true })
      const parsed = parseSourceUrl(body.url)
      if (!parsed || parsed.kind !== 'playlist') throw new HttpError(400, 'Paste a Spotify or YouTube playlist link.')
      const item = itemFromUrl(parsed)
      sendJson(res, 201, itemJob({ kind: 'import', jobSource: parsed.source, item, seed: `import:${parsed.source}:${parsed.ext}` }))
    },

    jobsList({ res }) {
      sendJson(res, 200, { jobs: jobs.list(100) })
    },
    job({ res, params }) {
      const job = jobs.get(params[0])
      if (!job) throw new HttpError(404, 'Job not found.')
      sendJson(res, 200, job)
    },
    cancelJob({ res, params }) {
      jobs.cancel(params[0])
      sendNoContent(res)
    },

    rescan({ res }) {
      const count = lib.tracks.length
      sendJson(
        res,
        201,
        jobs.create({
          kind: 'rescan',
          title: 'Rescan library',
          steps: [
            { message: 'Scanning files', progress: 0.3 },
            { message: 'Reading tags', progress: 0.6 },
            { message: 'Updating the index', progress: 0.9, run: () => reindex(lib) },
            { message: `Scanned ${count} tracks, no changes`, progress: 1 }
          ]
        })
      )
    },

    tracks({ req, res, user, query }) {
      const q = fold(query.get('q') ?? '').trim()
      const lyrics = query.get('lyrics')
      if (lyrics !== null && lyrics !== '' && lyrics !== 'missing' && lyrics !== 'present') throw new HttpError(400, '"lyrics" must be "missing" or "present".')
      let list = lib.tracks
      if (q) list = list.filter((t) => t.search.includes(q))
      if (lyrics === 'missing') list = list.filter((t) => !t.lyricsStored)
      if (lyrics === 'present') list = list.filter((t) => t.lyricsStored)
      list = [...list].sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : a.id < b.id ? -1 : 1))
      const ctx = ctxFor(req, user)
      sendJson(res, 200, page(list, query, (t) => adminTrackJson(ctx, t)))
    },

    deleteTrack({ res, params }) {
      if (!removeTrack(lib, params[0])) throw new HttpError(404, 'Track not found.')
      for (const s of userState.values()) {
        s.liked = s.liked.filter((id) => id !== params[0])
        s.played = s.played.filter((id) => id !== params[0])
      }
      sendNoContent(res)
    },

    async setLyrics({ req, res, params }) {
      const track = lib.trackById.get(params[0])
      if (!track) throw new HttpError(404, 'Track not found.')
      const body = await readJson(req, { required: true, max: LYRICS_BODY_MAX })
      const content = validateLyrics(body.format, body.content)
      track.lyricsStored = { format: body.format, content, updatedAt: nowIso() }
      sendNoContent(res)
    },
    deleteLyrics({ res, params }) {
      const track = lib.trackById.get(params[0])
      if (!track) throw new HttpError(404, 'Track not found.')
      delete track.lyricsStored
      sendNoContent(res)
    },

    async upload({ req, res, user }) {
      const file = await readMultipartFile(req, { maxFileBytes: opt.uploadMaxBytes })
      const info = inspectAudio(file.filename, file.data)
      if (uploadedBytes(lib) + file.data.length > opt.uploadStoreMaxBytes) throw new HttpError(413, 'The upload storage of this mock server is full.')
      const { artist, title } = parseUploadName(file.filename)
      const track = addTrack(lib, {
        title,
        artistName: artist,
        albumTitle: 'Uploads',
        albumType: 'album',
        year: new Date(opt.now()).getUTCFullYear(),
        duration: info.duration,
        format: info.format,
        mime: info.mime,
        upload: { data: file.data },
        lyricsMode: 'none',
        now: nowIso()
      })
      sendJson(res, 201, adminTrackJson(ctxFor(req, user), track))
    },

    // ---- Users
    users({ req, res }) {
      const origin = originOf(req)
      sendJson(res, 200, { users: auth.allEntries().map((e) => adminUserJson(e, origin)) })
    },
    async createUser({ req, res }) {
      const body = await readJson(req, { required: true })
      const entry = auth.createUser(body)
      sendJson(res, 201, adminUserJson(entry, originOf(req)))
    },
    async updateUser({ req, res, params }) {
      const body = await readJson(req, { required: true })
      const entry = auth.updateUser(params[0], body)
      sendJson(res, 200, adminUserJson(entry, originOf(req)))
    },
    deleteUser({ res, params, user }) {
      auth.deleteUser(params[0], user.id)
      userState.delete(params[0])
      sendNoContent(res)
    },

    // ---- Backups
    backups({ res }) {
      sendJson(res, 200, { backups: [...backups].reverse().map(backupJson) })
    },
    createBackup({ res }) {
      sendJson(
        res,
        201,
        jobs.create({
          kind: 'backup',
          title: 'Create backup',
          steps: [
            { message: 'Dumping the database', progress: 0.3 },
            { message: 'Writing playlists', progress: 0.6 },
            {
              message: 'Compressing',
              progress: 0.9,
              run() {
                const snap = { library: snapshotLibrary(lib), users: cloneUsers() }
                backups.push({
                  id: `bk-${String(++backupCounter).padStart(4, '0')}`,
                  createdAt: nowIso(),
                  sizeBytes: snapshotSize(snap.library) + 512,
                  label: lib.uploads.size > 0 ? 'database+playlists+uploads' : 'database+playlists',
                  snap
                })
                while (backups.length > MAX_BACKUPS) backups.shift()
              }
            },
            { message: 'Backup complete', progress: 1 }
          ]
        })
      )
    },
    async restoreBackup({ req, res, params }) {
      const body = await readJson(req, { required: true })
      if (body.confirm !== true) throw new HttpError(400, 'Restoring replaces the current data. Send {"confirm": true} to proceed.')
      const backup = backups.find((b) => b.id === params[0])
      if (!backup) throw new HttpError(404, 'Backup not found.')
      if (jobs.hasActive('restore')) throw new HttpError(409, 'A restore is already in progress.')
      sendJson(
        res,
        202,
        jobs.create({
          kind: 'restore',
          title: `Restore backup ${backup.id}`,
          steps: [
            { message: 'Verifying the backup', progress: 0.2 },
            {
              message: 'Restoring the library',
              progress: 0.6,
              run() {
                restoreLibrary(lib, backup.snap.library)
                userState.clear()
                for (const [id, s] of backup.snap.users) {
                  if (auth.userById(id)) userState.set(id, { liked: [...s.liked], played: [...s.played] })
                }
              }
            },
            { message: 'Rebuilding indexes', progress: 0.9 },
            { message: 'Restore complete', progress: 1 }
          ]
        })
      )
    }
  }

  const E = '([^/]+)'
  const routes = [
    [['GET'], /^\/v1\/admin\/stats$/, handlers.stats],
    [['GET'], /^\/v1\/admin\/sources\/search$/, handlers.sourcesSearch],
    [['POST'], /^\/v1\/admin\/downloads$/, handlers.startDownload],
    [['POST'], /^\/v1\/admin\/imports$/, handlers.startImport],
    [['GET'], /^\/v1\/admin\/jobs$/, handlers.jobsList],
    [['GET'], new RegExp(`^/v1/admin/jobs/${E}$`), handlers.job],
    [['DELETE'], new RegExp(`^/v1/admin/jobs/${E}$`), handlers.cancelJob],
    [['POST'], /^\/v1\/admin\/library\/rescan$/, handlers.rescan],
    [['GET'], /^\/v1\/admin\/tracks$/, handlers.tracks],
    [['DELETE'], new RegExp(`^/v1/admin/tracks/${E}$`), handlers.deleteTrack],
    [['PUT'], new RegExp(`^/v1/admin/tracks/${E}/lyrics$`), handlers.setLyrics],
    [['DELETE'], new RegExp(`^/v1/admin/tracks/${E}/lyrics$`), handlers.deleteLyrics],
    [['POST'], /^\/v1\/admin\/uploads$/, handlers.upload],
    [['GET'], /^\/v1\/admin\/users$/, handlers.users],
    [['POST'], /^\/v1\/admin\/users$/, handlers.createUser],
    [['PATCH'], new RegExp(`^/v1/admin/users/${E}$`), handlers.updateUser],
    [['DELETE'], new RegExp(`^/v1/admin/users/${E}$`), handlers.deleteUser],
    [['GET'], /^\/v1\/admin\/backups$/, handlers.backups],
    [['POST'], /^\/v1\/admin\/backups$/, handlers.createBackup],
    [['POST'], new RegExp(`^/v1/admin/backups/${E}/restore$`), handlers.restoreBackup]
  ]

  return { routes, adminUserJson, adminTrackJson }
}

