import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assetUrl, buildSource, makeEntry, marketingVersion, DEFAULT_TEMPLATE } from './altstore-source.mjs'

const template = JSON.parse(readFileSync(DEFAULT_TEMPLATE, 'utf8'))
const entry = (version, extra = {}) =>
  makeEntry({ version, date: '2026-01-01T00:00:00Z', downloadURL: assetUrl('o/r', `v${version}`, `Nocturne-${version}-unsigned.ipa`), size: 1234, ...extra })

test('marketingVersion strips pre-release suffixes', () => {
  assert.equal(marketingVersion('v1.2.3-beta.4'), '1.2.3')
  assert.equal(marketingVersion('1.0.9'), '1.0.9')
})

test('assetUrl points at the release asset', () => {
  assert.equal(assetUrl('o/r', 'v1.0.9', 'Nocturne-1.0.9-unsigned.ipa'), 'https://github.com/o/r/releases/download/v1.0.9/Nocturne-1.0.9-unsigned.ipa')
})

test('buildSource from the template adds the first version', () => {
  const out = buildSource({ template, entry: entry('1.0.9') })
  assert.equal(out.apps[0].bundleIdentifier, 'es.alexcloudweb.nocturne')
  assert.equal(out.apps[0].versions.length, 1)
  assert.equal(out.apps[0].versions[0].minOSVersion, '15.0')
  assert.equal(template.apps[0].versions.length, 0, 'template is not mutated')
})

test('buildSource keeps older versions newest first and replaces a re-published one', () => {
  const first = buildSource({ template, entry: entry('1.0.8') })
  const second = buildSource({ template, existing: first, entry: entry('1.0.9') })
  assert.deepEqual(second.apps[0].versions.map((v) => v.version), ['1.0.9', '1.0.8'])
  const again = buildSource({ template, existing: second, entry: entry('1.0.9', { size: 999 }) })
  assert.deepEqual(again.apps[0].versions.map((v) => v.version), ['1.0.9', '1.0.8'])
  assert.equal(again.apps[0].versions[0].size, 999)
})

test('makeEntry rejects a missing size', () => {
  assert.throws(() => makeEntry({ version: '1', date: 'd', downloadURL: 'u', size: 0 }), /size/)
})
