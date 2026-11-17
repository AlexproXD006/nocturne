import { SECURE_KEY_PATTERN, SECURE_VALUE_MAX } from '../shared/ipc'

export interface Cipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface StoreFs {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

interface FileShape {
  v: 1
  encrypted: boolean
  entries: Record<string, string>
}

/**
 * Small key/value store for secrets (session tokens). Values are encrypted with
 * Electron's safeStorage (DPAPI on Windows, libsecret/kwallet on Linux). Writes are
 * atomic (tmp file + rename) and serialized.
 */
export class SecureStore {
  private cache: FileShape | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
    private readonly fs: StoreFs
  ) {}

  get encrypted(): boolean {
    return this.cipher.isEncryptionAvailable()
  }

  static validateKey(key: unknown): asserts key is string {
    if (typeof key !== 'string' || !SECURE_KEY_PATTERN.test(key)) throw new Error('Invalid secure-store key')
  }

  static validateValue(value: unknown): asserts value is string {
    if (typeof value !== 'string' || value.length > SECURE_VALUE_MAX) throw new Error('Invalid secure-store value')
  }

  async get(key: string): Promise<string | null> {
    SecureStore.validateKey(key)
    const data = await this.load()
    // Own properties only: `entries['constructor']` must not resolve to Object.prototype's.
    const stored = Object.hasOwn(data.entries, key) ? data.entries[key] : undefined
    if (typeof stored !== 'string') return null
    try {
      return this.decode(stored, data.encrypted)
    } catch {
      // Keychain changed or file tampered with: treat as missing and drop it.
      await this.delete(key)
      return null
    }
  }

  set(key: string, value: string): Promise<void> {
    SecureStore.validateKey(key)
    SecureStore.validateValue(value)
    return this.mutate((data) => {
      data.entries[key] = this.encode(value, data.encrypted)
    })
  }

  delete(key: string): Promise<void> {
    SecureStore.validateKey(key)
    return this.mutate((data) => {
      delete data.entries[key]
    })
  }

  private encode(value: string, encrypted: boolean): string {
    return encrypted
      ? this.cipher.encryptString(value).toString('base64')
      : Buffer.from(value, 'utf8').toString('base64')
  }

  private decode(stored: string, encrypted: boolean): string {
    const buf = Buffer.from(stored, 'base64')
    return encrypted ? this.cipher.decryptString(buf) : buf.toString('utf8')
  }

  private async load(): Promise<FileShape> {
    if (this.cache) return this.cache
    const encrypted = this.cipher.isEncryptionAvailable()
    let parsed: FileShape = { v: 1, encrypted, entries: {} }
    try {
      const raw = JSON.parse(await this.fs.readFile(this.file)) as Partial<FileShape>
      if (raw && raw.v === 1 && typeof raw.entries === 'object' && raw.entries !== null) {
        // If encryption availability changed, old entries can't be trusted to decode.
        parsed = raw.encrypted === encrypted ? { v: 1, encrypted, entries: { ...raw.entries } } : parsed
      }
    } catch {
      /* missing or corrupt file: start empty */
    }
    this.cache = parsed
    return parsed
  }

  private mutate(fn: (data: FileShape) => void): Promise<void> {
    const run = async (): Promise<void> => {
      const current = await this.load()
      // Work on a copy so a failed write leaves the in-memory view matching the disk.
      const data: FileShape = { ...current, entries: { ...current.entries } }
      fn(data)
      const tmp = `${this.file}.tmp`
      await this.fs.writeFile(tmp, JSON.stringify(data))
      await this.fs.rename(tmp, this.file)
      this.cache = data
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }
}
