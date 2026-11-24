// IndexedDB 离线持久化封装：全部血缘台账在浏览器本地落库，断网可用。
const DB_NAME = 'pipeline-lineage-workbench';
const DB_VERSION = 2;

export const STORES = {
  packages: 'packages', // 导入账（含原始包文本）
  results: 'results', // 各包流水线结果
  snapshots: 'snapshots', // 发布快照
  drafts: 'drafts', // 审阅草案
  driftReports: 'driftReports', // 漂移验证报告
  kv: 'kv', // 同步状态、规则指纹等杂项
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, name === 'kv' ? { keyPath: 'key' } : { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function idbPut<T extends object>(store: string, value: T): Promise<void> {
  await tx(store, 'readwrite', (s) => s.put(value) as IDBRequest<IDBValidKey>);
}

/** 写入以自定义 keyPath（kv 存储使用 'key'）为主键的记录 */
export async function idbPutKey<T>(store: string, value: T): Promise<void> {
  await tx(store, 'readwrite', (s) => s.put(value) as IDBRequest<IDBValidKey>);
}

export async function idbGet<T>(store: string, id: string): Promise<T | undefined> {
  return tx(store, 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>);
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  return tx(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export async function idbDelete(store: string, id: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
}

export async function idbClear(store: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.clear() as IDBRequest<undefined>);
}

export interface KvEntry<T> {
  key: string;
  value: T;
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  await idbPutKey<KvEntry<T>>(STORES.kv, { key, value });
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const entry = await idbGet<KvEntry<T>>(STORES.kv, key);
  return entry?.value;
}
