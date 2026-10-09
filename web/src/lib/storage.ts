import type { LocalRun } from './model';
import { validateRun } from './model';
let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  if (!database)
    database = new Promise((resolve, reject) => {
      const open = indexedDB.open('calf-dyno', 1);
      open.onupgradeneeded = () =>
        open.result.createObjectStore('runs', { keyPath: 'id' });
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => {
        database = undefined;
        reject(open.error);
      };
      open.onblocked = () => {
        database = undefined;
        reject(
          new Error('Close other dashboard tabs to enable local backups.'),
        );
      };
    });
  return database;
}
async function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('runs', mode),
      request = action(tx.objectStore('runs'));
    // Wait for COMMIT, not just the request's success event.
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error || request.error);
    tx.onabort = () =>
      reject(tx.error || new Error('Local backup was interrupted.'));
  });
}
export async function saveLocal(run: LocalRun): Promise<void> {
  await transaction('readwrite', (store) => store.put(structuredClone(run)));
}
export async function loadLocal(): Promise<LocalRun[]> {
  const values = await transaction('readonly', (store) => store.getAll());
  return values.filter((value): value is LocalRun => {
    if (!validateRun(value)) return false;
    const r = value as LocalRun;
    return (
      ['recording', 'pending', 'saved'].includes(r.state) &&
      (r.ownerUid === null || typeof r.ownerUid === 'string')
    );
  });
}
export async function deleteLocal(id: string): Promise<void> {
  await transaction('readwrite', (store) => store.delete(id));
}
