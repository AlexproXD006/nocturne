import { describe, expect, it, vi } from 'vitest'
import { ApiClient } from '@/api/client'
import { ApiError, describeError } from '@/api/errors'
import { setLanguagePref } from '@/i18n'
import { storedSession } from '../helpers/fixtures'
import { jsonResponse, textResponse, fakeFetch } from '../helpers/http'

const client = (fetch: ReturnType<typeof fakeFetch>, signedIn = true): ApiClient =>
  new ApiClient({ getSession: () => (signedIn ? storedSession({ expiresAt: Date.now() + 3_600_000 }) : null), setSession: vi.fn(), fetch })

describe('localised API errors', () => {
  it('maps status codes to translated default messages', () => {
    expect(ApiError.fromStatus(403).message).toBe("You don't have access to that.")
    expect(ApiError.fromStatus(500).message).toBe('The server had a problem. Try again in a moment.')
    setLanguagePref('es')
    expect(ApiError.fromStatus(403).message).toBe('No tienes acceso a eso.')
    expect(ApiError.fromStatus(404).message).toBe('No hemos encontrado eso.')
    expect(ApiError.fromStatus(429).message).toContain('Demasiadas solicitudes')
    expect(ApiError.fromStatus(500).message).toContain('El servidor ha tenido un problema')
    expect(ApiError.fromStatus(400).message).toBe('Algo ha salido mal.')
    expect(describeError('boom')).toBe('Algo ha salido mal.')
  })

  it('keeps the server-provided message untouched', () => {
    setLanguagePref('es')
    expect(ApiError.fromStatus(400, 'Name already taken').message).toBe('Name already taken')
  })

  it('translates client-side failures (keystore download, signed out, network)', async () => {
    const failing = fakeFetch(() => textResponse('nope', { status: 500 }))
    await expect(client(failing).adminDownloadKeystore()).rejects.toThrow('Keystore download failed (500)')
    await expect(client(failing, false).adminDownloadKeystore()).rejects.toThrow('You are signed out.')
    setLanguagePref('es')
    await expect(client(failing).adminDownloadKeystore()).rejects.toThrow('Error al descargar el almacén de claves (500)')
    await expect(client(failing, false).adminDownloadKeystore()).rejects.toThrow('Has cerrado sesión.')
    const down = fakeFetch(() => Promise.reject(new TypeError('fetch failed')))
    await expect(client(down).me()).rejects.toThrow('No se puede conectar con el servidor. Revisa tu conexión.')
    const bad = fakeFetch(() => jsonResponse({}, { status: 200, headers: { 'Content-Type': 'text/html' } }))
    await expect(client(bad).me()).rejects.toThrow()
  })
})
