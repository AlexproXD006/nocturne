#!/usr/bin/env node
// Builds release/nocturne-server-kit/ (+ .tar.gz): everything Claude Code needs ON the server to
// turn NOVA into Nocturne's backend and serve the hosted web app. Run via `npm run kit`
// (which builds dist-hosted first). Pure Node 22, no dependencies.
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'release', 'nocturne-server-kit')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const builtAt = new Date().toISOString()

function fail(msg) {
  console.error(`make-server-kit: ${msg}`)
  process.exit(1)
}

const webSrc = join(root, 'dist-hosted')
if (!existsSync(join(webSrc, 'index.html'))) fail('dist-hosted/index.html missing - run `npm run build:hosted` first (or `npm run kit`).')
const indexHtml = readFileSync(join(webSrc, 'index.html'), 'utf8')
if (!/src="\/assets\//.test(indexHtml)) fail('dist-hosted/index.html does not reference /assets/ - was it built with --mode hosted?')

// ---- Extract and adapt the server prompt -------------------------------------------------
const promptMd = readFileSync(join(root, 'SERVER_PROMPT.md'), 'utf8')
const fence = promptMd.match(/````text\n([\s\S]*?)\n````/)
if (!fence) fail('could not find the ````text fenced prompt in SERVER_PROMPT.md')
let prompt = fence[1]

const replacements = [
  [
    /4\.1 Get the build\. If the user already copied `dist-hosted\/`[\s\S]*?\(atomic: create the new link under a temp name, then `mv -T`\)\./,
    '4.1 Get the build. The hosted build ships with this kit in `$KIT/web/` (built by `npm run build:hosted`; see `$KIT/web/BUILD_INFO.txt`). FIRST verify it: `cd "$KIT" && sha256sum -c SHA256SUMS` must report OK for every file; if anything fails, STOP and tell the user (do not install a modified build). Then validate it (index.html exists, an `assets/` folder exists, index.html references only root-relative `/assets/` files) and install it as a release: copy `$KIT/web/` to `<NOCTURNE_WEB_RELEASES>/<version>-<timestamp>/` (default /opt/nocturne/web-releases/) and point the symlink `NOCTURNE_WEB_DIR` (default /opt/nocturne/web) at it. Keep the previous releases (at least the last 3) for rollback: switching releases is repointing the symlink (atomic: create the new link under a temp name, then `mv -T`). Write a tiny `install-web-release.sh` next to the releases (usage: `install-web-release.sh /path/to/new/web`) that repeats exactly these steps so the user can update the web app later without you.'
  ],
  [
    /\(c\) How the web build gets onto the machine \(copied by the user, or built here if Node >= 22 and the Nocturne sources are present\)\./,
    '(c) The web build ships with this kit (`$KIT/web/`); confirm where it will be installed.'
  ],
  [
    /- The Nocturne client source is optional reference only; everything you need is in this prompt\./,
    '- Everything you need is in this prompt. Reference copies of the client contract live in `$KIT/reference/` (`types.ts` and `client.ts` are the source of truth for every JSON shape; `API.md` and `HOSTED_AND_ADMIN.md` are the human-readable spec; `mock-server/` is a working Node reference implementation of the exact same API - read it when a detail is ambiguous, NEVER deploy it). If this prompt and `types.ts` ever disagree on a field name or shape, `types.ts` wins.'
  ]
]
for (const [re, text] of replacements) {
  if (!re.test(prompt)) fail(`prompt section not found for replacement: ${re}`)
  prompt = prompt.replace(re, text)
}

const kitContext = `KIT CONTEXT. You were started from the "Nocturne server kit" (Nocturne ${pkg.version}, built ${builtAt}). Let KIT be the absolute path of the kit's root folder: the directory that contains this kit's CLAUDE.md, SHA256SUMS and the web/ and reference/ folders (normally your starting working directory; confirm with \`pwd\` and \`ls\` and use the absolute path in every command). The kit is read-only input: never modify files inside it. NOVA itself lives elsewhere on this machine; find it in step 1. Write your working notes, plans and checkpoint summaries to $KIT/../nocturne-migration-notes.md (create it) so the user can read them later.

If the user passed extra instructions after the command, they follow here and take precedence over defaults in this prompt (never over the safety rules): $ARGUMENTS

`

const skill = `---
description: Convierte NOVA en el backend de Nocturne en esta máquina (API /v1 y /v1/admin, sesión por cookie, letras TTML, web alojada en /) y retira la web antigua de NOVA, con copias de seguridad y paradas de confirmación.
argument-hint: "[instrucciones extra opcionales]"
disable-model-invocation: true
---

${kitContext}${prompt}
`

// ---- Assemble the kit -------------------------------------------------------------------
rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, '.claude', 'skills', 'migrar-nocturne'), { recursive: true })
writeFileSync(join(out, '.claude', 'skills', 'migrar-nocturne', 'SKILL.md'), skill)

// Safety net that applies immediately (ask/deny rules don't wait for workspace trust).
const settings = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  permissions: {
    ask: [
      'Bash(rm *)',
      'Bash(rmdir *)',
      'Bash(shred *)',
      'Bash(truncate *)',
      'Bash(find * -delete*)',
      'Bash(systemctl stop *)',
      'Bash(systemctl restart *)',
      'Bash(systemctl disable *)',
      'Bash(systemctl reload *)',
      'Bash(docker compose down*)',
      'Bash(docker compose up*)',
      'Bash(docker compose restart*)',
      'Bash(docker rm *)',
      'Bash(docker stop *)',
      'Bash(docker restart *)',
      'Bash(nginx -s *)',
      'Bash(git reset --hard*)',
      'Bash(git clean *)',
      'Bash(git checkout -- *)',
      'Bash(git push *)',
      'Bash(crontab *)',
      'Bash(ufw *)',
      'Bash(iptables *)'
    ],
    deny: [
      'Bash(dd *)',
      'Bash(mkfs*)',
      'Bash(docker volume rm *)',
      'Bash(docker volume prune*)',
      'Bash(docker system prune*)',
      'Bash(chmod -R 777 *)',
      'Edit(./web/**)',
      'Edit(./reference/**)',
      'Edit(./SHA256SUMS)'
    ]
  }
}
writeFileSync(join(out, '.claude', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`)

writeFileSync(
  join(out, 'CLAUDE.md'),
  `# Nocturne server kit

This folder is a deployment kit, not a project to edit. It contains:

- \`web/\` - the hosted Nocturne web app (static SPA, built ${builtAt}, Nocturne ${pkg.version}). Install it, never edit it.
- \`reference/\` - the API contract: \`types.ts\` + \`client.ts\` (source of truth for JSON shapes), \`API.md\`, \`HOSTED_AND_ADMIN.md\`, \`SECURITY.md\`, \`DEPLOY.md\`, and \`mock-server/\` (a Node reference implementation of the same API, for reading only - never deploy it).
- \`SHA256SUMS\` - checksums of \`web/\` and \`reference/\`; verify with \`sha256sum -c SHA256SUMS\` before installing anything.
- \`.claude/skills/migrar-nocturne/\` - the migration procedure. The user starts it with \`/migrar-nocturne\`.

Standing rules for any session in this folder:
- Never delete or move music files. Back up code, database and proxy config before changing them.
- Stop at every CHECKPOINT in the procedure and wait for the user's explicit OK before irreversible steps (cutover, proxy change, restart, deleting anything).
- Never print secrets (tokens, passwords, keys, signing secrets) to the terminal or into notes.
- Talk to the user in Spanish; keep code, commands and identifiers in English.
`
)

writeFileSync(
  join(out, 'LEEME.md'),
  `# Kit de servidor de Nocturne

Este kit deja tu servidor **music.example.com** listo para Nocturne: NOVA pasa a ser solo el motor interno,
se añade la API \`/v1\` + \`/v1/admin\` (login real, roles, sesión por cookie, letras TTML), se sirve la web de
Nocturne en \`/\` y se retira la web antigua de NOVA cerrando \`/api/*\` al público.

Versión: Nocturne ${pkg.version} · generado ${builtAt}

## Cómo usarlo

1. **Copia el kit al servidor** (desde tu PC):

   \`\`\`bash
   scp nocturne-server-kit.tar.gz usuario@tu-servidor:~
   \`\`\`

2. **En el servidor**, descomprímelo y comprueba que llegó intacto:

   \`\`\`bash
   tar -xzf nocturne-server-kit.tar.gz
   cd nocturne-server-kit
   sha256sum -c SHA256SUMS --quiet && echo "Kit OK"
   \`\`\`

3. **Abre Claude Code dentro de la carpeta del kit** (si no lo tienes instalado en el servidor:
   \`curl -fsSL https://claude.ai/install.sh | bash\` o \`npm install -g @anthropic-ai/claude-code\`):

   \`\`\`bash
   claude
   \`\`\`

   Si sabes dónde está NOVA, dale acceso desde el principio para que no te pregunte por cada archivo:
   \`claude --add-dir /ruta/a/nova\` (y la de la configuración del proxy si está en otra carpeta).
   Claude Code te pedirá que confíes en la carpeta del kit: acéptalo.

4. **Lanza la migración** escribiendo:

   \`\`\`
   /migrar-nocturne
   \`\`\`

   Puedes añadir indicaciones detrás, por ejemplo:
   \`/migrar-nocturne NOVA está en /opt/nova y corre con docker compose\`.

## Qué esperar

- Primero investiga y hace **copia de seguridad completa** (código, base de datos, proxy). Nunca toca la música.
- Se para en **5 puntos de control** y no sigue sin tu OK: plan inicial, tests antes de producción,
  retirada de la web antigua, cambio del proxy y reinicio.
- Va dejando notas en \`../nocturne-migration-notes.md\` (junto a la carpeta del kit).
- Además del procedimiento, el kit trae **reglas de seguridad para Claude Code**: cualquier \`rm\`, reinicio de
  servicios, \`docker compose down\`, \`git reset --hard\`, etc. **te pide confirmación siempre**, y comandos como
  \`dd\`, \`mkfs\` o borrar volúmenes de Docker están **bloqueados**.
- Al final te imprime un resumen y el comando para **crear tu usuario administrador**. Luego entra en
  \`https://music.example.com\` con ese usuario (o pon esa dirección como servidor en la app de escritorio/Android).

## Lo que dejará de funcionar

Cualquier script, marcador o automatización que llame a \`/api/*\` desde fuera, porque la API antigua deja de ser
pública (te preguntará antes de cerrarla).

## Actualizar la web más adelante

En tu PC: \`npm run kit\` genera un kit nuevo. Cópialo al servidor y ejecuta el script
\`install-web-release.sh\` que el agente deja instalado (o vuelve a abrir \`claude\` en el kit nuevo y pídele
"instala solo la nueva web").
`
)

// web/ + build info
cpSync(webSrc, join(out, 'web'), { recursive: true })
writeFileSync(
  join(out, 'web', 'BUILD_INFO.txt'),
  `Nocturne hosted web build\nversion: ${pkg.version}\nbuilt: ${builtAt}\nmode: hosted (talks to location.origin, cookie session)\n`
)

// reference/
const ref = join(out, 'reference')
mkdirSync(ref, { recursive: true })
const refFiles = [
  ['src/renderer/src/api/types.ts', 'types.ts'],
  ['src/renderer/src/api/client.ts', 'client.ts'],
  ['docs/API.md', 'API.md'],
  ['docs/HOSTED_AND_ADMIN.md', 'HOSTED_AND_ADMIN.md'],
  ['docs/SECURITY.md', 'SECURITY.md'],
  ['docs/DEPLOY.md', 'DEPLOY.md']
]
for (const [from, to] of refFiles) {
  if (!existsSync(join(root, from))) fail(`missing reference file ${from}`)
  cpSync(join(root, from), join(ref, to))
}
cpSync(join(root, 'mock-server'), join(ref, 'mock-server'), {
  recursive: true,
  filter: (src) => !src.includes(`${sep}node_modules`)
})
writeFileSync(
  join(ref, 'mock-server', 'REFERENCE_ONLY.txt'),
  'Reference implementation of the Nocturne API used for development and tests.\nRead it to resolve ambiguities. Do NOT deploy it: it keeps everything in memory and serves invented demo data.\n'
)

// SHA256SUMS over web/ and reference/
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}
const sums = [...walk(join(out, 'web')), ...walk(ref)]
  .map((file) => `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${relative(out, file).split(sep).join('/')}`)
  .sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1))
writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`)

// tar.gz next to the folder
const tarball = join(root, 'release', 'nocturne-server-kit.tar.gz')
rmSync(tarball, { force: true })
try {
  execFileSync('tar', ['-czf', tarball, '-C', join(root, 'release'), 'nocturne-server-kit'], { stdio: 'inherit' })
  console.log(`make-server-kit: wrote ${relative(root, tarball)}`)
} catch {
  console.warn('make-server-kit: `tar` not available; the kit folder is ready but not archived.')
}
console.log(`make-server-kit: kit ready in ${relative(root, out)} (${sums.length} checksummed files)`)
