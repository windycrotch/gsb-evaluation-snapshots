const DB_NAME = "spider-archiver";
const DB_VERSION = 2;
const PAGES_STORE = "pages";
const DEFAULT_MAX_STORAGE_BYTES = 50 * 1024 * 1024; // 50MB

// Mutable so tests (and future settings UI) can lower the cap.
export const storageConfig = {
  maxBytes: DEFAULT_MAX_STORAGE_BYTES,
};

export interface StoredPage {
  batchId: string;
  url: string;
  content: string;
  error?: string;
  status?: number;
  domain: string;
  timestamp: number;
  contentSize: number;
}

export interface BatchInfo {
  id: string;
  createdAt: number;
  pageCount: number;
  totalSize: number;
}

export interface DomainInfo {
  domain: string;
  pageCount: number;
  totalSize: number;
  lastCrawled: number;
}

function createPagesStore(db: IDBDatabase): IDBObjectStore {
  const store = db.createObjectStore(PAGES_STORE, {
    keyPath: ["batchId", "url"],
  });
  store.createIndex("batchId", "batchId", { unique: false });
  store.createIndex("domain", "domain", { unique: false });
  store.createIndex("timestamp", "timestamp", { unique: false });
  return store;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      const oldVersion = event.oldVersion;

      if (oldVersion < 2 && db.objectStoreNames.contains(PAGES_STORE)) {
        // Migrate v1 (keyed by URL only) into a single "legacy" batch so
        // previously archived pages survive the schema change.
        const oldStore = tx!.objectStore(PAGES_STORE);
        const getAllReq = oldStore.getAll();
        getAllReq.onsuccess = () => {
          const legacyPages = getAllReq.result as any[];
          db.deleteObjectStore(PAGES_STORE);
          const store = createPagesStore(db);
          const now = Date.now();
          const batchId = `legacy-${now.toString(36)}`;
          for (const page of legacyPages) {
            if (!page?.url) continue;
            store.put({
              batchId,
              url: page.url,
              content: page.content || "",
              error: page.error,
              status: page.status,
              domain: page.domain || getDomain(page.url),
              timestamp: page.timestamp || now,
              contentSize:
                page.contentSize ?? new Blob([page.content || ""]).size,
            });
          }
        };
      } else if (!db.objectStoreNames.contains(PAGES_STORE)) {
        createPagesStore(db);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getDomain(url: string): string {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
  } catch {
    return url.split("/")[0];
  }
}

function generateBatchId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Within one batch a URL may only appear once; when a crawl reports the same
 * URL multiple times, the last result wins.
 */
export function dedupePagesByUrl<
  T extends { url?: string; content?: string; error?: string; status?: number }
>(pages: T[]): T[] {
  const byUrl = new Map<string, T>();
  for (const page of pages) {
    if (!page?.url) continue;
    byUrl.set(page.url, page);
  }
  return Array.from(byUrl.values());
}

export async function savePages(
  pages: { url: string; content?: string; error?: string; status?: number }[]
): Promise<string> {
  if (!pages?.length) return "";

  const deduped = dedupePagesByUrl(pages);
  const batchId = generateBatchId();
  const now = Date.now();

  const records: StoredPage[] = deduped.map((page) => {
    const content = page.content || "";
    return {
      batchId,
      url: page.url,
      content,
      error: page.error,
      status: page.status,
      domain: getDomain(page.url),
      timestamp: now,
      contentSize: new Blob([content]).size,
    };
  });

  const batchSize = records.reduce((sum, r) => sum + r.contentSize, 0);

  // A batch that cannot fit even into an empty archive is rejected outright,
  // before anything is evicted, so existing batches are never lost for nothing.
  if (batchSize > storageConfig.maxBytes) {
    throw new Error(
      `This crawl batch is ${formatBytes(batchSize)}, which exceeds the ` +
        `${formatBytes(storageConfig.maxBytes)} archive limit on its own. ` +
        `Nothing was saved and all existing batches were left untouched. ` +
        `Try crawling fewer pages.`
    );
  }

  await evictBatchesIfNeeded(batchSize);

  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAGES_STORE, "readwrite");
    const store = tx.objectStore(PAGES_STORE);

    for (const record of records) {
      store.put(record);
    }

    tx.oncomplete = () => {
      db.close();
      resolve(batchId);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getBatches(): Promise<BatchInfo[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAGES_STORE, "readonly");
    const request = tx.objectStore(PAGES_STORE).getAll();

    request.onsuccess = () => {
      db.close();
      const pages = request.result as StoredPage[];
      const batchMap = new Map<string, BatchInfo>();

      for (const page of pages) {
        const info = batchMap.get(page.batchId) || {
          id: page.batchId,
          createdAt: page.timestamp,
          pageCount: 0,
          totalSize: 0,
        };
        info.pageCount++;
        info.totalSize += page.contentSize;
        info.createdAt = Math.min(info.createdAt, page.timestamp);
        batchMap.set(page.batchId, info);
      }

      resolve(
        Array.from(batchMap.values()).sort(
          (a, b) => b.createdAt - a.createdAt
        )
      );
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export async function getPagesByBatch(
  batchId: string
): Promise<StoredPage[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAGES_STORE, "readonly");
    const index = tx.objectStore(PAGES_STORE).index("batchId");
    const request = index.getAll(batchId);

    request.onsuccess = () => {
      db.close();
      resolve(request.result);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export async function deleteBatch(batchId: string): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAGES_STORE, "readwrite");
    const store = tx.objectStore(PAGES_STORE);
    const index = store.index("batchId");
    const request = index.openCursor(batchId);

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getPagesByDomain(domain: string): Promise<StoredPage[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAGES_STORE, "readonly");
    const index = tx.objectStore(PAGES_STORE).index("domain");
    const request = index.getAll(domain);

    request.onsuccess = () => {
      db.close();
      resolve(request.result);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export async function searchPages(query: string): Promise<StoredPage[]> {
  const db = await openDB();
  const lowerQuery = query.toLowerCase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAGES_STORE, "readonly");
    const request = tx.objectStore(PAGES_STORE).getAll();

    request.onsuccess = () => {
      db.close();
      resolve(
        (request.result as StoredPage[]).filter((page) =>
          page.url.toLowerCase().includes(lowerQuery)
        )
      );
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export async function getSavedDomains(): Promise<DomainInfo[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAGES_STORE, "readonly");
    const request = tx.objectStore(PAGES_STORE).getAll();

    request.onsuccess = () => {
      db.close();
      const pages = request.result as StoredPage[];
      const domainMap = new Map<string, DomainInfo>();

      for (const page of pages) {
        const info = domainMap.get(page.domain) || {
          domain: page.domain,
          pageCount: 0,
          totalSize: 0,
          lastCrawled: 0,
        };
        info.pageCount++;
        info.totalSize += page.contentSize;
        info.lastCrawled = Math.max(info.lastCrawled, page.timestamp);
        domainMap.set(page.domain, info);
      }

      resolve(
        Array.from(domainMap.values()).sort(
          (a, b) => b.lastCrawled - a.lastCrawled
        )
      );
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export async function clearAll(): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAGES_STORE, "readwrite");
    tx.objectStore(PAGES_STORE).clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * Evicts whole batches, oldest first, until the incoming batch fits within
 * the storage cap. Callers must guarantee the incoming batch alone does not
 * exceed the cap (savePages rejects that case before calling this).
 */
async function evictBatchesIfNeeded(incomingSize: number): Promise<void> {
  const batches = await getBatches();
  const currentSize = batches.reduce((sum, b) => sum + b.totalSize, 0);
  const limit = storageConfig.maxBytes;

  if (currentSize + incomingSize <= limit) return;

  const needed = currentSize + incomingSize - limit;
  const oldestFirst = [...batches].sort((a, b) => a.createdAt - b.createdAt);

  let freed = 0;
  for (const batch of oldestFirst) {
    if (freed >= needed) break;
    await deleteBatch(batch.id);
    freed += batch.totalSize;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
