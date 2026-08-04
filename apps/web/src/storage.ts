export type SavedHost = {
  id: string;
  name: string;
  loginName?: string;
  endpoint: string;
  transport: "direct" | "relay";
  directEndpoint?: string;
  relayEndpoint?: string;
  routeId?: string;
  nodeId: string;
  userId: string;
  hostPublicKey: string;
  hostFingerprint: string;
  deviceId: string;
  deviceName: string;
  devicePublicKey: string;
  deviceSecretKey: string;
};

const DATABASE = "codex-everywhere";
const STORE = "hosts";

export async function listHosts(): Promise<SavedHost[]> {
  const database = await openDatabase();
  try {
    return await request(
      database.transaction(STORE).objectStore(STORE).getAll(),
    );
  } finally {
    database.close();
  }
}

export async function saveHost(host: SavedHost): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(host);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function deleteHost(id: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(id);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) {
        open.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
