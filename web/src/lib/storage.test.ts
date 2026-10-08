import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { Recorder } from './model';
import { deleteLocal, loadLocal, saveLocal } from './storage';
it('commits raw samples and account ownership and survives rereading the journal', async () => {
  const sample = { type: 'sample' as const, bootId: 1, seq: 1, ms: 100, raw: 5, forceN: 15 };
  const recorder = new Recorder(sample, 'right', 'standing_plantarflexion', 'device', 'alice', 'journal-test');
  recorder.add(sample); const run = recorder.finish('Connection lost');
  await saveLocal(run); run.samples[0][1] = 999;
  const loaded = (await loadLocal()).find(r => r.id === 'journal-test')!;
  expect(loaded.samples).toEqual([[0, 15]]); expect(loaded.ownerUid).toBe('alice'); expect(loaded.state).toBe('pending');
  await deleteLocal(loaded.id); expect((await loadLocal()).some(r => r.id === loaded.id)).toBe(false);
});
