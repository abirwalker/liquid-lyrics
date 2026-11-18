import { compareVersions } from '../utils/instance';
import { logger } from '../utils/logger';

// Marketplace keys each install by the manifest's file path, and every release has its own path,
// so installing an update keeps the older install loading at every start, with no Remove button.
const INSTALL_PREFIX = 'marketplace:installed:abirwalker/liquid-lyrics/';
const INSTALLED_LIST = 'marketplace:installed-extensions';
const DATABASE = 'spicetify-marketplace';
const STORE = 'settings';

// Only a versioned release path says which build an install loads. The version Marketplace stored is
// from install time, so an install on a fixed path would look old while loading the newest build.
const installedVersion = (key: string) => key.match(/\/v(\d+\.\d+\.\d+)\//)?.[1] ?? null;

function findOlderInstalls(read: (key: string) => string | undefined, version: string) {
  let list: unknown;
  try {
    list = JSON.parse(read(INSTALLED_LIST) ?? '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const older = list.filter((key): key is string => typeof key === 'string' && key.startsWith(INSTALL_PREFIX) &&
    compareVersions(installedVersion(key) ?? version, version) < 0);
  return older.length ? { remaining: list.filter(key => !older.includes(key)), older } : null;
}

function pruneLocalStorage(version: string) {
  const found = findOlderInstalls(key => localStorage.getItem(key) ?? undefined, version);
  if (!found) return 0;
  localStorage.setItem(INSTALLED_LIST, JSON.stringify(found.remaining));
  for (const key of found.older) localStorage.removeItem(key);
  return found.older.length;
}

const settle = (request: IDBRequest | IDBTransaction) => new Promise<void>((resolve, reject) => {
  if (request instanceof IDBTransaction) {
    request.oncomplete = () => resolve();
    request.onabort = request.onerror = () => reject(request.error);
  } else {
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }
});

// Newer Marketplace versions moved their settings from localStorage into IndexedDB.
async function pruneIndexedDB(version: string) {
  // Opening a database that does not exist would create an empty one under Marketplace's name.
  if (!(await indexedDB.databases()).some(database => database.name === DATABASE)) return 0;
  const opening = indexedDB.open(DATABASE);
  await settle(opening);
  const db = opening.result;
  try {
    if (!db.objectStoreNames.contains(STORE)) return 0;
    const reading = db.transaction(STORE).objectStore(STORE).getAll();
    await settle(reading);
    const records = new Map<string, string>();
    for (const record of reading.result as Array<{ key: string; value: string }>) records.set(record.key, record.value);
    const found = findOlderInstalls(key => records.get(key), version);
    if (!found) return 0;
    const writing = db.transaction(STORE, 'readwrite');
    const store = writing.objectStore(STORE);
    store.put({ key: INSTALLED_LIST, value: JSON.stringify(found.remaining) });
    for (const key of found.older) store.delete(key);
    await settle(writing);
    return found.older.length;
  } finally {
    db.close();
  }
}

// Takes effect from the next start: Marketplace has already loaded this session's scripts.
export async function removeOlderInstalls(version: string): Promise<number> {
  let removed = 0;
  try {
    removed += pruneLocalStorage(version);
  } catch (error) {
    logger.warn('[Liquid Lyrics] Could not clean older installs from localStorage:', error);
  }
  try {
    removed += await pruneIndexedDB(version);
  } catch (error) {
    logger.warn('[Liquid Lyrics] Could not clean older installs from Marketplace storage:', error);
  }
  return removed;
}
