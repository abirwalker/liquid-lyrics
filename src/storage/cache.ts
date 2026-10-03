import type { LyricsQuery, LyricsResult } from '../types/types';
import { isValidResult } from '../types/types';

export const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const NEGATIVE_TTL_MS = 60 * 60 * 1000;           // 1 hour
export const STATIC_TTL_MS = 24 * 60 * 60 * 1000;
export const MEMORY_CAPACITY = 100;
const BINI_MATCH_POLICY = 1;
const CACHE_KEY_VERSION = 'v4';

export interface CacheEntry {
  key: string;
  result: LyricsResult | null;
  cachedAt: number;
  expiresAt: number;
  biniMatchPolicy?: number;
}

export function normalizeString(str: string | undefined): string {
  return (str ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export function getCacheKeys(query: LyricsQuery): string[] {
  const keys: string[] = [];
  if (query.spotifyId?.trim()) {
    keys.push(`${CACHE_KEY_VERSION}:id:${query.spotifyId.trim()}`);
  }
  const artist = normalizeString(query.artist);
  const song = normalizeString(query.song);
  if (artist && song) {
    keys.push(`${CACHE_KEY_VERSION}:meta:${artist}:${song}`);
  }
  return keys;
}

export class MemoryCache {
  private capacity: number;
  private store = new Map<string, CacheEntry>();

  constructor(capacity = MEMORY_CAPACITY) {
    this.capacity = capacity;
  }

  get(key: string): CacheEntry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.capacity) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }
    this.store.set(key, entry);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

const DB_NAME = 'liquid-lyrics-cache';
const DB_VERSION = 1;
const STORE_NAME = 'lyrics';

export class IndexedDbStorage {
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  private async getDb(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return null;
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve) => {
      try {
        const timer = setTimeout(() => resolve(null), 500);
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            store.createIndex('cachedAt', 'cachedAt', { unique: false });
          }
        };
        req.onsuccess = () => {
          clearTimeout(timer);
          resolve(req.result);
        };
        req.onerror = () => {
          clearTimeout(timer);
          resolve(null);
        };
      } catch {
        resolve(null);
      }
    });

    return this.dbPromise;
  }

  async get(key: string): Promise<CacheEntry | null> {
    const db = await this.getDb();
    if (!db) return null;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => {
          const entry = req.result as CacheEntry | undefined;
          if (!entry) return resolve(null);
          if (Date.now() > entry.expiresAt) {
            void this.delete(key);
            return resolve(null);
          }
          resolve(entry);
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async set(entry: CacheEntry): Promise<void> {
    const db = await this.getDb();
    if (!db) return;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async delete(key: string): Promise<void> {
    const db = await this.getDb();
    if (!db) return;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async clear(): Promise<void> {
    const db = await this.getDb();
    if (!db) return;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

}

function isCurrentEntry(entry: CacheEntry): boolean {
  return entry.result === null || (isValidResult(entry.result) &&
    (entry.result.source !== 'binilyrics' || entry.biniMatchPolicy === BINI_MATCH_POLICY));
}

export class LyricsCache {
  private memory: MemoryCache;
  private db: IndexedDbStorage;

  constructor(memoryCapacity = MEMORY_CAPACITY) {
    this.memory = new MemoryCache(memoryCapacity);
    this.db = new IndexedDbStorage();
  }

  async get(query: LyricsQuery): Promise<{ hit: boolean; result: LyricsResult | null }> {
    const keys = getCacheKeys(query);
    if (!keys.length) return { hit: false, result: null };

    // 1. Tier 1: In-Memory LRU (0ms)
    for (const key of keys) {
      const entry = this.memory.get(key);
      if (entry) {
        if (!isCurrentEntry(entry)) {
          this.memory.delete(key);
          continue;
        }
        return { hit: true, result: entry.result };
      }
    }

    // 2. Tier 2: Persistent IndexedDB
    for (const key of keys) {
      const entry = await this.db.get(key);
      if (entry) {
        if (!isCurrentEntry(entry)) {
          await this.db.delete(key);
          continue;
        }
        for (const k of keys) {
          this.memory.set(k, entry);
        }
        return { hit: true, result: entry.result };
      }
    }

    return { hit: false, result: null };
  }

  async set(query: LyricsQuery, result: LyricsResult | null): Promise<void> {
    const keys = getCacheKeys(query);
    if (!keys.length) return;

    if (result !== null && !isValidResult(result)) {
      return;
    }

    const now = Date.now();
    let ttl = POSITIVE_TTL_MS;
    if (result === null) ttl = NEGATIVE_TTL_MS;
    else if (!result.instrumental && !result.lines.some(line => line.timing === 'word')) ttl = STATIC_TTL_MS;
    const expiresAt = now + ttl;

    for (const key of keys) {
      const entry: CacheEntry = {
        key,
        result,
        cachedAt: now,
        expiresAt,
        ...(result?.source === 'binilyrics' ? { biniMatchPolicy: BINI_MATCH_POLICY } : {}),
      };
      this.memory.set(key, entry);
      void this.db.set(entry);
    }
  }

  async delete(query: LyricsQuery): Promise<void> {
    const keys = getCacheKeys(query);
    for (const key of keys) {
      this.memory.delete(key);
      void this.db.delete(key);
    }
  }

  async clear(): Promise<void> {
    this.memory.clear();
    await this.db.clear();
  }
}

export const defaultCache = new LyricsCache();
