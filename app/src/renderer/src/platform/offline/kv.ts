/** A tiny async key/value table: IndexedDB in the app, a Map in tests. */
export interface Kv<T> {
  get(key: string): Promise<T | undefined>
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  all(): Promise<T[]>
  clear(): Promise<void>
}

export function memoryKv<T>(): Kv<T> {
  const m = new Map<string, T>()
  return {
    get: async (k) => m.get(k),
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
    all: async () => [...m.values()],
    clear: async () => m.clear()
  }
}

export const OFFLINE_DB = 'nocturne-offline'
export const OFFLINE_STORES = ['audio', 'tracks', 'lyrics', 'art'] as const
export type OfflineStoreName = (typeof OFFLINE_STORES)[number]

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  const p: Promise<IDBDatabase> = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB, 1)
    req.onupgradeneeded = () => {
      for (const s of OFFLINE_STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
    req.onblocked = () => reject(new Error('indexedDB blocked'))
  })
  dbPromise ??= p.catch((e: unknown) => {
    dbPromise = null
    throw e
  })
  return dbPromise
}

function wrap<R>(req: IDBRequest<R>): Promise<R> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'))
  })
}

export function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

export function idbKv<T>(store: OfflineStoreName): Kv<T> {
  const tx = async (mode: IDBTransactionMode): Promise<IDBObjectStore> => (await openDb()).transaction(store, mode).objectStore(store)
  return {
    get: async (k) => (await wrap((await tx('readonly')).get(k))) as T | undefined,
    put: async (k, v) => void (await wrap((await tx('readwrite')).put(v, k))),
    delete: async (k) => void (await wrap((await tx('readwrite')).delete(k))),
    all: async () => (await wrap((await tx('readonly')).getAll())) as T[],
    clear: async () => void (await wrap((await tx('readwrite')).clear()))
  }
}
