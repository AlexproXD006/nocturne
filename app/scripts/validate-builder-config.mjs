// Validates electron-builder.yml against the installed electron-builder JSON schema.
// Usage: node scripts/validate-builder-config.mjs   (exit code 1 on problems)
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const yaml = require('js-yaml')
const schema = JSON.parse(readFileSync(require.resolve('app-builder-lib/scheme.json'), 'utf8'))
const config = yaml.load(readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8'))

let Ajv
try {
  Ajv = require('ajv')
} catch {
  Ajv = null
}

const problems = []

/** Minimal fallback walker: only checks that every key exists in the schema. */
function unknownKeys(value, def, path) {
  const resolveRef = (d) => (d && d.$ref ? schema.definitions[d.$ref.replace('#/definitions/', '')] : d)
  const candidates = (d) => {
    d = resolveRef(d)
    if (!d) return []
    if (d.anyOf || d.oneOf) return (d.anyOf ?? d.oneOf).flatMap(candidates)
    return [d]
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const objs = candidates(def).filter((d) => d.properties)
  if (!objs.length) return
  for (const [key, child] of Object.entries(value)) {
    const hit = objs.find((d) => d.properties[key])
    if (!hit) {
      if (!objs.some((d) => d.additionalProperties !== false)) problems.push(`${path}${key}: unknown key`)
      continue
    }
    unknownKeys(child, hit.properties[key], `${path}${key}.`)
  }
}

if (Ajv) {
  const ajv = new Ajv({ allErrors: true, strict: false })
  const validate = ajv.compile(schema)
  if (!validate(config)) for (const e of validate.errors) problems.push(`${e.instancePath || '/'} ${e.message}`)
} else {
  unknownKeys(config, schema, '')
}

if (problems.length) {
  console.error(`electron-builder.yml has ${problems.length} problem(s):`)
  for (const p of problems) console.error(' -', p)
  process.exit(1)
}
console.log(`electron-builder.yml is valid (${Ajv ? 'ajv' : 'key walk'}).`)
