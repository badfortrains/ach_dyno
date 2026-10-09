import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  setDoc,
  getDoc,
  getDocs,
  doc,
  collection,
  deleteDoc,
} from 'firebase/firestore';
import { beforeAll, beforeEach, afterAll, describe, it } from 'vitest';
let env: RulesTestEnvironment;
const valid = () => ({
  timestamp: '2026-10-08T15:30:00.000Z',
  leg: 'left',
  exercise: 'seated_plantarflexion',
  durationMs: 50,
  sampleRateHz: 20,
  peakForceN: 15,
  samples: [
    { t: 0, f: 0 },
    { t: 50, f: 15 },
  ],
  source: 'device',
  stopReason: 'Stopped by user',
  schemaVersion: 1,
});
beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST)
    throw new Error(
      'Run with firebase emulators:exec; never run rules tests against production.',
    );
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  env = await initializeTestEnvironment({
    projectId: 'demo-calf-dyno',
    firestore: {
      host,
      port: Number(port),
      rules: readFileSync('../firestore.rules', 'utf8'),
    },
  });
});
beforeEach(() => env.clearFirestore());
afterAll(() => env?.cleanup());
describe('personal measurement rules', () => {
  it('allows optional body weight and rejects invalid weights', async () => {
    const ref = doc(
      env.authenticatedContext('alice').firestore(),
      'users/alice/runs/weight',
    );
    for (const run of [
      valid(),
      {
        ...valid(),
        schemaVersion: 2,
        geometry: { cellDistanceIn: 13.25, footDistanceIn: 6.625 },
      },
    ]) {
      await assertSucceeds(setDoc(ref, { ...run, bodyMassKg: 70 }));
      await assertSucceeds(getDoc(ref));
      await assertSucceeds(setDoc(ref, { ...run, bodyMassKg: 70 }));
      await assertFails(setDoc(ref, { ...run, bodyMassKg: 80 }));
      await assertSucceeds(deleteDoc(ref));
      for (const weight of [0, -1, 1001, '70', null])
        await assertFails(setDoc(ref, { ...run, bodyMassKg: weight }));
    }
  });
  it('accepts lever runs and rejects invalid or unversioned geometry', async () => {
    const ref = doc(
      env.authenticatedContext('alice').firestore(),
      'users/alice/runs/lever',
    );
    const geometry = { cellDistanceIn: 13.25, footDistanceIn: 6.625 };
    const run = { ...valid(), schemaVersion: 2, geometry };
    await assertSucceeds(setDoc(ref, run));
    await assertSucceeds(setDoc(ref, run));
    await assertSucceeds(deleteDoc(ref));
    for (const patch of [
      { schemaVersion: 1 },
      { geometry: { ...geometry, footDistanceIn: 0 } },
      { geometry: { ...geometry, footDistanceIn: 14 } },
      { geometry: { ...geometry, cellDistanceIn: 10 } },
      { geometry: { ...geometry, extra: 1 } },
      { geometry: null },
    ]) {
      await assertFails(setDoc(ref, { ...run, ...patch }));
    }
    await assertFails(setDoc(ref, { ...valid(), schemaVersion: 2 }));
  });
  it('allows an owner to save, read, list, retry, and delete their run', async () => {
    const db = env.authenticatedContext('alice').firestore(),
      ref = doc(db, 'users/alice/runs/test');
    await assertSucceeds(setDoc(ref, valid()));
    await assertSucceeds(getDoc(ref));
    await assertSucceeds(getDocs(collection(db, 'users/alice/runs')));
    await assertSucceeds(setDoc(ref, valid()));
    await assertSucceeds(deleteDoc(ref));
  });
  it('denies all unauthenticated access', async () => {
    const db = env.unauthenticatedContext().firestore(),
      ref = doc(db, 'users/alice/runs/test');
    await assertFails(setDoc(ref, valid()));
    await assertFails(getDoc(ref));
    await assertFails(getDocs(collection(db, 'users/alice/runs')));
  });
  it('denies cross-account writes, reads, lists, and deletes', async () => {
    await assertSucceeds(
      setDoc(
        doc(
          env.authenticatedContext('alice').firestore(),
          'users/alice/runs/test',
        ),
        valid(),
      ),
    );
    const db = env.authenticatedContext('bob').firestore(),
      ref = doc(db, 'users/alice/runs/test');
    await assertFails(setDoc(ref, valid()));
    await assertFails(getDoc(ref));
    await assertFails(getDocs(collection(db, 'users/alice/runs')));
    await assertFails(deleteDoc(ref));
  });
  it('keeps completed runs immutable', async () => {
    const ref = doc(
      env.authenticatedContext('alice').firestore(),
      'users/alice/runs/test',
    );
    await assertSucceeds(setDoc(ref, valid()));
    await assertFails(setDoc(ref, { ...valid(), peakForceN: 20 }));
  });
  it('rejects missing fields, extra fields, demo data, and oversized runs', async () => {
    const ref = doc(
      env.authenticatedContext('alice').firestore(),
      'users/alice/runs/test',
    );
    await assertFails(setDoc(ref, { leg: 'left' }));
    await assertFails(setDoc(ref, { ...valid(), extra: 'bad' }));
    await assertFails(setDoc(ref, { ...valid(), source: 'demo' }));
    await assertFails(
      setDoc(ref, {
        ...valid(),
        samples: Array.from({ length: 6001 }, () => ({ t: 0, f: 0 })),
      }),
    );
  });
  it('rejects invalid legs, timing, forces, and sample maps', async () => {
    const ref = doc(
      env.authenticatedContext('alice').firestore(),
      'users/alice/runs/test',
    );
    for (const patch of [
      { leg: 'both' },
      { durationMs: -1 },
      { durationMs: 300001 },
      { peakForceN: -1 },
      { sampleRateHz: '20' },
      { samples: [] },
      { samples: [{ t: 100, f: 1 }] },
      { samples: [{ t: 0, f: 'bad' }] },
      { timestamp: 'today' },
    ]) {
      await assertFails(setDoc(ref, { ...valid(), ...patch }));
    }
  });
});
