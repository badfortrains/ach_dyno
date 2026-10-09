import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDocs,
  query,
  orderBy,
  limit,
  startAfter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { firebaseConfig } from '../../config';
import { fromCloud, toCloud, type Run } from './model';
// Imported only in onMount: authentication and browser storage never run during SSR.
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
const firestore = getFirestore(app);
export { onAuthStateChanged };
export const login = () => signInWithPopup(auth, new GoogleAuthProvider());
export const logout = () => signOut(auth);
async function networkDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Cloud request timed out. Check your internet connection and retry.',
              ),
            ),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function saveRun(uid: string, run: Run): Promise<void> {
  if (auth.currentUser?.uid !== uid)
    throw new Error('Sign in to the account that recorded this run.');
  if (run.source === 'demo') throw new Error('Demo measurements remain local.');
  // A stable local UUID makes manual retries idempotent, including after an ambiguous network failure.
  await networkDeadline(
    setDoc(doc(firestore, 'users', uid, 'runs', run.id), toCloud(run)),
  );
}
export async function history(uid: string, cursor?: QueryDocumentSnapshot) {
  const runs = collection(firestore, 'users', uid, 'runs');
  const snapshot = await networkDeadline(
    getDocs(
      cursor
        ? query(
            runs,
            orderBy('timestamp', 'desc'),
            startAfter(cursor),
            limit(50),
          )
        : query(runs, orderBy('timestamp', 'desc'), limit(50)),
    ),
  );
  return {
    runs: snapshot.docs.map((d) => fromCloud(d.id, d.data())),
    cursor: snapshot.docs.at(-1),
    hasMore: snapshot.size === 50,
  };
}
