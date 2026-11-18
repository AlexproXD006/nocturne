// Builds / updates an AltStore + SideStore source (v2 format) for the Nocturne iOS build.
//
//   node scripts/altstore-source.mjs --version 1.0.9 --ipa Nocturne-1.0.9-unsigned.ipa \
//        --tag v1.0.9 --repo AlexproXD006/nocturne [--existing altstore.json] [--out altstore.json]
//
// --existing  a previously published source: its older versions are kept (newest first, max 10).
// --size / --url / --notes / --date / --min-os override what is derived from the other flags.
// The result is a static file; serve it at https://nocturne.alexcloudweb.es/altstore.json.
import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_TEMPLATE = join(HERE, 'altstore-source.template.json')
export const MAX_VERSIONS = 10

/** "1.0.9-beta.2" -> "1.0.9" (CFBundleShortVersionString cannot carry a pre-release suffix). */
export function marketingVersion(v) {
  return String(v).replace(/^v/, '').split(/[-+]/)[0]
}

/** Release-asset URL, matching the file name CI uploads. */
export function assetUrl(repo, tag, fileName) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`
}

/** Merge a new version entry into a source (template or previously published). Pure. */
export function buildSource({ template, existing, entry }) {
  const base = structuredClone(existing ?? template)
  const app = base.apps?.[0]
  if (!app) throw new Error('source has no apps[0]')
  // Refresh static metadata from the template so edits to it apply on the next release.
  for (const k of ['name', 'identifier', 'subtitle', 'description', 'website', 'iconURL', 'tintColor']) {
    if (template[k] !== undefined) base[k] = template[k]
  }
  const tApp = template.apps?.[0] ?? {}
  for (const k of ['name', 'bundleIdentifier', 'developerName', 'subtitle', 'localizedDescription', 'iconURL', 'tintColor', 'category', 'screenshots', 'appPermissions']) {
    if (tApp[k] !== undefined) app[k] = tApp[k]
  }
  const versions = Array.isArray(app.versions) ? app.versions.filter((v) => v.version !== entry.version) : []
  app.versions = [entry, ...versions].slice(0, MAX_VERSIONS)
  base.news ??= []
  return base
}

export function makeEntry({ version, buildVersion, date, notes, downloadURL, size, minOSVersion }) {
  const entry = {
    version,
    buildVersion: String(buildVersion ?? '1'),
    date,
    localizedDescription: notes || `Nocturne ${version}`,
    downloadURL,
    size,
    minOSVersion: minOSVersion || '15.0'
  }
  for (const [k, v] of Object.entries(entry)) {
    if (v === undefined || v === null || v === '' || (k === 'size' && !(v > 0))) throw new Error(`missing or invalid "${k}"`)
  }
  return entry
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`)
    const key = a.slice(2)
    const val = argv[++i]
    if (val === undefined) throw new Error(`--${key} needs a value`)
    out[key] = val
  }
  return out
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  if (!a.version) throw new Error('--version is required (e.g. 1.0.9 or 1.1.0-beta.1)')
  const tag = a.tag ?? `v${a.version.replace(/^v/, '')}`
  const version = a.version.replace(/^v/, '')
  const ipaName = a.ipa ? a.ipa.split(/[\\/]/).pop() : `Nocturne-${version}-unsigned.ipa`
  const size = a.size ? Number(a.size) : a.ipa ? (await stat(a.ipa)).size : 0
  const downloadURL = a.url ?? assetUrl(a.repo ?? 'AlexproXD006/nocturne', tag, ipaName)
  const entry = makeEntry({
    // Same string as CFBundleShortVersionString in the .ipa, or AltStore never sees it as installed.
    version: marketingVersion(version),
    buildVersion: a.build ?? '1',
    date: a.date ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    notes: a.notes,
    downloadURL,
    size,
    minOSVersion: a['min-os']
  })
  const template = await readJson(a.template ? resolve(a.template) : DEFAULT_TEMPLATE)
  let existing
  if (a.existing) {
    try {
      existing = await readJson(resolve(a.existing))
    } catch {
      existing = undefined // first publish / unreadable: start from the template
    }
  }
  const out = buildSource({ template, existing, entry })
  const json = `${JSON.stringify(out, null, 2)}\n`
  if (a.out) await writeFile(resolve(a.out), json)
  else process.stdout.write(json)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`altstore-source: ${e.message}`)
    process.exit(1)
  })
}
