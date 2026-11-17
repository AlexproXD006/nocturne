// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SecureStore, type Cipher, type StoreFs } from '../../src/main/secure-store'
import { SECURE_VALUE_MAX } from '../../src/shared/ipc'

const FILE = '/data/secure.json'

class FakeCipher implements Cipher {
  available = true
  failDecrypt = false
  encryptCalls = 0
  isEncryptionAvailable(): boolean {
    return this.available
  }
  encryptString(plain: string): Buffer {
    this.encryptCalls++
    return Buffer.from(`ENC:${[...plain].reverse().join('')}`, 'utf8')
  }
  decryptString(buf: Buffer): string {
    if (this.failDecrypt) throw new Error('keychain changed')
    const s = buf.toString('utf8')
    if (!s.startsWith('ENC:')) throw new Error('bad ciphertext')
    return [...s.slice(4)].reverse().join('')
  }
}

class FakeFs implements StoreFs {
  files = new Map<string, string>()
  log: string[] = []
  writeDelay = 0
  failWrite = false
  failWriteTimes = 0
  failRename = false
  inflight = 0
  maxInflight = 0

  async readFile(path: string): Promise<string> {
    this.log.push(`read ${path}`)
    const v = this.files.get(path)
    if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return v
  }
  async writeFile(path: string, data: string): Promise<void> {
    this.inflight++
    this.maxInflight = Math.max(this.maxInflight, this.inflight)
    this.log.push(`write ${path}`)
    try {
      if (this.writeDelay) await new Promise((r) => setTimeout(r, this.writeDelay))
      if (this.failWrite || this.failWriteTimes-- > 0) throw new Error('disk full')
      this.files.set(path, data)
    } finally {
      this.inflight--
    }
  }
  async rename(from: string, to: string): Promise<void> {
    this.log.push(`rename ${from} ${to}`)
    if (this.failRename) throw new Error('rename failed')
    const v = this.files.get(from)
    if (v === undefined) throw new Error('ENOENT')
    this.files.delete(from)
    this.files.set(to, v)
  }
}

let cipher: FakeCipher
let fs: FakeFs
const make = (): SecureStore => new SecureStore(FILE, cipher, fs)

beforeEach(() => {
  cipher = new FakeCipher()
  fs = new FakeFs()
})

describe('roundtrip', () => {
  it('returns null for a missing key and does not require the file to exist', async () => {
    expect(await make().get('session')).toBeNull()
  })

  it('stores and returns values, encrypting them on disk', async () => {
    const store = make()
    await store.set('session', 'super-secret-token')
    expect(await store.get('session')).toBe('super-secret-token')
    const onDisk = fs.files.get(FILE)!
    expect(onDisk).not.toContain('super-secret-token')
    const parsed = JSON.parse(onDisk)
    expect(parsed.v).toBe(1)
    expect(parsed.encrypted).toBe(true)
    expect(Buffer.from(parsed.entries.session, 'base64').toString()).toBe('ENC:nekot-terces-repus')
    expect(cipher.encryptCalls).toBe(1)
  })

  it('persists across store instances', async () => {
    await make().set('session', 'abc')
    expect(await make().get('session')).toBe('abc')
  })

  it('handles unicode and large (max length) values', async () => {
    const store = make()
    await store.set('unicode', 'héllo 🎵 日本語')
    expect(await store.get('unicode')).toBe('héllo 🎵 日本語')
    const big = 'x'.repeat(SECURE_VALUE_MAX)
    await store.set('big', big)
    expect(await store.get('big')).toBe(big)
  })

  it('overwrites and deletes', async () => {
    const store = make()
    await store.set('k', 'one')
    await store.set('k', 'two')
    expect(await store.get('k')).toBe('two')
    await store.delete('k')
    expect(await store.get('k')).toBeNull()
    expect(JSON.parse(fs.files.get(FILE)!).entries).toEqual({})
  })

  it('deleting a missing key is a no-op that still succeeds', async () => {
    await expect(make().delete('nope')).resolves.toBeUndefined()
  })

  it('keeps keys independent', async () => {
    const store = make()
    await store.set('a', '1')
    await store.set('b', '2')
    await store.delete('a')
    expect(await store.get('a')).toBeNull()
    expect(await store.get('b')).toBe('2')
  })

  it('reads the file only once (cached)', async () => {
    const store = make()
    await store.get('a')
    await store.get('b')
    await store.set('c', 'x')
    expect(fs.log.filter((l) => l.startsWith('read'))).toHaveLength(1)
  })
})

describe('plaintext mode (encryption unavailable)', () => {
  beforeEach(() => {
    cipher.available = false
  })

  it('reports encrypted=false', () => {
    expect(make().encrypted).toBe(false)
    cipher.available = true
    expect(make().encrypted).toBe(true)
  })

  it('stores base64 without touching the cipher and roundtrips', async () => {
    const store = make()
    await store.set('session', 'hello')
    expect(cipher.encryptCalls).toBe(0)
    const parsed = JSON.parse(fs.files.get(FILE)!)
    expect(parsed.encrypted).toBe(false)
    expect(Buffer.from(parsed.entries.session, 'base64').toString('utf8')).toBe('hello')
    expect(await store.get('session')).toBe('hello')
    expect(await make().get('session')).toBe('hello')
  })
})

describe('encryption availability changes', () => {
  it('discards entries written in a different mode', async () => {
    await make().set('session', 'tok')
    cipher.available = false
    const store = make()
    expect(await store.get('session')).toBeNull()
    // the next write starts a fresh plaintext file
    await store.set('other', 'v')
    const parsed = JSON.parse(fs.files.get(FILE)!)
    expect(parsed.encrypted).toBe(false)
    expect(Object.keys(parsed.entries)).toEqual(['other'])
  })

  it('also discards plaintext entries once encryption becomes available', async () => {
    cipher.available = false
    await make().set('session', 'tok')
    cipher.available = true
    expect(await make().get('session')).toBeNull()
  })
})

describe('corrupt or foreign files', () => {
  it.each([
    ['not json', '{{{'],
    ['empty', ''],
    ['null', 'null'],
    ['wrong version', JSON.stringify({ v: 2, encrypted: true, entries: {} })],
    ['entries missing', JSON.stringify({ v: 1, encrypted: true })],
    ['entries null', JSON.stringify({ v: 1, encrypted: true, entries: null })],
    ['entries string', JSON.stringify({ v: 1, encrypted: true, entries: 'x' })]
  ])('starts empty when the file is %s', async (_name, content) => {
    fs.files.set(FILE, content)
    const store = make()
    expect(await store.get('session')).toBeNull()
    await store.set('session', 'ok')
    expect(await make().get('session')).toBe('ok')
  })
})

describe('decrypt failures', () => {
  it('drops the key and returns null', async () => {
    const store = make()
    await store.set('session', 'tok')
    await store.set('keep', 'me')
    cipher.failDecrypt = true
    expect(await store.get('session')).toBeNull()
    cipher.failDecrypt = false
    // the entry was removed from disk, not only from memory
    expect(JSON.parse(fs.files.get(FILE)!).entries.session).toBeUndefined()
    expect(await make().get('session')).toBeNull()
  })

  it('drops tampered ciphertext', async () => {
    fs.files.set(FILE, JSON.stringify({ v: 1, encrypted: true, entries: { session: Buffer.from('garbage').toString('base64') } }))
    const store = make()
    expect(await store.get('session')).toBeNull()
    expect(JSON.parse(fs.files.get(FILE)!).entries).toEqual({})
  })
})

describe('validation', () => {
  it.each(['', 'UPPER', 'has space', '../escape', 'a/b', 'a\\b', '-leading', '.dot', 'x'.repeat(65), 'null\0byte', 'ünï'])(
    'rejects key %j',
    async (key) => {
      const store = make()
      await expect(store.get(key)).rejects.toThrow('Invalid secure-store key')
      expect(() => store.set(key, 'v')).toThrow('Invalid secure-store key')
      expect(() => store.delete(key)).toThrow('Invalid secure-store key')
    }
  )

  it.each([undefined, null, 1, {}, ['a']])('rejects non-string key %p', (key) => {
    expect(() => SecureStore.validateKey(key)).toThrow('Invalid secure-store key')
  })

  it.each(['a', 'session', 'a.b_c-d', '0abc', 'x'.repeat(64)])('accepts key %s', (key) => {
    expect(() => SecureStore.validateKey(key)).not.toThrow()
  })

  it('rejects non-string and oversized values', () => {
    const store = make()
    for (const v of [undefined, null, 5, {}, ['x']]) {
      expect(() => store.set('k', v as never)).toThrow('Invalid secure-store value')
    }
    expect(() => store.set('k', 'x'.repeat(SECURE_VALUE_MAX + 1))).toThrow('Invalid secure-store value')
    expect(() => SecureStore.validateValue('')).not.toThrow()
  })

  it('does not touch the disk when validation fails', () => {
    const store = make()
    expect(() => store.set('BAD', 'v')).toThrow()
    expect(fs.log).toEqual([])
  })

  it('does not allow prototype keys to leak', async () => {
    const store = make()
    expect(await store.get('constructor')).toBeNull()
    // no spurious "drop the broken entry" write happened
    expect(fs.log.filter((l) => l.startsWith('write'))).toEqual([])
    await store.set('constructor', 'mine')
    expect(await store.get('constructor')).toBe('mine')
  })
})

describe('atomic and serialized writes', () => {
  it('writes to a tmp file and renames it over the target', async () => {
    const store = make()
    await store.set('a', '1')
    const writes = fs.log.filter((l) => l !== `read ${FILE}`)
    expect(writes).toEqual([`write ${FILE}.tmp`, `rename ${FILE}.tmp ${FILE}`])
    expect(fs.files.has(`${FILE}.tmp`)).toBe(false)
  })

  it('never exposes a partially written target: the target is only replaced by rename', async () => {
    const store = make()
    await store.set('a', '1')
    const before = fs.files.get(FILE)
    fs.failWrite = true
    await expect(store.set('a', '2')).rejects.toThrow('disk full')
    expect(fs.files.get(FILE)).toBe(before)
  })

  it('serializes concurrent writes (no overlapping fs writes) and keeps every change', async () => {
    fs.writeDelay = 5
    const store = make()
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.set(`k${i}`, `v${i}`)))
    expect(fs.maxInflight).toBe(1)
    const entries = JSON.parse(fs.files.get(FILE)!).entries
    expect(Object.keys(entries)).toHaveLength(12)
    for (let i = 0; i < 12; i++) expect(await make().get(`k${i}`)).toBe(`v${i}`)
  })

  it('applies interleaved set/delete in call order', async () => {
    fs.writeDelay = 2
    const store = make()
    const ops = [store.set('k', '1'), store.delete('k'), store.set('k', '2'), store.set('j', 'x'), store.delete('j')]
    await Promise.all(ops)
    expect(await make().get('k')).toBe('2')
    expect(await make().get('j')).toBeNull()
  })

  it('a failed write rejects its caller but later queued writes still run', async () => {
    const store = make()
    fs.failWriteTimes = 1
    const results = await Promise.allSettled([store.set('a', '1'), store.set('b', '2')])
    expect(results[0]!.status).toBe('rejected')
    expect(results[1]!.status).toBe('fulfilled')
    expect(await make().get('b')).toBe('2')
  })

  it('a failed write does not change what get() returns', async () => {
    const store = make()
    await store.set('a', 'old')
    fs.failWriteTimes = 1
    await expect(store.set('a', 'new')).rejects.toThrow('disk full')
    expect(await store.get('a')).toBe('old')
    fs.failRename = true
    await expect(store.delete('a')).rejects.toThrow()
    fs.failRename = false
    expect(await store.get('a')).toBe('old')
  })

  it('recovers after a failed rename', async () => {
    const store = make()
    fs.failRename = true
    await expect(store.set('a', '1')).rejects.toThrow('rename failed')
    fs.failRename = false
    await expect(store.set('b', '2')).resolves.toBeUndefined()
    expect(await make().get('b')).toBe('2')
  })

  it('reads see writes queued before them only after they resolve', async () => {
    const store = make()
    const p = store.set('a', '1')
    await p
    expect(await store.get('a')).toBe('1')
  })

  it('does not leak unhandled rejections from the internal queue', async () => {
    const spy = vi.fn()
    process.on('unhandledRejection', spy)
    const store = make()
    fs.failWrite = true
    await expect(store.set('a', '1')).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 10))
    process.off('unhandledRejection', spy)
    expect(spy).not.toHaveBeenCalled()
  })
})
