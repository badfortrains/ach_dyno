export type Sample = [elapsedTimeMs: number, forceN: number];
export type Leg = 'left' | 'right';
export type Source = 'device' | 'demo';
export const MAX_SAMPLES = 6000;
export const MAX_DURATION_MS = 300_000;
export const CELL_DISTANCE_IN = 13.25;
export const INCHES_TO_METERS = 0.0254;
export const MAX_BODY_MASS_KG = 1000;
export function validBodyMass(value: unknown): value is number {
  return finite(value) && value > 0 && value <= MAX_BODY_MASS_KG;
}
export interface LeverGeometry {
  cellDistanceIn: number;
  footDistanceIn: number;
}
export function validGeometry(value: unknown): value is LeverGeometry {
  if (!value || typeof value !== 'object') return false;
  const g = value as LeverGeometry;
  return (
    Object.keys(g).length === 2 &&
    finite(g.cellDistanceIn) &&
    g.cellDistanceIn === CELL_DISTANCE_IN &&
    finite(g.footDistanceIn) &&
    g.footDistanceIn > 0 &&
    g.footDistanceIn <= CELL_DISTANCE_IN
  );
}
export function footForce(cellForceN: number, geometry: LeverGeometry): number {
  if (!validGeometry(geometry))
    throw new Error(
      'Enter a pivot-to-dowel distance greater than 0 and no more than 13.25 inches.',
    );
  return (cellForceN * geometry.cellDistanceIn) / geometry.footDistanceIn;
}
export function ankleTorque(
  forceN: number,
  geometry?: LeverGeometry,
): number | null {
  return geometry && validGeometry(geometry) && finite(forceN)
    ? forceN * geometry.footDistanceIn * INCHES_TO_METERS
    : null;
}
export function torquePerKg(
  torqueNm: number | null,
  bodyMassKg?: number,
): number | null {
  return torqueNm !== null && finite(torqueNm) && validBodyMass(bodyMassKg)
    ? torqueNm / bodyMassKg
    : null;
}
export function calibrationCellMass(
  massKg: number,
  loadDistanceIn: number,
): number {
  if (
    !finite(massKg) ||
    massKg <= 0 ||
    massKg > 10000 ||
    !finite(loadDistanceIn) ||
    loadDistanceIn <= 0 ||
    loadDistanceIn > CELL_DISTANCE_IN
  ) {
    throw new Error('Enter a valid known mass and calibration load distance.');
  }
  const equivalent = (massKg * loadDistanceIn) / CELL_DISTANCE_IN;
  if (!finite(equivalent) || equivalent <= 0)
    throw new Error('Calibration load is too small at the cell.');
  return equivalent;
}
export interface Run {
  id: string;
  timestamp: string;
  leg: Leg;
  exercise: string;
  durationMs: number;
  sampleRateHz: number;
  peakForceN: number;
  samples: Sample[];
  source: Source;
  stopReason: string;
  geometry?: LeverGeometry;
  bodyMassKg?: number;
}
export interface LocalRun extends Run {
  state: 'recording' | 'pending' | 'saved';
  ownerUid: string | null;
}
export interface DeviceStatus {
  type: 'status';
  protocol: 1;
  bootId: number;
  hostname: string;
  ip: string;
  uptimeMs: number;
  adcReady: boolean;
  calibrated: boolean;
  hasTare: boolean;
  busy: boolean;
  otaActive: boolean;
  otaEnabled: boolean;
  sampleRateHz: number;
}
export interface DeviceSample {
  type: 'sample';
  bootId: number;
  seq: number;
  ms: number;
  raw: number;
  forceN: number | null;
}
export type DeviceMessage =
  | DeviceStatus
  | DeviceSample
  | { type: 'ack'; id: string; ok: boolean; message: string }
  | { type: 'error'; message: string };
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const uint32 = (value: unknown): value is number =>
  finite(value) && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
export function parseMessage(text: string): DeviceMessage | null {
  if (text.length > 4096) return null;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  if (
    d.type === 'sample' &&
    uint32(d.bootId) &&
    uint32(d.seq) &&
    uint32(d.ms) &&
    finite(d.raw) &&
    (d.forceN === null || finite(d.forceN))
  )
    return d as unknown as DeviceSample;
  if (
    d.type === 'status' &&
    d.protocol === 1 &&
    uint32(d.bootId) &&
    uint32(d.uptimeMs) &&
    typeof d.hostname === 'string' &&
    typeof d.ip === 'string' &&
    [
      'adcReady',
      'calibrated',
      'hasTare',
      'busy',
      'otaActive',
      'otaEnabled',
    ].every((k) => typeof d[k] === 'boolean') &&
    finite(d.sampleRateHz) &&
    d.sampleRateHz > 0 &&
    d.sampleRateHz <= 100
  )
    return d as unknown as DeviceStatus;
  if (
    d.type === 'ack' &&
    typeof d.id === 'string' &&
    typeof d.ok === 'boolean' &&
    typeof d.message === 'string'
  )
    return d as unknown as DeviceMessage;
  if (d.type === 'error' && typeof d.message === 'string')
    return d as unknown as DeviceMessage;
  return null;
}
export function deviceAddress(input: string): { ws: string; status: string } {
  const raw = input.trim();
  const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `ws://${raw}`);
  if (
    !['ws:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'Enter a .local hostname or local IPv4 address, optionally with port 81.',
    );
  }
  const host = url.hostname.toLowerCase();
  const octets = host.split('.').map(Number);
  const ipv4 =
    /^\d+\.\d+\.\d+\.\d+$/.test(host) &&
    octets.every((n) => n >= 0 && n <= 255);
  const privateIp =
    ipv4 &&
    (octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 169 && octets[1] === 254));
  if (!(
    host === 'localhost' ||
    (host.endsWith('.local') && /^[a-z0-9.-]+$/.test(host)) ||
    privateIp
  )) {
    throw new Error(
      'Use calf-dyno.local or a private LAN IPv4 address (for example 192.168.1.42).',
    );
  }
  return {
    ws: `ws://${host}:${url.port || 81}/`,
    status: `http://${host}/status`,
  };
}
export function validateRun(value: unknown): value is Run {
  if (!value || typeof value !== 'object') return false;
  const r = value as Run;
  if (
    typeof r.id !== 'string' ||
    !/^[\w-]{1,80}$/.test(r.id) ||
    typeof r.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(r.timestamp)) ||
    !['left', 'right'].includes(r.leg) ||
    typeof r.exercise !== 'string' ||
    !r.exercise.length ||
    r.exercise.length > 80 ||
    !finite(r.durationMs) ||
    r.durationMs < 0 ||
    r.durationMs > MAX_DURATION_MS ||
    !finite(r.sampleRateHz) ||
    r.sampleRateHz < 0 ||
    r.sampleRateHz > 1000 ||
    !finite(r.peakForceN) ||
    !['device', 'demo'].includes(r.source) ||
    typeof r.stopReason !== 'string' ||
    r.stopReason.length > 200 ||
    !Array.isArray(r.samples) ||
    !r.samples.length ||
    r.samples.length > MAX_SAMPLES
  )
    return false;
  if (r.geometry !== undefined && !validGeometry(r.geometry)) return false;
  if (r.bodyMassKg !== undefined && !validBodyMass(r.bodyMassKg)) return false;
  let previous = -1,
    peak = 0;
  for (const s of r.samples) {
    if (
      !Array.isArray(s) ||
      s.length !== 2 ||
      !finite(s[0]) ||
      !finite(s[1]) ||
      s[0] < 0 ||
      s[0] <= previous ||
      s[0] > r.durationMs ||
      Math.abs(s[1]) > 1e7
    )
      return false;
    previous = s[0];
    peak = Math.max(peak, s[1]);
  }
  return Math.abs(peak - r.peakForceN) < 0.001;
}
export class Recorder {
  readonly run: LocalRun;
  private last: DeviceSample;
  private startMs: number;
  constructor(
    first: DeviceSample,
    leg: Leg,
    exercise: string,
    source: Source,
    ownerUid: string | null,
    id: string,
    geometry?: LeverGeometry,
    bodyMassKg?: number,
  ) {
    if (geometry && !validGeometry(geometry))
      throw new Error('Invalid lever geometry');
    if (bodyMassKg !== undefined && !validBodyMass(bodyMassKg))
      throw new Error('Invalid body weight');
    this.startMs = first.ms;
    this.last = first;
    this.run = {
      id,
      timestamp: new Date().toISOString(),
      leg,
      exercise,
      durationMs: 0,
      sampleRateHz: 0,
      peakForceN: 0,
      samples: [],
      source,
      stopReason: '',
      state: 'recording',
      ownerUid,
    };
    if (geometry) this.run.geometry = { ...geometry };
    if (bodyMassKg !== undefined) this.run.bodyMassKg = bodyMassKg;
  }
  add(sample: DeviceSample): string | null {
    if (
      sample.forceN === null ||
      !Number.isFinite(sample.forceN) ||
      Math.abs(sample.forceN) > 1e7
    )
      return 'Invalid or uncalibrated sample';
    const forceN =
      this.run.source === 'device' && this.run.geometry
        ? footForce(sample.forceN, this.run.geometry)
        : sample.forceN;
    if (!Number.isFinite(forceN) || Math.abs(forceN) > 1e7)
      return 'Invalid calculated foot force';
    if (sample.bootId !== this.last.bootId) return 'Device restarted';
    const elapsed = (sample.ms - this.startMs) >>> 0;
    if (this.run.samples.length && (sample.seq - this.last.seq) >>> 0 !== 1)
      return 'Sample stream interrupted';
    if (elapsed > MAX_DURATION_MS || this.run.samples.length >= MAX_SAMPLES)
      return 'Recording limit reached';
    if (this.run.samples.length && elapsed <= this.run.durationMs)
      return 'Device timestamp changed';
    this.run.samples.push([elapsed, forceN]);
    this.run.durationMs = elapsed;
    this.run.peakForceN = Math.max(this.run.peakForceN, forceN);
    this.last = sample;
    if (this.run.samples.length >= MAX_SAMPLES || elapsed >= MAX_DURATION_MS)
      return 'Recording limit reached';
    return null;
  }
  finish(reason: string): LocalRun {
    this.run.stopReason = reason.slice(0, 200);
    this.run.state = 'pending';
    const samples = this.run.samples;
    const span = samples.length > 1 ? samples.at(-1)![0] - samples[0][0] : 0;
    this.run.sampleRateHz =
      span > 0 ? Math.round(((samples.length - 1) * 100_000) / span) / 100 : 0;
    return structuredClone(this.run);
  }
}
// Firestore disallows nested arrays. Use compact maps at the cloud boundary.
export function toCloud(run: Run) {
  if (!validateRun(run))
    throw new Error(
      'Run data is invalid. Export a local backup before retrying.',
    );
  const { id: _id, ...rest } = run;
  // Explicit field list avoids sending IndexedDB state/owner metadata.
  return {
    timestamp: rest.timestamp,
    leg: rest.leg,
    exercise: rest.exercise,
    durationMs: rest.durationMs,
    sampleRateHz: rest.sampleRateHz,
    peakForceN: rest.peakForceN,
    source: rest.source,
    stopReason: rest.stopReason,
    schemaVersion: rest.geometry ? 2 : 1,
    ...(rest.geometry ? { geometry: { ...rest.geometry } } : {}),
    ...(rest.bodyMassKg !== undefined ? { bodyMassKg: rest.bodyMassKg } : {}),
    samples: rest.samples.map(([t, f]) => ({ t, f })),
  };
}
export function fromCloud(id: string, data: Record<string, unknown>): Run {
  if (
    ![1, 2].includes(data.schemaVersion as number) ||
    !Array.isArray(data.samples) ||
    (data.schemaVersion === 2
      ? !validGeometry(data.geometry)
      : data.geometry !== undefined)
  )
    throw new Error('Unsupported run format');
  const run = { ...data, id, samples: data.samples.map((s) => [s?.t, s?.f]) };
  if (!validateRun(run)) throw new Error('Invalid saved run');
  return run;
}
function csvCell(value: string): string {
  // Neutralize spreadsheet formula injection when opening user-provided labels.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function runCsv(run: Run): string {
  const header =
    'run_id,timestamp,leg,exercise,source,force_basis,pivot_to_cell_in,pivot_to_dowel_in,elapsed_ms,force_n,body_mass_kg,ankle_torque_nm,ankle_torque_nm_per_kg';
  return (
    [
      header,
      ...run.samples.map(([t, f]) => {
        const torque = ankleTorque(f, run.geometry);
        return (
          [
            run.id,
            run.timestamp,
            run.leg,
            run.exercise,
            run.source,
            run.source === 'demo'
              ? 'simulated'
              : run.geometry
                ? 'foot'
                : 'cell',
          ]
            .map(csvCell)
            .join(',') +
          `,${run.geometry?.cellDistanceIn ?? ''},${run.geometry?.footDistanceIn ?? ''},${t},${f},${run.bodyMassKg ?? ''},${torque ?? ''},${torquePerKg(torque, run.bodyMassKg) ?? ''}`
        );
      }),
    ].join('\r\n') + '\r\n'
  );
}
