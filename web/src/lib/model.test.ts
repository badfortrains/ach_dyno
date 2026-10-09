import { describe, expect, it } from 'vitest';
import {
  Recorder,
  MAX_SAMPLES,
  CELL_DISTANCE_IN,
  footForce,
  validGeometry,
  calibrationCellMass,
  deviceAddress,
  parseMessage,
  toCloud,
  fromCloud,
  validateRun,
  runCsv,
  type DeviceSample,
} from './model';
const sample = (
  seq = 1,
  ms = 100,
  forceN: number | null = 0,
  bootId = 123,
): DeviceSample => ({ type: 'sample', seq, ms, forceN, bootId, raw: 12000 });
function recorder(first = sample()) {
  return new Recorder(
    first,
    'left',
    'seated_plantarflexion',
    'device',
    'alice',
    'test-run',
  );
}
function completed() {
  const r = recorder();
  r.add(sample());
  r.add(sample(2, 150, 100));
  r.add(sample(3, 200, 50));
  return r.finish('Stopped by user');
}
describe('sample protocol and device address', () => {
  it('accepts uncalibrated samples without inventing a force', () =>
    expect(parseMessage(JSON.stringify(sample(1, 100, null)))).toEqual(
      sample(1, 100, null),
    ));
  it('rejects malformed and incompatible messages', () => {
    for (const value of [
      'null',
      '[]',
      '{',
      '{}',
      JSON.stringify({ ...sample(), ms: -1 }),
      JSON.stringify({ ...sample(), forceN: '10' }),
    ])
      expect(parseMessage(value)).toBeNull();
  });
  it('supports mDNS and private IPv4 fallbacks', () => {
    expect(deviceAddress('calf-dyno.local').ws).toBe(
      'ws://calf-dyno.local:81/',
    );
    expect(deviceAddress('192.168.1.42:81').status).toBe(
      'http://192.168.1.42/status',
    );
    expect(deviceAddress('ws://172.20.0.4:81/').ws).toBe('ws://172.20.0.4:81/');
  });
  it('rejects public hosts, credentials, paths, and invalid IPv4', () => {
    for (const value of [
      'example.com',
      '8.8.8.8',
      'ws://user:pass@calf-dyno.local',
      'calf-dyno.local/x',
      '192.168.1.256',
      'wss://calf-dyno.local',
      'calf-dyno.local?x=y',
    ])
      expect(() => deviceAddress(value)).toThrow();
  });
});
describe('raw run recording', () => {
  it('preserves signed raw forces and computes elapsed time, peak, and observed sample rate', () => {
    const r = recorder();
    r.add(sample(1, 100, -2));
    r.add(sample(2, 150, 100));
    r.add(sample(3, 200, 20));
    const run = r.finish('Stopped');
    expect(run.samples).toEqual([
      [0, -2],
      [50, 100],
      [100, 20],
    ]);
    expect(run.durationMs).toBe(100);
    expect(run.peakForceN).toBe(100);
    expect(run.sampleRateHz).toBe(20);
    expect(validateRun(run)).toBe(true);
  });
  it('supports millis and sequence rollover', () => {
    const first = sample(0xffffffff, 0xfffffff0, 1),
      r = recorder(first);
    expect(r.add(first)).toBeNull();
    expect(r.add(sample(0, 34, 2))).toBeNull();
    expect(r.finish('Stopped').samples).toEqual([
      [0, 1],
      [50, 2],
    ]);
  });
  it('stops on a missing sample without adding a fabricated value', () => {
    const r = recorder();
    r.add(sample());
    expect(r.add(sample(3, 200, 5))).toBe('Sample stream interrupted');
    expect(r.finish('Interrupted').samples).toHaveLength(1);
  });
  it('stops on reboot, invalid force and timestamp reset', () => {
    const r = recorder();
    r.add(sample());
    expect(r.add(sample(2, 150, 2, 456))).toBe('Device restarted');
    expect(r.add(sample(2, 150, null))).toBe('Invalid or uncalibrated sample');
    expect(r.add(sample(2, 100, 2))).toBe('Device timestamp changed');
  });
  it('caps raw samples below Firestore document limits', () => {
    const r = recorder();
    for (let i = 0; i < MAX_SAMPLES; i++) r.add(sample(i + 1, 100 + i * 50, 1));
    expect(r.add(sample(MAX_SAMPLES + 1, 300100, 1))).toBe(
      'Recording limit reached',
    );
    const run = r.finish('Limit');
    expect(run.samples).toHaveLength(MAX_SAMPLES);
    expect(
      new TextEncoder().encode(JSON.stringify(toCloud(run))).length,
    ).toBeLessThan(500_000);
  });
});
describe('persistence and export', () => {
  it('round trips cloud maps without leaking local metadata or nesting arrays', () => {
    const run = completed(),
      cloud = toCloud(run);
    expect(cloud.samples[1]).toEqual({ t: 50, f: 100 });
    expect(cloud).not.toHaveProperty('ownerUid');
    expect(cloud).not.toHaveProperty('state');
    expect(cloud).not.toHaveProperty('id');
    expect(fromCloud(run.id, cloud).samples).toEqual(run.samples);
  });
  it('rejects corrupt historical samples and wrong metrics', () => {
    const run = completed();
    expect(
      validateRun({
        ...run,
        samples: [
          [10, 1],
          [0, 2],
        ],
      }),
    ).toBe(false);
    expect(validateRun({ ...run, peakForceN: 500 })).toBe(false);
    expect(() =>
      fromCloud(run.id, { ...toCloud(run), samples: [{ t: -1, f: 2 }] }),
    ).toThrow();
  });
  it('exports all samples with quoted labels and neutralizes spreadsheet formulas', () => {
    const run = completed();
    run.exercise = '=1+1,"hello"';
    const csv = runCsv(run);
    expect(csv.split('\r\n')).toHaveLength(5);
    expect(csv).toContain('"\'=1+1,""hello"""');
    expect(csv).toContain(',50,100\r\n');
  });
});
describe('pedal lever correction', () => {
  const geometry = { cellDistanceIn: CELL_DISTANCE_IN, footDistanceIn: 6.625 };
  it('balances moments, preserving the sign of the cell force', () => {
    expect(footForce(100, geometry)).toBe(200);
    expect(footForce(-2, geometry)).toBe(-4);
    expect(footForce(100, { ...geometry, footDistanceIn: 13.25 })).toBe(100);
    for (const distance of [0, -1, 14, NaN, Infinity])
      expect(validGeometry({ ...geometry, footDistanceIn: distance })).toBe(
        false,
      );
  });
  it('converts a pedal calibration mass to the equivalent cell mass', () => {
    expect(calibrationCellMass(5, 6.625)).toBe(2.5);
    expect(calibrationCellMass(5, 13.25)).toBe(5);
    for (const distance of [0, -1, 14, NaN])
      expect(() => calibrationCellMass(5, distance)).toThrow();
  });
  it('freezes geometry per run and preserves it through cloud and CSV', () => {
    const input = { ...geometry };
    const r = new Recorder(
      sample(),
      'left',
      'seated_plantarflexion',
      'device',
      null,
      'lever-run',
      input,
    );
    input.footDistanceIn = 13.25;
    r.add(sample(1, 100, -2));
    r.add(sample(2, 150, 100));
    const run = r.finish('Stopped');
    expect(run.samples).toEqual([
      [0, -4],
      [50, 200],
    ]);
    expect(run.peakForceN).toBe(200);
    expect(run.geometry).toEqual(geometry);
    const cloud = toCloud(run);
    expect(cloud.schemaVersion).toBe(2);
    expect(fromCloud(run.id, cloud).geometry).toEqual(geometry);
    expect(runCsv(run)).toContain('"foot",13.25,6.625,50,200');
    expect(() =>
      fromCloud(run.id, {
        ...cloud,
        geometry: { ...geometry, footDistanceIn: 0 },
      }),
    ).toThrow();
    expect(() => fromCloud(run.id, { ...cloud, schemaVersion: 1 })).toThrow();
    expect(
      fromCloud(completed().id, toCloud(completed())).geometry,
    ).toBeUndefined();
  });
});
